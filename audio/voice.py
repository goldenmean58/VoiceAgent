"""本地音频进程：唤醒、录音、识别与播报。

通过标准输入输出与 daemon 交换 JSON 行（设计见 design.md 第 11 节）。
输入命令：listen、speak、stop_playback、shutdown；输出事件见 emit 调用处。
"""
import json
import os
import queue
import re
import sys
import threading
import time

import numpy as np
import sherpa_onnx
import sounddevice as sd

SAMPLE_RATE = 16000

# 协议输出独占原始 stdout；fd 1 改指向 stderr，防止原生库的日志混入协议。
_proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
_emit_lock = threading.Lock()


def emit(event, **fields):
    with _emit_lock:
        _proto.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")


def fail(code, message):
    emit("error", code=code, message=message, fatal=True)
    sys.exit(1)


def load_models(cfg):
    try:
        with open(cfg["modelManifest"], encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        fail("bad_manifest", f"无法读取模型清单 {cfg['modelManifest']}：{e}")
    missing = [
        p
        for section in ("kws", "vad", "asr", "tts")
        for v in m[section].values()
        if isinstance(v, str)
        for p in v.split(",")
        if p.startswith("/") and not os.path.exists(p)
    ]
    if missing:
        fail("model_missing", "模型文件缺失（不会自动下载）：" + "、".join(missing))
    with open(m["kws"]["keywordsFile"], encoding="utf-8") as f:
        phrases = [line.rsplit("@", 1)[1].strip() for line in f if "@" in line]
    if cfg["wakePhrase"] not in phrases:
        fail("wake_phrase_mismatch", f"keywords 文件中没有唤醒短语「{cfg['wakePhrase']}」，现有：{phrases}")

    k, a, t = m["kws"], m["asr"], m["tts"]
    kws = sherpa_onnx.KeywordSpotter(
        tokens=k["tokens"], encoder=k["encoder"], decoder=k["decoder"], joiner=k["joiner"],
        keywords_file=k["keywordsFile"], num_threads=k["numThreads"], provider="cpu",
    )
    asr = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=a["model"], tokens=a["tokens"], num_threads=a["numThreads"], use_itn=a["useItn"],
    )
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=t["model"], voices=t["voices"], tokens=t["tokens"], data_dir=t["dataDir"], lexicon=t["lexicon"],
            ),
            num_threads=t["numThreads"],
        ),
        rule_fsts=t["ruleFsts"],
    ))
    vad_cfg = sherpa_onnx.VadModelConfig()
    vad_cfg.silero_vad.model = m["vad"]["model"]
    vad_cfg.silero_vad.min_silence_duration = cfg["endSilenceMs"] / 1000
    vad_cfg.silero_vad.max_speech_duration = cfg["maxUtteranceMs"] / 1000
    vad_cfg.sample_rate = SAMPLE_RATE
    return kws, asr, tts, vad_cfg, t


SENTENCE_END = re.compile(r"(?<=[。！？!?；;\n])")
WAKE_ACK_TEXT = "我在"
WAKE_ACK_SPEEDUP = 1.3  # 应答越短，用户越早能开口


def synthesize(tts, text, sid, speed):
    audio = tts.generate(text, sid=sid, speed=speed)
    samples = np.asarray(audio.samples, dtype=np.float32)
    if len(samples) == 0:
        raise RuntimeError(f"合成结果为空：{text}")
    # 实测 kokoro int8 对一两个字的短句在部分音色上会输出全 NaN，播放时没有声音。
    if np.isnan(samples).any():
        raise RuntimeError(f"合成结果含 NaN（音色 {sid}）：{text}")
    return samples, audio.sample_rate


def wake_ack(tts, sid, speed):
    """启动时合成一次唤醒应答并裁掉首尾静音，之后每次唤醒直接播放。"""
    samples, rate = synthesize(tts, WAKE_ACK_TEXT, sid, speed * WAKE_ACK_SPEEDUP)
    frame = int(0.01 * rate)
    rms = np.sqrt(np.mean(samples[: len(samples) // frame * frame].reshape(-1, frame) ** 2, axis=1))
    voiced = np.nonzero(rms > 0.1 * rms.max())[0]
    return samples[max(voiced[0] - 3, 0) * frame: (voiced[-1] + 4) * frame], rate


class Speaker:
    """单次只播一条；按句流水线合成，播放当前句时合成下一句。"""

    def __init__(self, tts, speaker_id, speed, guard_ms):
        self.tts, self.sid, self.speed, self.guard = tts, speaker_id, speed, guard_ms / 1000
        self.queue = queue.Queue()
        self.stop_requested = threading.Event()
        self.allowed = threading.Event()  # 录音期间清除：新回复暂存，录音结束后再播
        self.allowed.set()
        self.busy = False
        self.guard_until = 0.0
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        while True:
            speech_id, text = self.queue.get()
            self.allowed.wait()
            self.stop_requested.clear()
            self.busy = True
            try:
                state = self.play(speech_id, text)
                emit("speech", speechId=speech_id, state=state)
            except Exception as e:  # 合成或播放失败要明确报告
                emit("speech", speechId=speech_id, state="failed", message=str(e))
            finally:
                self.busy = False
                self.guard_until = time.monotonic() + self.guard

    def play(self, speech_id, text):
        sentences = [s.strip() for s in SENTENCE_END.split(text) if s.strip()] or [text]
        # 首句较长时先在第一个逗号处切开，缩短开口前的合成等待。
        first, sep, rest = sentences[0].partition("，")
        if sep and rest and len(sentences[0]) > 16 and len(first) >= 4:
            sentences[0:1] = [first + sep, rest]
        produced = queue.Queue(maxsize=2)

        def produce():
            try:
                for s in sentences:
                    if self.stop_requested.is_set():
                        break
                    produced.put(synthesize(self.tts, s, self.sid, self.speed))
            except Exception as e:
                produced.put(e)
            produced.put(None)

        threading.Thread(target=produce, daemon=True).start()
        started = False
        while True:
            try:
                audio = produced.get(timeout=0.05)
            except queue.Empty:  # 等待合成期间也要能立即停止
                if self.stop_requested.is_set():
                    return "interrupted"
                continue
            if audio is None:
                break
            if isinstance(audio, Exception):
                raise audio
            sd.play(*audio)
            if not started:
                started = True
                emit("speech", speechId=speech_id, state="playing")
            while sd.get_stream().active:
                if self.stop_requested.wait(0.05):
                    sd.stop()
                    return "interrupted"
        return "played"

    def in_guard(self):
        return self.busy or time.monotonic() < self.guard_until


class Recording:
    """一句话的录音：等待开口、句末静音结束、超长拒绝。"""

    def __init__(self, vad_cfg, wait_ms, max_ms):
        self.vad = sherpa_onnx.VoiceActivityDetector(vad_cfg, buffer_size_in_seconds=max_ms / 1000 + 5)
        self.window = vad_cfg.silero_vad.window_size
        self.wait_s, self.max_s = wait_ms / 1000, max_ms / 1000
        self.buf = np.zeros(0, dtype=np.float32)
        self.started = time.monotonic()
        self.speech_seen = False

    def feed(self, chunk):
        self.buf = np.concatenate([self.buf, chunk])
        while len(self.buf) >= self.window:
            self.vad.accept_waveform(self.buf[: self.window])
            self.buf = self.buf[self.window:]
        if self.vad.is_speech_detected():
            self.speech_seen = True
        if not self.vad.empty():
            seg = np.asarray(self.vad.front.samples, dtype=np.float32)
            self.vad.pop()
            if len(seg) >= self.max_s * SAMPLE_RATE * 0.98:
                return "rejected", "too_long"
            return "utterance", seg
        elapsed = time.monotonic() - self.started
        if not self.speech_seen and elapsed > self.wait_s:
            return "rejected", "no_speech"
        if elapsed > self.wait_s + self.max_s + 2:
            return "rejected", "too_long"
        return None


def main():
    cfg = json.loads(sys.argv[1])
    kws, asr, tts, vad_cfg, tts_params = load_models(cfg)
    speaker = Speaker(tts, tts_params["speakerId"], tts_params["speed"], cfg["playbackGuardMs"])
    try:
        ack = wake_ack(tts, tts_params["speakerId"], tts_params["speed"])
    except RuntimeError as e:
        fail("wake_ack_failed", f"唤醒应答合成失败，请换一个 speakerId：{e}")

    commands = queue.Queue()

    def read_commands():
        for line in sys.stdin:
            if line.strip():
                commands.put(json.loads(line))
        commands.put({"cmd": "shutdown"})

    threading.Thread(target=read_commands, daemon=True).start()

    chunks = queue.Queue()
    try:
        input_name = sd.query_devices(kind="input")["name"]
        stream = sd.InputStream(
            channels=1, dtype="float32", samplerate=SAMPLE_RATE, blocksize=SAMPLE_RATE // 10,
            callback=lambda data, frames, t, status: chunks.put(data[:, 0].copy()),
        )
        stream.start()
    except Exception as e:  # 没有输入设备时仍可播报，只是不能唤醒和录音
        input_name, stream = None, None
        emit("error", code="no_input_device", message=f"无法打开麦克风：{e}", fatal=False)
    try:
        output_name = sd.query_devices(kind="output")["name"]
    except Exception as e:
        fail("no_output_device", f"无法找到输出设备：{e}")
    emit("ready", input=input_name, output=output_name, wakePhrase=cfg["wakePhrase"])

    state = "armed" if stream else "no_input"
    kws_stream = kws.create_stream()
    recording = None

    def start_listening():
        nonlocal state, recording
        speaker.allowed.clear()
        speaker.stop_requested.set()
        while speaker.busy:
            time.sleep(0.02)
        sd.play(*ack)
        sd.wait()
        while not chunks.empty():  # 丢弃应答播放期间的采集
            chunks.get_nowait()
        recording = Recording(vad_cfg, cfg["waitForSpeechMs"], cfg["maxUtteranceMs"])
        state = "listening"
        emit("state", state=state)

    def back_to_armed():
        nonlocal state, recording, kws_stream
        recording = None
        kws_stream = kws.create_stream()
        state = "armed"
        speaker.allowed.set()
        emit("state", state=state)

    while True:
        try:
            cmd = commands.get(timeout=0.05) if stream is None else commands.get_nowait()
        except queue.Empty:
            cmd = None
        if cmd:
            name = cmd.get("cmd")
            if name == "shutdown":
                break
            if name == "speak":
                speaker.queue.put((cmd["speechId"], cmd["text"]))
            elif name == "stop_playback":
                speaker.stop_requested.set()
            elif name == "listen":
                if stream is None:
                    emit("error", code="no_input_device", message="没有可用的麦克风，无法录音", fatal=False)
                elif state != "listening":
                    start_listening()
            else:
                emit("error", code="unknown_command", message=f"未知命令：{name}", fatal=False)
        if stream is None:
            continue
        try:
            chunk = chunks.get(timeout=0.05)
        except queue.Empty:
            continue

        if state == "armed":
            # 半双工：播报及保护窗口内不检测唤醒词，避免把自己的口播当成指令。
            if speaker.in_guard():
                kws_stream = None
                continue
            if kws_stream is None:
                kws_stream = kws.create_stream()
            kws_stream.accept_waveform(SAMPLE_RATE, chunk)
            while kws.is_ready(kws_stream):
                kws.decode_stream(kws_stream)
                if kws.get_result(kws_stream):
                    kws.reset_stream(kws_stream)
                    emit("wake")
                    start_listening()
                    break
        elif state == "listening":
            outcome = recording.feed(chunk)
            if outcome is None:
                continue
            kind, value = outcome
            if kind == "rejected":
                emit("utterance_rejected", reason=value)
            else:
                emit("state", state="transcribing")
                t0 = time.monotonic()
                s = asr.create_stream()
                # 实测 SenseVoice 在没有前导静音时会吞掉第一个音节，补 0.3 秒静音。
                s.accept_waveform(SAMPLE_RATE, np.concatenate([np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32), value]))
                asr.decode_stream(s)
                text = s.result.text.strip()
                asr_ms = int((time.monotonic() - t0) * 1000)
                if text:
                    emit("transcript", text=text, audioMs=int(len(value) / SAMPLE_RATE * 1000), asrMs=asr_ms)
                else:
                    emit("utterance_rejected", reason="empty")
            back_to_armed()


if __name__ == "__main__":
    main()

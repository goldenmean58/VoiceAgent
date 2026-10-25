"""本地音频进程：唤醒、录音、识别与播报。

通过标准输入输出与 daemon 交换 JSON 行（设计见 design.md 第 11 节）。
输入命令：listen、speak、stop_playback、shutdown；输出事件见 emit 调用处。
"""
import json
import math
import os
import queue
import re
import sys
import threading
import time
import traceback

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
    # 两个实例：一个检测麦克风，一个在合成线程里扫描待播音频，不跨线程共用。
    kws, echo_kws = (sherpa_onnx.KeywordSpotter(
        tokens=k["tokens"], encoder=k["encoder"], decoder=k["decoder"], joiner=k["joiner"],
        keywords_file=k["keywordsFile"], num_threads=k["numThreads"], provider="cpu",
    ) for _ in range(2))
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
    return kws, echo_kws, asr, tts, vad_cfg, t


SENTENCE_END = re.compile(r"(?<=[。！？!?；;\n])")
WAKE_ACK_TEXT = "我在"
HEARD_ACK_TEXT = "收到"  # 一句话录完立即播报，不等主 agent
# 应答用固定语速，不随 ttsSpeed：实测 sid 12 在 1.95 倍时“我在”“收到”约九成输出 NaN，1.3–1.7 倍未出现。
ACK_SPEED = 1.3


def synthesize(tts, text, sid, speed):
    audio = tts.generate(text, sid=sid, speed=speed)
    samples = np.asarray(audio.samples, dtype=np.float32)
    if len(samples) == 0:
        raise RuntimeError(f"合成结果为空：{text}")
    # 实测 kokoro int8 对一两个字的短句在部分音色上会输出全 NaN，播放时没有声音。
    if np.isnan(samples).any():
        raise RuntimeError(f"合成结果含 NaN（音色 {sid}）：{text}")
    return samples, audio.sample_rate


def wake_ack(tts, sid, text=WAKE_ACK_TEXT):
    """启动时合成一次短应答并裁掉首尾静音，之后直接播放。"""
    samples, rate = synthesize(tts, text, sid, ACK_SPEED)
    frame = int(0.01 * rate)
    rms = np.sqrt(np.mean(samples[: len(samples) // frame * frame].reshape(-1, frame) ** 2, axis=1))
    voiced = np.nonzero(rms > 0.1 * rms.max())[0]
    return samples[max(voiced[0] - 3, 0) * frame: (voiced[-1] + 4) * frame], rate


def contains_wake(kws, samples, rate):
    """离线扫描一段待播音频是否会触发唤醒词。"""
    s = kws.create_stream()
    s.accept_waveform(rate, samples)
    s.accept_waveform(rate, np.zeros(rate // 2, dtype=np.float32))
    s.input_finished()
    while kws.is_ready(s):
        kws.decode_stream(s)
        if kws.get_result(s):
            return True
    return False


class Speaker:
    """单次只播一条；按句流水线合成，播放当前句时合成下一句。

    播报期间照常检测唤醒词以便打断；合成后用 echo_kws 扫描每段音频，自身含唤醒词的段在播放期间及其后
    保护窗口内暂停检测，避免外放的口播把自己唤醒。
    """

    def __init__(self, tts, echo_kws, speaker_id, speed, guard_ms):
        self.tts, self.echo_kws, self.sid, self.speed, self.guard = tts, echo_kws, speaker_id, speed, guard_ms / 1000
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

    def drop_queued(self):
        while True:
            try:
                speech_id, _ = self.queue.get_nowait()
            except queue.Empty:
                return
            emit("speech", speechId=speech_id, state="interrupted")

    def play(self, speech_id, text):
        sentences = [s.strip() for s in SENTENCE_END.split(text) if s.strip()] or [text]
        # 首句较长时先在第一个逗号处切开，缩短开口前的合成等待。
        first, sep, rest = sentences[0].partition("，")
        if sep and rest and len(sentences[0]) > 16 and len(first) >= 4:
            sentences[0:1] = [first + sep, rest]
        produced = queue.Queue(maxsize=2)

        def produce():
            tail = np.zeros(0, dtype=np.float32)  # 带上前一段结尾一起扫描，覆盖“你好，叮洛”这种被逗号切开的情况
            try:
                for s in sentences:
                    if self.stop_requested.is_set():
                        break
                    samples, rate = synthesize(self.tts, s, self.sid, self.speed)
                    has_wake = contains_wake(self.echo_kws, np.concatenate([tail, samples]), rate)
                    tail = samples[-int(1.5 * rate):]
                    produced.put((samples, rate, has_wake))
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
            samples, rate, has_wake = audio
            if has_wake:
                self.guard_until = math.inf
            sd.play(samples, rate)
            if not started:
                started = True
                emit("speech", speechId=speech_id, state="playing")
            try:
                while sd.get_stream().active:
                    if self.stop_requested.wait(0.05):
                        sd.stop()
                        return "interrupted"
            finally:
                if has_wake:
                    self.guard_until = time.monotonic() + self.guard
        return "played"

    def in_guard(self):
        return time.monotonic() < self.guard_until


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
    kws, echo_kws, asr, tts, vad_cfg, tts_params = load_models(cfg)
    speaker = Speaker(tts, echo_kws, tts_params["speakerId"], cfg["ttsSpeed"], cfg["playbackGuardMs"])
    try:
        ack = wake_ack(tts, tts_params["speakerId"])
        heard = wake_ack(tts, tts_params["speakerId"], HEARD_ACK_TEXT)
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
            # 播报期间也检测唤醒词，用于打断；只在自身含唤醒词的口播段和应答“收到”的保护窗口内暂停。
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
                    emit("wake")  # 先于 interrupted 送达，daemon 据此丢弃尚未下发的播报
                    speaker.drop_queued()
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
                # 非阻塞播放，识别与播报并行；保护窗口覆盖播放及其后的 playbackGuardMs，防止回采触发唤醒。
                sd.play(*heard)
                speaker.guard_until = max(speaker.guard_until, time.monotonic() + len(heard[0]) / heard[1] + speaker.guard)
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
                sd.wait()  # 等“收到”播完，避免录音期间暂存的回复一放行就把它截断
            back_to_armed()


if __name__ == "__main__":
    # 退出时用 os._exit 跳过解释器收尾：sounddevice 的 atexit 会关闭 PortAudio 流，若此时 Speaker 线程正在
    # sd.play/sd.stop 中关流，两者在 CoreAudio 里互相等待，进程永远卡住，父进程退出后成为孤儿。
    try:
        main()
        code = 0
    except SystemExit as e:  # fail()
        code = e.code
    except KeyboardInterrupt:
        code = 130
    except BaseException:
        traceback.print_exc()
        code = 1
    os._exit(code)

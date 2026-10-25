# VoiceAgent

在 [Herdr](https://herdr.dev) 里运行的本地语音助手：一个常驻的**主 agent**（Claude Code 或 Codex）听你说话、回答问题，并把代码工作派给一个**工作 agent**（同样是 Claude Code 或 Codex），再审核结果、用语音汇报。

唤醒、录音、识别和朗读都在本机完成（sherpa-onnx），不需要额外的 LLM API key；两个 agent 都用你已有的 CLI 登录和额度。

完整设计、状态机和验收场景见 [design.md](design.md)。

## 工作方式

```text
你 ──语音/文字──▶ 控制台 ──▶ daemon ──▶ 主 agent（Herdr pane）
                                │          │ voice-assistant tool …
                                │          ▼
                                └──────▶ 工作 agent（Herdr pane）
                                           │ Hook：开始 / 结束 / 失败
                                           ▼
                         daemon 交主 agent 审核 ──▶ 口播 + 控制台文字
```

- **daemon**（`src/main.mjs`）：唯一的状态写入者。状态保存在只追加的 journal 中，重启后可以恢复；通过 Herdr 事件订阅和原生 Hook 判断回合的开始和结束。
- **主 agent**：负责理解你的话、派发任务、审核工作结果、总结口播，通过 `voice-assistant tool <action>` 调用 daemon。
- **工作 agent**：可同时管理多个（上限由 `worker.maxManaged` 决定），各自在你允许的项目目录里干活，每个同时最多一个未结束任务。也可以接管 Herdr 里已经在运行的 Claude/Codex 会话。
- **音频进程**（`audio/voice.py`）：负责唤醒词、VAD、语音识别和语音合成，在有麦克风权限的终端里启动。

## 环境要求

- macOS（目前只在 macOS 上验证过）
- [Herdr](https://herdr.dev) 0.9.5 或更高，服务器在运行
- Node.js 24（只用标准库，不需要 `npm install`）
- Claude Code 和/或 Codex CLI，已登录
- 语音功能还需要：[uv](https://docs.astral.sh/uv/)、Python 3.14，以及一个麦克风

## 安装

### 1. 配置文件

创建 `~/.config/voice-assistant/config.json`：

```json
{
  "schemaVersion": 1,
  "backend": "herdr",
  "main": { "kind": "claude", "model": "sonnet", "effort": "medium" },
  "worker": { "defaultKind": "claude", "maxManaged": 1, "maxAutoContinue": 3 },
  "projects": { "allowedRoots": ["/absolute/path/to/your/projects"] },
  "voice": {
    "displayName": "叮洛",
    "wakePhrase": "你好叮洛",
    "modelManifest": "/Users/you/.config/voice-assistant/models/manifest.json",
    "playbackGuardMs": 300,
    "ttsSpeed": 1.2,
    "waitForSpeechMs": 5000,
    "endSilenceMs": 1200,
    "maxUtteranceMs": 30000
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `main.kind` / `worker.defaultKind` | `claude` 或 `codex` |
| `main.model` / `main.effort` | 可省略，省略时沿用 CLI 默认值。Claude 的 effort 可选 `low`/`medium`/`high`/`xhigh`/`max`；Codex 可选 `minimal`/`low`/`medium`/`high`/`xhigh` |
| `worker.maxManaged` | 同时受管的工作 agent 上限（正整数）；达到上限后启动或接管会返回 `worker_limit` |
| `worker.maxAutoContinue` | 主 agent 连续让工作 agent"继续"的次数上限，用完后只能问你或给出结论 |
| `projects.allowedRoots` | 工作 agent 只能在这些目录（含子目录）中启动或被接管 |
| `voice` | 可省略；省略时只有文字控制台 |
| `endSilenceMs` | 说话后静音多久算一句话结束 |
| `ttsSpeed` | 播报语速倍数（正数），推荐 1.2；只影响回复播报，"我在""收到"两句应答固定按 1.3 倍合成 |

配置缺失或非法时，daemon 会列出具体字段错误并拒绝启动，不会替你选一个默认值。

### 2. Hook

```bash
node src/main.mjs install-hooks
```

它会向 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 追加全局 Hook，原文件会备份为 `*.bak-voice-assistant-<时间戳>`。全局 Hook 用于接管已有会话：对未受管的会话只记录会话 ID，不记录内容。

- **Claude**：首次在项目目录中启动时，需要先在该目录里确认一次"信任此文件夹"。
- **Codex**：要在任意 Codex 会话里运行 `/hooks`，信任新加的 Hook。否则 Codex 会停在"Hooks need review"界面，daemon 也会报出这个原因。

### 3. 语音（可选）

```bash
uv venv --python 3.14 audio/.venv
uv pip install --python audio/.venv/bin/python -r audio/requirements.txt
```

下载模型到 `~/.local/share/voice-assistant/models/` 并解压（不会自动下载）：

```bash
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
curl -LO $B/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2
curl -LO $B/asr-models/silero_vad.onnx
curl -LO $B/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2
curl -LO $B/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2
```

然后准备两个文件：

- **唤醒词文件** `~/.config/voice-assistant/keywords.txt`：用 ppinyin 拆分的音素，每个音素都必须在 KWS 模型的 `tokens.txt` 中。例如：

  ```text
  n ǐ h ǎo d īng l uò @你好叮洛
  ```

- **模型清单** `~/.config/voice-assistant/models/manifest.json`：写明 `kws`、`vad`、`asr`、`tts` 各模型文件的绝对路径和参数，字段名与 `audio/voice.py` 中的 `load_models` 一致。TTS 关键参数：`speakerId`（推荐 12，原因见"已知问题"）。语速不在清单里，由 `config.json` 的 `voice.ttsSpeed` 配置。

音频进程启动时会检查清单里的文件是否存在，以及唤醒短语是否和 keywords 文件一致；缺什么就报什么，不会自动补。

## 使用

**1. 在 Herdr 的一个 pane 里启动 daemon**，它会在旁边新开一个 pane 运行主 agent：

```bash
node src/main.mjs daemon
```

如果之前的主 agent 已经丢失，daemon 会拒绝启动。确认不再需要原会话后，改用：

```bash
node src/main.mjs daemon --new-main
```

**2. 打开控制台。** 文字控制台可以在任意终端打开：

```bash
node src/main.mjs listen
```

需要语音时，**必须在 Herdr 之外**、有麦克风权限的终端里运行（例如 Ghostty 或 Terminal）：

```bash
node src/main.mjs listen --voice
```

这一步不能在 Herdr 里跑：Herdr 服务器拉起的进程拿不到 macOS 的麦克风授权，只会录到全零的静音，而且系统不会弹授权提示。

**3. 说话。**
- 用唤醒词：说"你好叮洛"，听到"我在"后说出请求，停顿 `endSilenceMs` 毫秒即结束，随后会听到"收到"。
- 用按键：在控制台直接按回车开始录一句话。

主 agent 的每条回复都会显示在控制台并朗读出来。

### 控制台命令

| 命令 | 作用 |
| --- | --- |
| 直接输入文字 | 发给主 agent |
| 直接回车 | 开始录一句话（会先停止正在播放的内容） |
| `/stop` | 停止当前播放，不影响任务 |
| `/replay` | 重播最近一条回复 |
| `/status` | 查看语音、agent、未结束任务和排队情况 |
| `/cancel <taskId>` | 取消任务 |
| `/resolve <taskId> cancelled\|failed` | 确认 uncertain 任务的结局 |
| `/dispatch <dispatchId> handled\|resubmit` | 处理投递结果不明的 dispatch |
| `/pause <agentId>` / `/resume <agentId>` | 把 agent 转为手动控制 / 恢复自动控制 |
| `/quit` | 退出控制台，daemon 和 agent 继续运行 |

## 权限与安全

- 第一版两个 agent 都以**最大权限**启动：Claude 加 `--dangerously-skip-permissions`，Codex 加 `--dangerously-bypass-approvals-and-sandbox`。只把你信任的目录放进 `allowedRoots`。
- 主 agent 只开放 Bash（`--tools Bash --strict-mcp-config`）。它可以自己做查路径、看文件这类简单查询，改代码和较长的工作交给工作 agent。
- 本助手启动的 Claude 工作 agent 加 `--disallowedTools AskUserQuestion`，需要你决定时在回复里用文本列出问题和选项，由主 agent 转问；接管的会话不改启动参数，只靠投递文本里的同一条约定。
- 工作 agent 的结果对主 agent 来说是待审核的外部数据，不能代替你授权。主 agent 判断"已完成"之前必须有证据。
- 唤醒前的音频只在本机处理；只有你说的那句话的最终转写会发给主 agent。

## 文件位置

| 路径 | 内容 |
| --- | --- |
| `~/.config/voice-assistant/` | `config.json`、`keywords.txt`、`models/manifest.json` |
| `~/.local/share/voice-assistant/models/` | 模型文件和 `SHA256SUMS` |
| `~/.local/state/voice-assistant/default/` | journal、Hook spool、结果原文、daemon socket 与锁 |

遵循 `XDG_CONFIG_HOME` / `XDG_STATE_HOME`。

## 项目结构

```text
src/main.mjs        daemon、控制台、主 agent 工具、Hook 入口
src/herdr.mjs       Herdr 后端（pane、agent、事件订阅），对业务代码不透明
audio/voice.py      音频进程：唤醒、录音、识别、播报（JSON 行协议）
prompts/main.md     主 agent 的角色提示词
design.md           设计文档与验收记录
```

## 状态

里程碑 A 到 D 已实现，已按真实场景验收：
- **A**：派发、结果审核与汇报，取消，重启恢复；
- **B**：等待用户回答、失败与 uncertain 处理；
- **C**：本地语音往返；
- **D**：Herdr 事件订阅，接管已有会话。

尚未完成：
- V07：已接管会话的原生权限弹窗；
- V16：唤醒率和误唤醒统计；
- Codex 端到端路径只做了少量验证；
- journal 快照与压缩。

## 已知问题

- kokoro int8 合成一两个字的短句时，部分音色会输出全 NaN，播出来没有声音。
  - 已改为把这种情况报告为合成失败，不再算作"已播放"；
  - sid 12 在常见短回复上没有出现，sid 3 几乎每次都出现。
- SenseVoice 偶尔把"叮洛"识别成"丁落"。
- 半双工：播报期间不检测唤醒词，要打断播报请用控制台按回车或 `/stop`。

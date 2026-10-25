# 语音主助手与编码 Agent：第一版详细设计

状态：设计稿 v1。日期：2026-10-25。本文定义待实现行为，不表示相关程序已经实现或安装。

## 1. 第一版的决定

用一个原生 Claude Code 或 Codex 会话作为主 agent，直接与用户对话。主 agent 按需要启动或接管一个编码 agent，把任务交给它；编码 agent 完成一轮或需要用户输入时，由主 agent 理解结果、作出任务判断，再用简短中文回复，由语音层播报。

Herdr 是第一版的运行后端，负责可见终端、进程启动、定向输入和运行状态。任务、会话路由、结果处理与语音不依赖 Herdr 的 pane/tab/workspace 模型。以后替换 Herdr，需要实现同一个后端契约，不需要重写这些业务逻辑。

第一版采用以下范围：

| 项目 | 决定 |
| --- | --- |
| 运行环境 | 本机 macOS，单用户、单个助手实例 |
| 主 agent | 一个常驻原生 Claude Code 或 Codex CLI 会话，由 Herdr 启动 |
| 工作 agent | 最多接管一个；支持新建，也支持接管符合条件的既有会话 |
| 工作方式 | 工作 agent 执行长任务期间，主 agent 可以继续聊天、查状态和接收后续要求 |
| 语音输入 | 可配置中文唤醒短语，另提供前台控制台按键录音；开发时先打通按键，再接唤醒 |
| 语音输出 | 主 agent 的最终短回复；第一版不增加独立摘要模型 |
| 音频处理 | 本地 KWS、VAD、STT、TTS；原生 CLI 继续使用用户已有模型配置 |
| 控制传输 | 本地 Unix socket；不引入自己的 WebSocket 或实时语音云协议 |
| 结果来源 | 原生 CLI Hook 中的最终消息；Herdr 状态只辅助判断是否可输入 |
| 权限确认 | 本助手启动的主 agent 和工作 agent 一律以最大权限运行，跳过原生审批；接管的既有会话保持其原有权限，遇到弹窗只播报提醒，不支持语音批准 |
| 后端抽象 | 只抽象 agent 的发现、启动、观察、输入、中断与状态订阅 |

第一版不包含多工作 agent 并发、远程机器、跨设备接力、Web/菜单栏应用、自动创建 worktree、实时全双工抢话、ACP 服务端，以及运行中任务跨后端热迁移。QwenAudio Agent 作为设计参考，不作为运行依赖。

## 2. 用户体验与职责

### 2.1 典型对话

```text
用户：你好叮洛，帮我让 Codex 看一下这个项目的登录问题。
主助手：我让 Codex 先定位登录失败的原因，有需要你确认的地方再问你。
工作 agent：在独立 pane 中运行，保留原生工具、上下文与权限策略。

用户：你好叮洛，你现在在做什么？
主助手：Codex 正在查登录逻辑，目前还没有最终结论。

工作 agent：最终消息询问“修复应作用于测试环境还是生产环境？”
主助手：Codex 需要确认修复范围，你希望针对测试环境还是生产环境？
用户：只处理测试环境。
主助手：已把“只处理测试环境”转给原来的 Codex 会话。

工作 agent：完成修复并报告实际验证情况。
主助手：测试环境的登录问题已修复，相关验证通过。改动还没有提交。
```

“已转达”“正在运行”“已完成”分别有独立证据，不能互相替代。工作 agent 报告失败、没有验证或仍有疑问，主助手必须保留这些事实。

### 2.2 三种角色

| 角色 | 负责 | 决策边界 |
| --- | --- | --- |
| 主 agent | 理解意图、决定是否委派、解释结果、组织口播、向用户提问 | 语义判断由它完成；执行动作必须调用受约束的本地工具 |
| 常驻进程 | 会话注册、任务状态、队列、事件持久化、定向投递、调用音频进程 | 确定性控制；不会根据自由文本自行判定任务成功或批准权限 |
| 工作 agent | 在指定项目中使用原生 CLI 完成任务并反馈 | 沿用自身工具与权限策略，最终消息交回主 agent |

语音层是输入输出设备。系统只有一个负责与人对话的主 agent。主 agent 回合结束后，不会自己继续监听；常驻进程收到新输入或工作事件，才会再次唤起它。

## 3. 总体架构

```mermaid
flowchart TD
    U[用户] -->|唤醒或按键| V[本地音频进程\nKWS / VAD / STT / TTS]
    V -->|最终转写| R[常驻进程\n任务状态 / 持久队列 / 调度]
    R -->|定向输入| B[AgentBackend 契约]
    B --> H[Herdr 实现]
    H --> M[主 agent\nClaude Code 或 Codex]
    H --> W[工作 agent（可多个）\nClaude Code 或 Codex]
    M -->|本地工具调用| R
    M -->|最终回复 Hook| R
    W -->|最终消息 Hook| R
    H -->|运行状态变化| R
    R -->|工作事件与结果| B
    R -->|主 agent 的短回复| V
    V -->|播放| U
```

其中“工作事件与结果”通过后端定向进入同一个主 agent 会话。主 agent 调用委派工具时，工具只等待提交结果，不等待整个工作完成，避免主 agent 被长任务占住。

### 3.1 进程组成

1. `voice-assistant daemon`：前台常驻控制进程，持有唯一实例锁和状态写权限。
2. `voice-assistant listen`：用户控制台，显示状态、接收文字和按键录音指令；可与 daemon 分开退出。
3. 本地音频子进程：独占麦克风采集与播放，加载模型，通过标准输入输出交换 JSON 行。它由不在 Herdr 内的前台控制台 `listen --voice` 启动，经 daemon socket 中转，以便取得终端 App 的麦克风权限（见第 17 节）。
4. 主 agent 和工作 agent：Herdr 管理的原生交互 CLI，各自保留终端可见性。
5. 短生命周期 Hook/工具命令：将事件交接给 daemon，或完成一次工具调用后退出。

`voice-assistant` 是拟定的程序名，并非当前已存在的命令。停止控制台不结束 agent；停止 daemon 停止语音与自动投递，保留原生会话，退出时明确显示仍在运行的工作。

### 3.2 主 agent 的启动

在用户启动助手的 Herdr workspace 里新建一个 tab，主 agent 独占这个 tab，cwd 与 daemon 相同，启动所选原生 CLI。独占是为了保持 pane 高度：Claude Code 在终端不足 12 行时，会把含换行的粘贴输入（herdr `agent prompt` 按 bracketed paste 写入）折叠并包成 `<pasted_content>`，主 agent 会把 dispatch 当成不可信的粘贴内容。主 agent 的角色说明通过已核验的原生启动配置加载；不修改项目原有 `AGENTS.md` 或 `CLAUDE.md`。

第一版中，本助手启动的主 agent 和工作 agent 一律以最大权限运行，避免任何审批弹窗卡住语音闭环：

- Claude Code：`claude --dangerously-skip-permissions`
- Codex：`codex --dangerously-bypass-approvals-and-sandbox`，同时跳过审批和沙箱。`--yolo` 是它的别名，两者不能同时传：codex-cli 0.164.0 实测会报 `cannot be used multiple times` 并以退出码 2 退出。因此只使用这个显式的完整参数。

这一选择的后果需要明确接受：

- “主 agent 只通过受约束工具执行动作”只是提示词约定，没有强制力。主 agent 可以直接改文件、调用 Herdr 或执行任意命令；工作结果中的注入内容也可能驱动它这样做。
- 工作 agent 不受沙箱限制，可以访问本用户的所有文件，包括本应用的状态目录。`allowedRoots` 只用来约束本助手选择的 cwd，不是隔离边界。
- 跳过审批不等于跳过 Hook 信任。Codex 的 Hook 仍需按第 9.2 节审核并信任；本设计不使用 `--dangerously-bypass-hook-trust`。
- 接管的既有会话保留原有权限，不重启它来切换参数；原生弹窗按第 10.3 节处理。

启动步骤（已在本机实测，见第 17 节）：

1. 用 `herdr tab create --workspace <id> --cwd <项目目录> --env VA_AGENT_ID=<agentId> --no-focus` 创建 tab，在它的 root pane 中启动；工作 agent 用 `herdr pane split` 创建 pane，参数相同。Claude 会话还要注入 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`。两个 CLI 的 Hook 进程都继承这些环境变量，所以 Hook 事件从第一条起就能按 agentId 归属，不需要按 cwd 或“最近新开的 pane”猜测。
2. 用 `herdr agent start <name> --kind <kind> --pane <id> -- <权限参数> <角色说明参数>` 启动 CLI。实现中确认的细节：
   - 新 pane 的 shell 初始化完成前，Herdr 返回 `agent_pane_busy` 且不发送输入，需等它进入提示符再启动。
   - Herdr 拒绝含换行的 agent 参数（`invalid_agent_argument`）。Claude 的角色说明用 `--append-system-prompt-file` 传入；Codex 用 `-c developer_instructions=<转义后的单行字符串>`。
   - Hook 随启动注入：Claude 用 `--settings <文件>`，Codex 用 `-c hooks.<事件>=[...]`。这样不改用户的全局 Hook 配置，只有本助手启动的会话会触发。Codex 的信任按命令哈希记录，命令路径不变，信任就一直有效。
   - Claude 用 `--session-id <uuid>` 预先指定原生会话 ID。
3. 启动前做两项预检，任一项不满足就报告原因，不启动：
   - Claude：目标目录已被信任。未信任时，即使带 `--dangerously-skip-permissions` 也会先弹出目录信任确认，Herdr 报 blocked 和 `agent_not_ready`。
   - Codex：本应用的 Hook 已经信任，即 `config.toml` 的 `hooks.state` 里有与当前 Hook 哈希一致的记录。未信任时，Codex 启动后先显示 Hook 审核界面，而 Herdr 把这个状态报成 idle，`agent start` 照样返回成功；此时投递的输入会落进审核界面。
4. 就绪判定：
   - Claude：收到带匹配 `VA_AGENT_ID` 的 SessionStart 后绑定 nativeSessionId，宣布就绪。
   - Codex：只在第一次提交输入时触发 SessionStart，Herdr 也在那时才报告会话 ID。因此 Herdr 报告就绪且预检通过即可视为就绪；nativeSessionId 在第一轮的 UserPromptSubmit 中绑定，绑定之前的身份核对见第 4.3 节第 3 条。

关闭后台任务的代价：Bash 命令超时后不会转入后台，而是直接结束；默认超时为 2 分钟，模型最多可设到 10 分钟。需要更长运行时间的项目，通过 `BASH_DEFAULT_TIMEOUT_MS` 或 `BASH_MAX_TIMEOUT_MS` 调整。MCP tasks 和 Monitor 工具不受这个变量控制，仍可能在后台运行，残留情况按第 9.3 节第 6 条处理。[Claude Code 环境变量](https://code.claude.com/docs/en/env-vars)

工作 agent 按需创建为 daemon 所在 tab 的另一个 pane，不进入主 agent 的 tab：第一个在 daemon 右侧，之后接在最近启动的工作 agent 下方。继承明确的项目目录，创建时保留用户焦点。除主 agent 的 tab 外，不自动创建 workspace、tab 或 worktree。

## 4. 数据模型与不变量

以下为拟定的应用数据结构，不是 Herdr 或原生 CLI 的 API。

### 4.1 标识

| 标识 | 用途 | 生命周期 |
| --- | --- | --- |
| `conversationId` | 一个人机对话上下文 | 助手会话内稳定 |
| `agentId` | 应用内的主/工作 agent 身份 | 绑定一个已核验的原生会话，不随 UI 布局变化 |
| `nativeSessionId` | Claude/Codex 原生会话身份 | 原生 CLI 提供，用于关联 Hook |
| `generation` | 同一注册对象的绑定代次 | 原生进程或会话被替换时递增，旧代不能继续接收命令 |
| `taskId` | 一项用户委派工作的身份 | 可以包含多轮追问和补充 |
| `submissionId` | 向某个 agent 提交的一轮输入 | 每次投递单独创建 |
| `requestId` | 一个待回答问题的身份 | 回答、撤销或失效后不再使用 |
| `eventId` | 事件去重标识 | 一经生成不变 |
| `dispatchId` | 主 agent 处理一次队列项的身份 | 关联输入、工具动作与最终回复 |
| `operationId` | 工具动作的幂等键 | 同一动作重查/重复调用返回已有结果 |

应用 ID 使用随机 UUID；人类可读名称仅用于展示。pane ID、Herdr alias 和 socket 路径属于后端私有绑定，不作为 `agentId`、任务主键或用户回复目标。

### 4.2 核心记录

```typescript
type TaskState =
  | "dispatching" | "running" | "reviewing"
  | "waiting_user" | "waiting_terminal" | "cancelling"
  | "completed" | "failed" | "cancelled" | "uncertain";

type AgentRecord = {
  agentId: string;
  role: "main" | "worker";
  kind: "claude" | "codex";
  nativeSessionId: string | null; // Codex 在第一轮输入前为 null，见第 3.2 节
  generation: number;
  cwd: string;
  control: "managed" | "paused";
  activity: "ready" | "working" | "blocked" | "unknown" | "exited";
  activeSubmissionId: string | null;
  backendRef: string; // 不透明引用，业务代码不解读其中内容
};

type TaskRecord = {
  taskId: string;
  conversationId: string;
  originMessageId: string;
  dispatchId: string; // 建任务的主 agent dispatch
  workerAgentId: string;
  title: string;
  state: TaskState;
  revision: number;
  activeSubmissionId: string | null;
  pendingRequestId: string | null;
  latestResultEventId: string | null;
  autoContinueCount: number; // 自上次用户输入以来连续 continue 的次数
  uncertainReason:
    | "result_missing" | "delivery_unknown" | "session_lost"
    | "external_input" | "cancel_unconfirmed" | "terminal_unresolved"
    | null;
};

type InputRequest = {
  requestId: string;
  taskId: string;
  generation: number;
  type: "question" | "terminal_action";
  question: string;
  sourceEventId: string;
  state: "open" | "answered" | "withdrawn";
};
```

`paused` 是自动控制权的状态，不代表原生进程已暂停执行。任务、输入投递和音频播放分别记录状态，不用一个 `busy` 字段混在一起。

TaskRecord 的 state、activeSubmissionId、pendingRequestId、latestResultEventId 或待发送补充队列发生任何变化，revision 都加 1。`expectedRevision` 与“同一 revision 只决定一次”都以这个定义为准。`uncertainReason` 只在 state 为 `uncertain` 时非空。

### 4.3 必须保持的不变量

1. 一个主 agent、最多 `worker.maxManaged` 个受管工作 agent；一个工作 agent 同时最多有一个未结束的任务。
2. 同一 agent 同时最多有一个自动投递中的回合；主 agent 忙时只排队。
3. 每次发送前核对 native session、generation、控制权和当前状态；Codex 首轮尚无 native session 时，改为核对 agentId 环境标记绑定的 pane 占用者未变。
4. 主 agent 的最终回复才进入 TTS。工作结果必须先交主 agent 处理。
5. Herdr 的就绪状态不代表任务成功，原生回合结束也不代表业务任务完成。
6. 发送结果不确定时不自动重发；中断按键已写入不等于任务已取消。
7. 普通问题回答与原生权限操作分开处理；“好的”不会自动转成权限批准。
8. 主 agent、工作 agent 的 Hook 按角色分流，主 agent 的 Stop 不产生新的工作完成通知。

## 5. Herdr 的可替换边界

### 5.1 最小后端契约

业务只调用下面七个操作。第一版允许它只有 Herdr 一个实现，因为“可替换 Herdr”是明确需求；不再为音频、模型或存储扩展一套插件框架。

```typescript
interface AgentBackend {
  discover(): Promise<AgentCandidate[]>;
  start(spec: StartSpec): Promise<AgentBinding>;
  inspect(binding: AgentBinding): Promise<AgentObservation>;
  submit(input: SubmitInput): Promise<DeliveryReceipt>;
  cancel(input: CancelInput): Promise<CancelReceipt>;
  close(binding: AgentBinding): Promise<CloseReceipt>;
  subscribe(onChange: (event: BackendChange) => void): Promise<() => void>;
}

type StartSpec = {
  agentId: string;
  role: "main" | "worker";
  kind: "claude" | "codex";
  cwd: string;
};

type AgentBinding = {
  backendRef: string;
  kind: "claude" | "codex";
  nativeSessionId: string | null;
  generation: number;
};

type AgentCandidate = {
  candidateRef: string;
  kind: "claude" | "codex";
  nativeSessionId: string | null;
  cwd: string;
  activity: AgentRecord["activity"];
  capabilities: {
    nativeSessionIdentity: boolean;
    finalMessageHook: boolean;
    interruptTurn: boolean;
  };
};

type AgentObservation = {
  nativeSessionId: string | null;
  activity: AgentRecord["activity"];
  identityMatches: boolean;
  observedAt: string;
};

type BackendChange = {
  backendRef: string | null;
  reason: "activity" | "exited" | "identity_changed" | "resync_required";
};

type SubmitInput = {
  binding: AgentBinding;
  expectedNativeSessionId: string | null; // 仅 Codex 首轮允许为 null
  expectedGeneration: number;
  submissionId: string;
  text: string;
};

type CancelInput = Omit<SubmitInput, "text">;

type DeliveryReceipt = {
  submissionId: string;
  status: "written" | "rejected" | "unknown";
  reason?: string;
};

type CancelReceipt = {
  status: "requested" | "unsupported" | "unknown";
  reason?: string;
};

// 对象已不存在或已被其他终端占用时视为已关闭，不关闭别人的 pane。
type CloseReceipt = { ok: true } | { ok: false; reason: string };
```

`AgentCandidate` 只暴露 kind、cwd、native session、activity、可供接管的 opaque reference，以及可用能力。`AgentObservation` 返回当前身份、状态和观察时间。布局、终端按键、Herdr 请求字段都留在实现内。

Herdr 的 `agent prompt` 也接受 working 状态的 agent，成功响应只表示输入进入队列，不表示已经执行；带 wait 时超时也不能证明输入未发送。因此“仅在 ready 时提交”的检查由应用在调用前完成，不依赖 Herdr 拒绝。[Herdr agent automation](https://herdr.dev/docs/agent-automation/)

`written` 仅表示输入写入被确认；后续观察到回合活动或取得能够唯一关联的回合结束证据，才能升级为 `observed`。UserPromptSubmit 只提供输入边界，其他 Hook 仍可能拒绝输入，不能单凭它宣称模型已开始执行。后端不返回名为 `success` 的任务结果。

能力检查至少包含 `nativeSessionIdentity`、`finalMessageHook` 和 `interruptTurn`。前两项缺失就不能接管为可语音闭环的 agent；中断不可用必须明确返回，不能用关闭 pane 冒充取消。

### 5.2 Herdr 操作映射

| 应用操作 | Herdr 实现职责 |
| --- | --- |
| `discover` | 发现当前服务器中的 agent，整理 native session 和状态 |
| `start` | 分配可用 shell pane，再启动指定 kind；处理布局与焦点 |
| `inspect` | 查询绑定对象，确认仍为原来的 CLI/native session |
| `submit` | 通过 agent 输入接口定向提交文本；不使用 shell 命令模拟 prompt |
| `cancel` | 按已核验的 CLI 行为中断当前回合，并随后观察是否真正停止 |
| `close` | 确认 pane 仍是原来的终端后用 `herdr pane close` 关闭；pane 已不存在时视为已关闭 |
| `subscribe` | 订阅状态/退出/替换事件，转为应用的变化通知 |

Herdr 区分布局、原始 pane 和被识别的 agent；启动 agent 需要一个已有 shell pane，创建后应使用返回的 ID。第一版据此把布局放在后端内部。[Herdr agent automation](https://herdr.dev/docs/agent-automation/)

短请求使用现有 Herdr CLI；常驻事件订阅使用其 Unix socket。里程碑 A 先用每秒一次的 inspect 轮询代替事件订阅，socket 订阅在里程碑 D 中与断线恢复一起实现。调用 CLI 用参数数组启动进程，不经过 shell 拼接。协议与字段以目标安装版 schema 为准，初始化检查客户端/服务端兼容性，不自动升级或重启 Herdr。[Herdr Socket API](https://herdr.dev/docs/socket-api/)

不使用阻塞到整项工作结束的 prompt/wait 调用占住主 agent 工具。Herdr 的 wait 反映运行状态，不能精确标识本次业务任务；可用的 completion_seq 也只辅助观察，不能代替 taskId 或原生回合关联。实测表明，回合被中断后 Herdr 同样报告 done，completion_seq 也同样递增，与正常完成无法区分。

Herdr 的状态分类也有盲区：实测中 Codex 的 Hook 审核界面被报告为 idle。因此 Herdr 的 idle 或 done 只能作为“可能可以输入”的信号，就绪判定还需要第 3.2 节的预检和 Hook 证据。

### 5.3 接管既有 agent

发现不等于接管。接管必须由用户明确指定目标，完成以下检查：

1. 唯一解析目标，读取真实 cwd、kind、native session 和当前活动状态。
2. 验证 Hook 已加载，且 daemon 能收到该会话的事件。不能假设运行中的进程已经加载新配置：Claude Code 通常通过文件监视自动读取 Hook 改动；Codex 中新增或改动的 Hook 按哈希记录信任，审核信任之前会被跳过。一律以实际收到该会话的事件为准。
3. 目标空闲且没有未解决的原生弹窗；正在执行用户任务的会话先保持只读。
4. 注册 logical agentId 和 generation，明确后续自动输入由本助手负责。

缺少 Hook 或 native session 时显示具体原因，可列出会话，不能宣称已完成接管。用户自行完成必要配置或重新启动目标后再检查；不自动重启、覆盖其配置或截取屏幕文本替代最终消息。

Herdr 的 Claude/Codex 集成可报告原生会话引用，但不能据此假设所有状态都来自语义事件。本文分别使用原生 Hook 获取消息、使用 Herdr 观察运行状态。[Herdr integrations](https://herdr.dev/docs/integrations/)

### 5.4 如何换掉 Herdr

后续实现一个直接托管原生协议或进程的后端，提供相同的身份、定向输入、最终消息与状态能力。应用核心不读取 `HERDR_*`、pane ID 或 alias；这些仅存在于 `herdr.mjs`、后端私有状态与初始化诊断中。原生 Hook 按 kind/native session 关联，不依赖 pane 名称。

切换流程是：停止新委派 → 结束或明确中断当前任务 → 停止旧后端的自动输入 → 切换配置 → 启动或明确接管新会话。保留历史任务和结果；旧会话不自动关闭。

“随时能换”指实现和数据边界可替换，不承诺把正在运行的终端进程迁进另一个后端。新后端若要恢复原生历史，必须自行证明支持该 CLI 的会话恢复。

## 6. 主 agent 的工具与提示约定

### 6.1 工具入口

第一版使用一个中立的本地 CLI，不先引入 MCP 服务。主 agent 通过现有 shell 工具调用 `voice-assistant tool <action>`，JSON 从 stdin 输入，结构化结果从 stdout 输出，诊断写 stderr。请求文本不拼入 shell 命令。

| action | 主要输入 | 行为 |
| --- | --- | --- |
| `agents.list` | 无 | 列出受管与可接管对象，不改变控制权 |
| `agents.start` | kind、cwd、显示名 | 启动工作 agent；已有受管工作对象时拒绝再建一个 |
| `agents.adopt` | candidateRef | 按第 5.3 节检查并接管 |
| `agents.release` | agentId，可选 closePane | 空闲且无未结束任务时解除工作 agent 的自动管理；默认保留原生会话，closePane 为 true 时同时关闭其 pane |
| `tasks.submit` | agentId、originMessageId、任务文本 | 创建任务并投递首轮输入 |
| `tasks.send` | taskId、expectedRevision、补充文本 | 在同一任务/会话中继续；忙时保存待发送输入 |
| `tasks.get` | taskId；可选结果读取范围 | 返回确定状态、待处理问题和原始结果内容 |
| `tasks.decide` | taskId、expectedRevision、sourceEventId、decision | 基于结果完成语义分类 |
| `tasks.reply` | requestId、expectedRevision、回答 | 消费普通问题，并送回原任务的原会话 |
| `tasks.cancel` | taskId、expectedRevision | 清除尚未发送的补充并请求中断当前回合 |
| `agents.pause/resume` | agentId | 转入手动控制，或核验身份和状态后恢复自动控制 |

所有有副作用的请求带 `dispatchId` 和 `operationId`。daemon 只接受“当前在途的主 agent dispatch”的 dispatchId：该 dispatch 已投递、尚未结束，且主 agent 当前处于活动状态。其他请求一律以 `not_active_dispatch` 拒绝。dispatchId 只写在主会话输入中，不写进投递给工作 agent 的文本，避免工作 agent 调用工具替自己作出判断。

worker、主 agent 与 daemon 以同一系统用户运行，同一用户的进程可以读取状态目录和 socket。因此这一校验只能防止误调用和顺手调用，不构成对抗性隔离。第一版把这一点作为已知限制写明。同一幂等键参数不同返回冲突；revision 不匹配返回最新状态，不替调用者猜测意图。`tasks.submit` 也校验 originMessageId：同一轮 dispatch 内，一条用户消息可以建多个任务，分别派给不同的工作 agent（每个工作 agent 同时最多一个未结束任务）；同一条消息被重新投递后的新一轮不能再建，避免重复建任务。

结果事件携带元数据和 resultRef，主 agent 通过 tasks.get 读取完整原文。长结果按显式 offset/limit 分段，返回 totalChars、nextOffset 和是否读完；不会把截断内容伪装为完整结果，也不将整份长文本无界塞入主会话。任务判断必须读取支撑该结论的原文与限制。

工具不向主 agent 暴露任意 `send-keys`、shell pane 控制或原生权限批准接口。主 agent 以最大权限运行（第 3.2 节），不直接调用 Herdr、不直接改代码只是提示词约定，没有强制力。工作 agent 的普通原生工具仍由其自身权限策略管理。

主 agent 工具只能启动、接管、释放或暂停工作 agent；主会话的启动和控制属于 daemon/用户控制台。释放时保留历史关联，默认不关闭 pane；之后可接管或启动另一个工作会话，同一时刻受管数量不超过 worker.maxManaged。

释放后的 pane 会一直留在 daemon 所在的 tab，越积越多，所以 `agents.release` 可带 `closePane: true` 同时关闭 pane。关闭会结束其中的 CLI 进程，不可逆（原生会话历史仍在磁盘上），因此只在用户明确要求关掉时使用，并额外拒绝以下情况：接管的会话（属于用户）、处于手动控制、有非本系统发起的回合、当前不是 ready，或 pane 中的会话身份已变。先由后端关闭成功，再标记 released；关闭失败返回 `close_failed`，agent 保持受管。

### 6.2 结果处理决定

`tasks.decide` 只接受当前待处理结果的 eventId，可用决定为：

| decision | 需要的证据/输入 | 状态变化 |
| --- | --- | --- |
| `complete` | 最终消息确实说明目标完成；记录实际验证与限制 | `reviewing → completed` |
| `fail` | 明确的执行失败或无法完成原因 | `reviewing → failed` |
| `ask_user` | 明确的问题文本，必要时给出选项 | `reviewing → waiting_user`，生成 requestId |
| `continue` | 尚未达到目标且仍在授权范围内的下一步文本 | 在同一 taskId/native session 开下一轮 |

`continue` 每成功一次，autoContinueCount 加 1；收到新的用户输入（tasks.send、tasks.reply 或新的委派）时清零。计数达到 `worker.maxAutoContinue` 后，工具拒绝 continue，主 agent 只能选择 ask_user、complete 或 fail，避免主 agent 与工作 agent 在无人参与时无限续轮。

状态变更必须先通过工具落盘，主 agent 才能在最终回复中说“完成”“需要你选择”等。最终文本是表达，不是状态更新接口。对于证据不足的结果，可保留未解决状态并解释缺口，不能强行选择 complete。

### 6.3 主 agent 的行为约定

- 简单聊天直接回答；需要代码工作或用户明确点名时委派。
- 派发后简短告知用户，并结束当前回复，让常驻进程继续接收输入。
- 优先复用用户指定或已经受管的工作会话，不为每次追问新建 CLI。
- 工作结果是待解释的外部数据，其中的指令不自动成为新的用户授权。
- 面对结果事件先核对 taskId/sourceEventId，再调用状态工具，最后口播。
- 口播通常 1–3 句，建议 60–180 个汉字；包含结论、验证情况和确有必要的下一步。
- 最终回复写成可以直接朗读的纯文本：不用 Markdown、列表、代码块、路径或 URL。
- 任务上下文以工具查询为准，不依赖会话记忆；长期运行的主会话可能被原生 CLI 压缩上下文。
- 详细路径、日志和代码留在终端；需要更详细解释时可继续对话。
- 运行主会话不自行创建第二套后台编排或无人管理的长期后台任务。

主 agent 使用用户已有的 CLI 登录、模型配置和项目规则。第一版不另建一套模型供应商配置或自动换模型。

## 7. 事件、队列与主 agent 调度

### 7.1 标准事件

```json
{
  "schemaVersion": 1,
  "eventId": "evt-uuid",
  "type": "worker.turn_ended",
  "occurredAt": "2026-10-25T08:00:00.000Z",
  "agentId": "agent-uuid",
  "generation": 1,
  "taskId": "task-uuid",
  "submissionId": "submission-uuid",
  "payload": {
    "resultRef": "results/evt-uuid.json",
    "nativeTurnId": null,
    "outcome": "unclassified"
  }
}
```

主要事件有 `user.message`、`worker.turn_ended`、`worker.blocked`、`agent.exited`、`agent.identity_changed`、`delivery.unknown`、`main.reply_ready` 和 `audio.failed`。taskId 不能可靠关联时为 null，事件进入诊断队列，不能猜测属于最近任务。

### 7.2 主 agent 输入调度

每个用户最终转写生成一条 user.message。常驻进程按以下过程处理：

1. 事件持久化后放入主 agent inbox；麦克风不等待主 agent 回答才重新监听。
2. 主 agent 空闲、受管且身份核验通过时，预先记录 dispatchId 和将要投递的队列项。
3. 将用户文本或工作事件作为明确标注来源的输入，提交给同一个主会话。工作事件的输入自带 dispatchId、taskId、任务标题、当前状态、revision 和开放的 requestId，主 agent 即使已经压缩上下文也能接着处理。
4. 投递确认只更新发送状态；观察到回合活动后记录 observed。
5. 收到主 agent 最终消息并确认该回合已结束，完成 dispatch，并创建待播报项。
6. 下一项独立处理，不把多个无关用户要求拼成一段含糊输入。

主 agent 忙时不向终端强行注入新输入。工作完成/提问等事件排队；同一任务的普通状态变化合并，只保留最新观察值。用户指令保持接收顺序，控制台明确显示“已收到，等待主助手处理”。

人工“停止播放”直接由 daemon 处理，不经过主 agent。用户在控制台明确点击/输入“取消任务”也可直接进入确定性的取消流程；自然语言取消由主 agent 解析后调用同一个任务工具。

### 7.3 工作 agent 输入调度

- `tasks.submit` 在 agent ready、无活跃任务时创建首轮输入。
- `tasks.send` 遇到 working，只保存待发送项并报告“已排队”；不会声称已经转达。
- 工作回合结束后，先由主 agent 解释结果。任务仍应继续时，才按顺序投递补充。
- 待回答问题出现时，暂停普通补充；先让用户明确回答，或撤销问题后重新指定任务。
- 任务完成、失败或取消时，剩余未发送补充不自动执行，向主 agent 显示待重新确认内容。
- 默认只支持 ready 状态下开始下一轮，不依赖原生 CLI 的运行中 steering/queue 特性。

### 7.4 防止循环与重复

主 agent 的 Stop 只结束当前 dispatch 并触发语音，不投递成 worker.turn_ended。音频播放完成也不唤起主 agent。

工作结果重复投递先按 eventId 和原生回合关联去重；同一 task revision 的结果只允许被决定一次。主 agent 若在结果处理回合没有执行必要的 tasks.decide 就结束，保留 reviewing 并显示“结果尚未归类”，不无限自动重问。

主 agent 调用工具的具体动作已落盘，重复查询可以恢复既有结果。主 agent 输入是否已生效不确定时，挂起该 dispatch，展示恢复选项，不在重启后自动重跑一遍。

## 8. 任务与投递状态机

### 8.1 任务状态

```mermaid
stateDiagram-v2
    [*] --> dispatching
    dispatching --> running: 确认回合开始
    dispatching --> failed: 明确拒绝或启动失败
    dispatching --> uncertain: 投递结果不明
    running --> reviewing: 最终消息已关联且回合结束
    running --> waiting_terminal: 原生阻塞交互
    running --> uncertain: 会话丢失或结果缺失
    reviewing --> completed: 主 agent 确认完成
    reviewing --> failed: 主 agent 确认失败
    reviewing --> waiting_user: 主 agent 提出普通问题
    reviewing --> dispatching: 在授权范围内继续
    waiting_user --> dispatching: 正确 requestId 的回答
    waiting_terminal --> running: 人工处理后确认仍在执行
    waiting_terminal --> reviewing: 人工处理后回合结束
    waiting_terminal --> uncertain: 无法确认处理结果
    running --> cancelling: 明确取消
    dispatching --> cancelling: 明确取消
    waiting_user --> cancelled: 无运行回合且撤销任务
    reviewing --> cancelled: 不再继续该任务
    waiting_terminal --> cancelling: 明确取消
    cancelling --> cancelled: 确认回合停止
    cancelling --> uncertain: 不能确认已停止
    uncertain --> running: 重新核验确认原回合仍在执行
    uncertain --> reviewing: 补齐可唯一关联的最终消息且回合已结束
    uncertain --> cancelled: 用户确认回合已停止并放弃
    uncertain --> failed: 用户确认会话丢失或无法继续
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

`uncertain` 是需要重新核验或人工处理的非终态，不自动重发、不自动开始新任务。它占用 worker，因此必须有明确的出口：

- 证据型出口由 daemon 自动执行。重新 inspect 时身份一致且观察到原回合仍在运行，转为 `running`；之后取得可唯一关联的最终消息且回合已经结束，转为 `reviewing`。
- 判断型出口只能由用户在控制台执行 `voice-assistant resolve <taskId> cancelled|failed` 完成。控制台先展示 uncertainReason、最近的观察和诊断，再记录用户的确认。主 agent 工具不提供这个动作，避免由模型推测来消除不确定性。

主 agent 的 dispatch 处于 unknown 时同样处理：控制台提供“标记为已处理，不重投”和“由用户明确重新提交”两个选项，不自动重跑。

已经完成的任务收到新的相关要求，建立新的 taskId 并可复用同一个 worker；尚未完成的目标补充条件，保留 taskId。两者由主 agent 根据当前任务与用户意图区分。

### 8.2 输入投递状态

```text
prepared → written → observed → turn_ended
    ├→ rejected：明确没有接受本次输入，显示原因
    └→ unknown：可能已经生效，禁止自动重投
```

当写入已经成功，但回合启动或结束未被确认，也可能转入 unknown。超时不代表输入未送达。每轮记录提交前的运行观察值、native session、generation、提交后的活动证据和最终消息引用。短回合可能没有被轮询观察到 working；若匹配的原生输入边界、最终消息和结束观察足以唯一确认这一轮，可补记 observed，不要求人为延长回合。

### 8.3 “结束”的含义

| 信号 | 可以得出的结论 | 不能得出的结论 |
| --- | --- | --- |
| Herdr ready/idle/done | 当前看起来可以接收新输入 | 编码目标已经完成、验证通过 |
| Herdr blocked | 存在需要处理的原生交互 | 一定是普通问题，或一定是权限批准 |
| Stop Hook | 原生 CLI 提供了一份回合末消息候选 | 其他 Stop Hook 不会继续该会话 |
| 匹配消息 + 回合结束观察 | 可以交主 agent 审阅这一轮结果 | 业务任务自动完成 |
| 主 agent 的 tasks.decide | 记录有依据的业务判断 | 未执行过的验证已经通过 |

## 9. Hook 与最终消息采集

### 9.1 Hook 的唯一职责

Hook 读取 stdin 中的原生 JSON，补充事件身份，写入本地持久 inbox，然后立即返回。不做摘要、不等待主 agent、不录音、不生成或播放音频，也不通过 Stop block 建立语音循环。

正常路径采用很短的同步交接：将完整事件原子写入 spool 并确认落盘后退出，耗时目标在本机正常磁盘条件下低于 100ms。daemon 暂停时仍可交接，后续再消费。写入失败必须返回错误并保留 stderr 诊断，不能报告交接成功。

本助手启动的会话，Hook 随启动参数注入，只在这些会话中触发（第 3.2 节）。接管既有会话（里程碑 D）时，Hook 需要在用户级配置中生效，会对本机所有 Claude/Codex 会话触发，因此按会话是否受管分别处理：

- 受管或正在启动、接管的会话：写入完整事件。正在启动的会话通过 start 时注入的环境变量标记识别（Hook 进程继承父进程环境）；已受管的会话通过 daemon 维护的已绑定 session 列表识别。
- 其他会话：只写最小元数据（kind、session_id、事件名、时间），用于确认 Hook 已加载和发现候选，不写 prompt 或最终消息正文。daemon 定期清理不能关联的元数据。

stdout 遵守原生 Hook 协议：Stop 成功只返回合法中立 JSON，例如 `{}`；不打印日志和要播报的内容。保留用户和 Herdr 既有 Hook，不覆盖；若已有 Hook 会持续阻止 Stop 或启动另一个语音循环，初始化报告冲突，交由用户调整。

### 9.2 原生字段与标准化

| 来源 | 第一版使用的字段/事件 | 注意事项 |
| --- | --- | --- |
| Codex | SessionStart、UserPromptSubmit、Stop、Interrupt；session_id、turn_id、prompt、stop_hook_active、last_assistant_message | 最终消息可能为 null；SessionStart 到第一次提交输入时才触发；Interrupt 只在主线程活动回合被中断时触发，且中断时不触发 Stop |
| Claude Code | SessionStart、UserPromptSubmit、Stop、StopFailure；session_id、prompt_id、prompt、stop_hook_active、last_assistant_message、background_tasks | prompt_id 在首次用户输入前缺失；用户中断不触发 Stop，也没有对应的中断 Hook |
| 两者 | 缺失的错误/中断事件 | 通过后端状态观察与明确诊断处理，不伪造事件 |

Codex 的 Stop 带 turn_id、stop_hook_active 和可空的 last_assistant_message；UserPromptSubmit 带 turn_id 和 prompt；另有 Interrupt 事件。非托管 Hook 必须先审核信任，信任按 Hook 当前的哈希记录，改动后需要重新信任。安装完成不等于已经获得运行信任，初始化必须检查实际执行情况。[OpenAI Docs：Hooks](https://learn.chatgpt.com/docs/hooks)

Claude Code 的 Stop 带 last_assistant_message、stop_hook_active 和 background_tasks。用户中断时不触发 Stop；API 错误触发 StopFailure，而不是 Stop。所有事件都带公共字段 prompt_id，用于标识当前处理的那条 prompt。UserPromptSubmit 除了在用户输入时触发，也会在会话内定时任务、后台子 agent 回报和其他会话发来的消息上触发。[Claude Code Hooks](https://code.claude.com/docs/en/hooks)

### 9.3 结果关联规则

1. 只处理受管原生会话的根回合事件，不把 SubagentStop 当成独立工作结果。
2. 先匹配 kind/native session，再核对 generation 和当前未结束 submission。
3. Codex 使用 turn_id 关联 UserPromptSubmit 与 Stop；Claude 使用 prompt_id 关联二者，并结合单个在途 submission 核对。不能只用最终文本哈希去重，否则同样的回答会误删。
4. 原始 Hook 事件自带 eventId，重投同一 spool 文件保持该 ID。一次 submission 出现多份冲突 Stop 候选时先保留，核对继续执行边界，不任意取第一份。
5. 只有最终消息非空、输入对应关系明确、后端观察到回合已结束，才发出 worker.turn_ended。
6. 外部 Stop Hook 导致继续时（stop_hook_active 为 true 的后续 Stop 属于同一回合），继续等待，不提前宣告结束。
   - Claude 会话已注入 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，常见的后台 Bash 和 subagent 已被关闭。
   - 若 Stop 中 background_tasks 仍然非空（MCP tasks 或 Monitor），该 submission 保持 running。之后一轮由 CLI 自行发起：UserPromptSubmit 的 prompt 是 `<task-notification>`，其中的 task-id 出现在上一份 background_tasks 里。这一轮和它的 Stop 都归入同一个 submission，直到某份 Stop 的 background_tasks 为空，才视为回合结束。
   - 实测中未关闭后台任务的 Claude 会把 `sleep 40` 放到后台：第一份 Stop 的消息是“还没结束”，真正的结果出现在新 prompt_id 的下一轮。
7. 最终消息缺失或无法唯一关联，进入 result_missing/uncertain，保留诊断；终端内容仅供排查，不作为完整最终消息冒充结果。

SessionStart 可能先于 start 操作返回（Claude），也可能直到第一轮输入才出现（Codex）。两种情况都按事件中的 `VA_AGENT_ID` 环境标记归属到 agentId，再记录 native session；没有环境标记的事件只按已绑定的 session 列表匹配，不能按 cwd 或“最近新开的 pane”猜测对象。

### 9.4 手动输入与控制权

每次自动提交前持久化一条预期输入。原生 UserPromptSubmit 若与预期文本、session 或当前 submission 不匹配，视为非本系统发起的回合。来源可能是手动输入，也可能是 CLI 自己发起的回合，例如 Claude 的定时任务、后台子 agent 回报或跨会话消息。第 9.3 节第 6 条中，与上一份 background_tasks 对应的 task-notification 回合不算在内。对工作 agent 的处理方式是：将其 control 置为 paused，停止后续自动投递并通知用户核验。若它打断了原有回合关联，同时将任务置为 uncertain；不能继续把后续最终消息归给旧 submission。

主 agent 上出现非本系统发起的回合时，不停用语音层：

- 暂停向主会话投递，inbox 继续排队；
- 该回合的最终消息不进入 TTS，也不完成任何 dispatch；
- 该回合内带副作用的工具调用没有在途 dispatchId，按第 6.1 节被拒绝；
- 回合结束且身份不变后，自动恢复投递。

希望用文字下达指令的用户应使用 `listen` 控制台，不要直接在主 pane 输入。

用户也可主动执行 pause 后使用终端。恢复前检查会话身份、实际活动和未处理结果；正在运行的手动回合不自动归属于旧任务。若目标版本没有可用的输入边界 Hook，手动操作前必须显式 pause；初始化明确展示该限制。

应用内暂停只能防止本系统继续发送，不能锁住用户键盘。最终检查和真实写入之间仍有终端竞态；V1 通过单一自动写入者、手动接管约定和异常检测控制风险，不宣称完全排除外部输入竞争。

## 10. 关键交互流程

### 10.1 新任务与结果回流

```mermaid
sequenceDiagram
    participant U as 用户
    participant D as 常驻进程
    participant M as 主 agent
    participant W as 工作 agent
    U->>D: 唤醒并说出要求
    D->>M: user.message + dispatchId
    M->>D: agents.start / tasks.submit
    D->>W: 定向投递并记录 submissionId
    D-->>M: written / 后续可查询 observed
    M->>D: 最终短回复 Hook
    D-->>U: 口播当前派发状态
    Note over M,W: 工作期间主 agent 可以处理其他对话
    W->>D: 最终消息 Hook
    D->>D: 关联回合并确认结束，task=reviewing
    D->>M: worker.turn_ended + 结果引用
    M->>D: tasks.get 读取原始结果
    M->>D: tasks.decide complete / fail / ask_user
    M->>D: 最终短回复 Hook
    D-->>U: 口播结果或问题
```

### 10.2 普通问题的回答

主 agent 将工作结果中的问题通过 ask_user 注册为 requestId。下一条用户输入始终先进主 agent，由它区分“回答这个问题”“询问其他事情”与“修改任务”。只有明确回答才调用 tasks.reply。

requestId 绑定 taskId、generation 和来源结果。问题已撤回、任务取消或会话改变时，拒绝旧回答。即使第一版只有一个工作 agent，也不能把所有“可以”“继续”都直接发送给工作端。

### 10.3 原生阻塞/权限弹窗

本助手启动的 agent 跳过审批，通常不会出现权限弹窗。本节主要处理两类情况：接管的既有会话出现弹窗，以及跳过审批后仍会出现的其他原生交互，例如登录、信任确认或 CLI 自身的选择界面。

Herdr blocked 先归为 waiting_terminal，daemon 建立 type=terminal_action 的待处理记录，并将 worker.blocked 事件交主 agent 解释。相同阻塞只保留一条开放记录；它的生成不需要主 agent 对结果执行 tasks.decide。

主 agent 可以据诊断解释大致情况，但不能仅凭屏幕文字升级为可机器批准的权限请求。原生交互解除后关闭该记录；观察到工作继续则回到 running，取得匹配最终消息则进入 reviewing。只看到 ready 却没有可关联结果时进入 uncertain，不假设人工操作已经批准或完成任务。

口播示例：“Codex 的终端需要一次确认，请在对应 pane 查看并处理。”用户处理后，daemon 重新核验状态，恢复观察或接收最终结果。若用户只在语音中说“允许”，主助手说明本版需要终端操作，不发送 Enter 或假定选择了允许。

普通自然语言问题通常通过回合末最终消息进入 waiting_user；若问题出现在原生交互 UI，第一版同样按 waiting_terminal 处理。未来只有接入具有稳定 request ID 和精确响应语义的原生协议，才增加语音权限响应。

### 10.4 取消与停止播放

“停止播放”只终止当前音频，已经运行的编码任务保持原状。“取消当前任务”则撤销未发送输入并请求中断工作回合，不关闭会话、不删除文件、不做回滚。

中断请求送达后进入 cancelling；只有确认旧回合不再运行才能置为 cancelled。中断按键按 CLI 区分（已实测）：Claude 用 `ctrl+c`，因为它在前台执行 Bash 时 Esc 无法中断；Codex 用 `esc`。两者中断时都不触发 Stop。取消请求发出后，即使任务因超时进入 `uncertain(cancel_unconfirmed)`，之后到达的 Stop 或中断证据仍按取消处理，不把任务转回 reviewing。“已停止”的证据如下：

- Codex：收到 turn_id 与当前 submission 一致的 Interrupt Hook。
- Claude：没有中断 Hook。证据是发出中断后 Herdr 转为 idle 或 done、completion_seq 递增，且该 prompt_id 在一个短观察窗口内没有出现 Stop。如果窗口过后又收到该 prompt_id 的 Stop，按迟到事件保留，不改变 cancelled。

超时或失联进入 uncertain，播报“已请求停止，但还无法确认任务停下来了”。取消后收到的旧结果保留为迟到事件，不把任务改回 completed。

空闲的 waiting_user/reviewing 任务可以直接取消，因为没有正在运行的受管回合。投递结果未知时，取消也不能消除“可能已经执行”的事实。

## 11. 本地语音链路

### 11.1 第一版选型

为了覆盖自定义中文触发词，第一版拟用一个 Python 音频进程承载 sherpa-onnx KWS、Silero VAD、SenseVoice STT 和 Kokoro 中英 TTS。设备采集与播放通过一个音频 I/O 库完成，优先验证 sounddevice；控制进程使用已有 Node.js 的标准库，不增加前端或构建工具。

sherpa-onnx 的开放词表 KWS 支持配置关键词而无需重新训练，但关键词需要按所选模型转换成对应 token。不能把汉字直接填入任意模型词表。[sherpa-onnx KWS](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)

SenseVoice 与 Kokoro 的选型参考官方模型文档；实现前固定兼容的软件版本、具体模型文件、校验值、语音与权重许可，不在运行中自动下载或替换模型。[SenseVoice](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html)；[Kokoro 中英模型](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)

这是待实施的依赖方案，本文不安装任何包或模型。实施时在引入上述依赖和下载模型前确认；如果目标环境无法运行该组合，明确调整设计，不静默切换云端服务。

里程碑 C 的实际选型（2026-10-25 经用户确认）：

- Python 包装在项目内的 uv 虚拟环境 `audio/.venv`（Python 3.14），版本锁定在 `audio/requirements.txt`：sherpa-onnx 1.13.8、sounddevice 0.5.6、numpy 2.5.4；换用 Whisper 后增加 mlx 0.32.2、mlx-whisper 0.4.3。
- 合成模型用 fp32 版本，其余模型用 int8 版本，放在 `~/.local/share/voice-assistant/models`，压缩包的 sha256 记录在 `SHA256SUMS` 和模型清单中：
  - 唤醒：kws-zipformer-wenetspeech-3.3M
  - 端点检测：silero_vad.onnx
  - 识别：mlx-community/whisper-large-v3-mlx（FP16，revision 49e6aa28，`weights.npz` 与 `config.json` 的 sha256 记在 `SHA256SUMS` 和清单中；最初用 sense-voice-zh-en-ja-ko-yue-int8-2025-09-09，因中英混说准确率更换，见下文）
  - 合成：kokoro-multi-lang-v1_1（fp32，最初用 kokoro-int8-multi-lang-v1_1，因短句 NaN 和速度更换，见下文），音色 sid 12（最初选 sid 3 / zf_001，因 int8 短句 NaN 问题更换）
- 模型清单在 `~/.config/voice-assistant/models/manifest.json`，记录模型路径、哈希和选定参数；播报语速不在清单里，由 config.json 的 voice.ttsSpeed 配置，daemon 校验后随 voice 段下发给音频进程。keywords 文件按 ppinyin 规则手写，逐个 token 核对过它们都在模型词表中，没有引入 text2token 需要的额外依赖。音频进程启动时核对唤醒短语与 keywords 文件一致。
- 播报按段流水线合成：在句末和中文逗号、顿号、冒号处切段，播放当前段时合成下一段。sherpa-onnx 1.13.8 内部把中英文分块后按 token 长度而非标点合并成批、每批独立推理，中英混合时停顿会落错位置（实测“了，PR 链接发你”在“PR”后停顿），自行在标点处切段可让停顿落在标点上。不在英文逗号、冒号处切，避免拆开 1,000、10:30。（int8 时期实测 149 字的回复从就绪到开始播放约 1.6 秒，`/stop` 约 0.2 秒生效。）
- 实测 kokoro int8 合成一两个字的短句时，部分音色会输出全 NaN，播放时没有声音。sid 3 上“好的”“我在”“收到。”几乎每次都是 NaN；扫描 sid 3–57 后，12、15、18、24、29、31、32、35、37、38、40–53、56 在 20 条常见短回复上没有出现 NaN，但单字句（如“嗯。”“对。”）在其他一些音色上仍会出现。因此合成结果含 NaN 时按合成失败报告，不记为 played。
- 改用 fp32 后（同一 Kokoro v1.1，voices.bin、tokens.txt、词典与 int8 包一致，模型 325 MB 对 114 MB），M4、4 线程实测：7 条短句各 3 次，在 sid 3 / 12、1.0 / 1.2 / 1.95 倍下均未出现 NaN（int8 下 sid 12 在 1.95 倍为 18/21、sid 3 在 1.0 倍为 18/21）；6 条中英混合句 RTF 约 0.38–0.50，int8 约 0.63–0.72。NaN 检查保留。
- 唤醒应答：音频进程启动时用当前音色以固定 1.3 倍语速合成一次“我在”（不随 ttsSpeed：int8 时期 sid 12、4 线程下实测应答为 1.95 倍时“我在”38/40、“收到”31/40 输出 NaN，1.3/1.5/1.7 倍各 40 次均无；numThreads 为 1 时即使 1.0 倍也几乎每次 NaN），裁掉首尾静音后留在内存，之后每次唤醒或按键录音直接播放，不再现场合成。合成失败（含 NaN）时音频进程启动失败，并提示更换 speakerId。实测从收到录音请求到开始录音约 0.79 秒（sid 12），主要是这两个字本身的播放时长。应答播放期间的采集被丢弃，用户需在“我在”之后再开口。
- 收到应答：同样在启动时缓存一段“收到”。VAD 判定一句话结束后立即非阻塞播放，与语音识别并行；播放期间及其后 playbackGuardMs 内不检测唤醒词，回到待唤醒前等它播完，避免被录音期间暂存的回复截断。
- 语气词过滤（SenseVoice 时期确定，换用 Whisper 后规则不变）：SenseVoice 没有去语气词的选项。实测 38 条真实转写里 14 条含“呃”，“嗯”偶有出现，“额”没有出现；开着 use_itn 也不输出标点。因此识别后只删“呃”（排除“呃逆”）和“嗯”，整句只有“嗯”时保留，因为它可能是在答“是”；只剩语气词的句子按空转写拒绝。“啊、吧、嘛、呢、那个、就是、然后”带语气或语义，“额”会误伤“额度、额外”，“唔”在粤语里表示否定，叠字会误伤“看看、试试”，这些都不处理。
- 口吃去重：daemon journal 中 52 条真实语音转写里，两字及以上的相邻完全重复有 4 处（禁止禁止、他的问的问题、补一下补一下、新模型新模型），都是口吃，因此在删语气词之后把这类重复折叠为一次。单字重复有 5 处（工工作、放放到、补补、校校验、雄雄），其中 4 处是口吃，但“补补、放放”本身也是正常叠字，与“看看、谢谢”无法区分，所以不处理；以“一”开头或结尾的片段（一个一个）、叠字开头的片段（谢谢谢谢）和英文（had had）也不处理。代价是“研究研究、讨论讨论”这类 ABAB 叠用会被折成一次，意思不变。“们我们现在”“开两个公开两个”这类不完全重复的改口不处理。
- 识别换用 Whisper（2026-10-25 经用户确认）：同一批 20 条中英混合开发指令、Kokoro sid 12 / sid 3 合成的 40 段音频上，SenseVoice MER 35.42%，MLX Whisper large-v3 FP16（`language=zh`、简体中文 `initialPrompt`、temperature 0 greedy、不沿用上一段文字）19.94%，提升主要在英文技术词（WER 88.89% → 34.44%）；代价是暖态单句识别约 1.22 秒（SenseVoice 约 72 ms），常驻内存约 3.4 GB。自动语言识别质量相同但耗时近一倍，因此固定 `zh`；mlx-whisper 0.4.3 不支持 beam search。识别参数（模型目录、语言、提示词）写在清单的 `asr` 段。启动时用 1 秒静音预热一次（加载约 2 秒），结果丢弃。
- 裸 Whisper 对静音会输出提示词尾句等幻听，因此识别只接收 Silero VAD 切出的语音段：经 voice.py 的录音逻辑，1、3、5、10 秒全零和 10 秒 -50 dBFS 白噪声都没有产生语音段，不会送识别；等待开口超时按 no_speech 拒绝。
- Whisper 同样需要前导静音：VAD 段几乎从开口处开始，不补静音时 40 段里有 2 段吞掉开头的“把”（“把 timeout 改成三十秒”识别为“蓋成30秒”）、1 段整句输出提示词，MER 25.3%；补 0.3 秒静音后吞字和输出提示词的两段恢复，但另一段吞“把”的变成输出无关套话（“本视频由……制作”），MER 21.1%，略高于直接识别原始 wav 的 19.94%。经 VAD 后识别耗时均值 1.23 秒、p95 1.33 秒（语音段平均 2.9 秒）。以上均为合成语音，真人录音尚未复测。

### 11.2 名称与唤醒短语

助手显示名与触发短语分别配置。例如显示名“叮洛”，唤醒短语“你好叮洛”；此名称仅为设计示例，可替换。产品名可以短，实际触发词优先采用更易区分的四字左右短语。

配置阶段生成并核验 keywords 文件，运行时只加载核验后的模型和词表。唤醒音频本地处理，不送给主 agent；只有一次用户话语的最终转写进入对话。

### 11.3 音频状态机

```text
armed：持续本地检测唤醒词
  → listening：播放应答“我在”后录制一句话，VAD 判断话语结束
  → transcribing：生成最终文本
  → armed：文本已交 daemon，继续接受下一次唤醒

有待播报且没有录音：→ speaking → armed
speaking + 按键录音：停止播放 → listening
speaking + 唤醒词：停止播放，丢弃待播的普通回复（保留关联问题的播报） → listening
```

音频进程独占采集设备，KWS 与 STT 共用采集流，不反复争抢麦克风。采集统一为模型所需的单声道格式；TTS 按模型输出采样率播放，不假设与麦克风一致。

### 11.4 回声、打断和输入优先级

最初采用半双工（播放时暂停 KWS），后改为播报期间照常检测唤醒词，用于打断。没有 AEC，自唤醒按来源分别处理：

- 口播内容本身含唤醒词（如“你可以说你好叮洛”，或同音的“你好，丁罗”）：每段合成后用另一个 KWS 实例离线扫描该段音频（连同前一段末尾 1.5 秒，覆盖被逗号切开的“你好，叮洛”），命中的段在播放期间及其后 playbackGuardMs 内暂停检测。扫描约 20–70ms 一段，只有首段会推迟开口。
- 普通口播的回声：依靠 KWS 本身的区分度，不改阈值。2026-10-25 实测（Mac mini 内置扬声器、系统音量 53、USB 麦克风）6 条共约 60 秒不含唤醒词的回复，误唤醒 0 次。
- 抢话成功率取决于用户声音与回声之比。离线仿真（Kokoro 不同音色说唤醒词叠加带反射的回复回声）：回声比用户低 12dB 及以上 18/18 检出，低 6dB 16/18，等响 5/18，高 6dB 0/18。真机抢话成功率待用真人语音验收。

唤醒词打断后，音频进程立即停止播放并清空自身队列（被清掉的记为 interrupted），daemon 收到 wake 时若正在播报，把尚未下发的普通回复标为 skipped，录音结束后不再接着播旧内容，文字已在控制台显示；关联 ask_user 问题（有 requestId）的播报保留，录音结束后照常播放，播放前仍核对问题是否开放。被打断的当前这条即使是问题也记为 interrupted，不自动重播。按键录音仍只停止当前播放，待播内容在录音结束后继续播放。

用户录音期间新回复暂存；主 agent 的理解和工作任务可以继续进行。录音结束后，按回复顺序播放尚有效的内容。已被回答/撤销的问题不再作为新的问题口播；错过的最终结果仍保留文字。

### 11.5 录音边界与错误

设计初值为等待开口 5 秒、句末静音 800ms（用户试用后改为 1200ms，留出思考停顿）、单次最长录音 30 秒，均为本应用参数，不冒充模型 API 默认值。空转写不发送；达到最长时提示重新分句，不把截断内容直接当完整指令执行。

STT 出错显示具体错误并保留可重新录音入口；不自动发送不完整转写。控制台支持文字输入，使不确定的人名、路径或代码参数可以由用户明确输入。

### 11.6 播报队列

主 agent 最终回复生成 speechId，关联 dispatchId，以及存在时的 taskId/requestId，记录 `ready / playing / played / interrupted / failed / unknown / stale / skipped`（stale：关联问题已失效；skipped：被唤醒词打断时尚未下发的普通回复）。播放前重新核对关联问题是否仍开放，以实现过时问题失效。单次只播放一条，完整文字一直可见；建议长度是提示约定，不通过硬截断改变原意。送入 TTS 前只去掉残留的 Markdown 标记符号，不改写或删减文字内容。

取消、撤回或已处理请求会使相关旧播报失效。播放中断记为 interrupted，不自动从头重播；TTS 失败明确显示并可手动重播。重启后不自动播放不确定是否已经听过的音频，避免重复报喜或重复提问。

## 12. 本地协议、配置与持久化

### 12.1 IPC

daemon 对外提供本用户可访问的 Unix socket，运行目录权限 0700，文件按需要限制为 0600。请求和响应均为一行一个 JSON，请求包含 protocolVersion、rpcId、method 和 params；rpcId 只用于 IPC 请求响应关联，与用户问题的 requestId 分开。未知方法或版本明确报错。

音频子进程使用标准输入输出 JSON 行，音频留在子进程内部处理，协议 stdout 不混入库日志。退出、设备失效和解码错误都转成显式错误事件。

本设计不发送 `response.interrupt`。停止音频是本地播放动作，取消工作通过后端中断能力完成。原生 CLI 与其模型供应商之间的传输由用户已有配置决定，不能因为本程序不用 WebSocket 就宣称所有 CLI 连接都已关闭 WebSocket。

### 12.2 配置示例

以下字段为本应用拟定格式，与原生 CLI、Herdr 配置无关。路径需填写真实已存在的绝对路径，不能原样使用占位内容。

```json
{
  "schemaVersion": 1,
  "backend": "herdr",
  "main": { "kind": "claude", "model": "sonnet", "effort": "medium" },
  "worker": { "defaultKind": "codex", "maxManaged": 1, "maxAutoContinue": 3 },
  "projects": { "allowedRoots": ["/absolute/path/to/project"] },
  "voice": {
    "displayName": "叮洛",
    "wakePhrase": "你好叮洛",
    "modelManifest": "/absolute/path/to/models/manifest.json",
    "playbackGuardMs": 300,
    "ttsSpeed": 1.2,
    "waitForSpeechMs": 5000,
    "endSilenceMs": 1200,
    "maxUtteranceMs": 30000
  }
}
```

`main.model` 与 `main.effort` 可省略，省略时沿用原生 CLI 的默认值。Claude 主 agent 传 `--model` / `--effort`（low/medium/high/xhigh/max）；Codex 主 agent 传 `-m` 和 `-c model_reasoning_effort=…`（minimal/low/medium/high/xhigh）。主 agent 只负责理解、派发、审核和总结，推荐 Sonnet + medium。测试数据显示主 agent 的消耗几乎全在每次调用重读上下文：两个主会话 97 次调用共读约 630 万 token，输出含思考约 2.2 万 token。因此思考强度主要影响延迟，不是成本。

Claude 主 agent 额外传 `--tools Bash --strict-mcp-config`：主 agent 只用 Bash 调用工具命令，不需要其他内置工具和用户配置的 MCP 工具。用 `claude -p` 实测只回复一句话时的上下文：默认 31,606 token；只留 Bash 时 20,574 token（剩余的主要是 MCP 工具定义）；再加 `--strict-mcp-config` 后 7,427 token。

本助手启动的 Claude 工作 agent 额外传 `--disallowedTools AskUserQuestion`：该工具的选项只显示在 pane 里，Stop Hook 拿到的最终消息不含这些选项，主 agent 无法转述。daemon 投递给 Claude 工作 agent 的文本末尾附一条约定：不要使用 AskUserQuestion，需要用户决定时在回复末尾用文本写出问题和编号选项后结束本轮。接管的会话不重启、不改启动参数，只靠这条约定。

实测 Sonnet + medium 主 agent（交互模式）：
- 首次调用的上下文为 9,125 token，原来是约 5.1 万。
- 一次完整往返共 7 次调用、上下文合计约 9.5 万 token，原来是每次调用重读 6 万到 8 万。往返包括启动 worker、投递、读结果、判断和两次口播，审核结论与实际结果一致。
- 发现两个问题：
  - 主 agent 曾把 `agents.list` 里的自己当成工作 agent 汇报。现在 `agents.list` 只返回 `workers`（不含主 agent）和 `candidates`。
  - 用户只给了项目名、没给路径时，主 agent 自己用 `ls`/`find` 搜索了用户目录。经用户确认，取消"主 agent 不运行命令"的约定：查路径、看文件这类简单查询允许主 agent 自己做，改代码和较长的工作仍委派给工作 agent；主 agent 仍不直接调用 herdr。

配置缺失/非法即报告字段错误，不默选其他模型、项目或后端。项目路径先 realpath 再判断是否位于 allowedRoots 中。maxManaged 必须为正整数，是同时受管工作 agent 的上限；任务、结果和请求都按 taskId/agentId 归属，多个工作 agent 互不影响。

不配置第二套 LLM API key。模型清单记录本地模型文件、哈希和选定参数；缺少模型时报告缺失项，不启动下载。

### 12.3 文件结构

```text
<用户配置目录>/voice-assistant/
  config.json
  models/manifest.json              # 清单，权重位置可以另配

<用户状态目录>/voice-assistant/<instanceId>/
  daemon.lock
  journal.ndjson                    # 单写入者的权威业务记录
  state.json                        # 可重建的快照，包含 lastJournalSeq
  spool/                            # Hook 原子交接，多个写入者各写独立文件
  results/                          # 原始最终消息与必要的原生事件信息
  backends/herdr/                    # 私有会话/位置绑定
```

暂不引入数据库、Redis 或额外消息系统。journal 是事实源，state.json 只是加速恢复的快照；业务状态、队列项与投递意图在同一个 journal 记录中原子表达。

### 12.4 持久化与崩溃边界

1. Hook 先写同目录临时文件，fsync 后 rename 到 spool，并同步目录；确认后才报告成功。
2. daemon 消费 spool，先保存结果文件，再追加 journal 并 fsync；之后才删除已消费 spool。
3. 重复消费按 eventId 去重；崩溃遗留的临时文件不能被当作完整事件。
4. 外部投递前先记录 prepared，得到确认后写 written。崩溃落在两者之间时进入 unknown，不自动重复发送。
5. 单条 journal 记录更新状态与 inbox，快照采用同目录原子替换，读取时校验版本和序号。
6. 文件尾被截断时保留原始残片并明确报告恢复；中部记录损坏阻止自动运行，不跳过错误后继续写入。

这些步骤保证交接和业务处理可追踪，不宣称终端输入、模型执行或扬声器播放具有 exactly-once 语义。

### 12.5 重启恢复

daemon 获取实例锁 → 校验并重放 journal → 处理未消费 spool → 查询后端当前身份/状态 → 标出不确定投递与任务 → 恢复安全的观察和待处理事件。

仍在运行且身份一致的工作继续观察，不重发原命令；任务已完成但主 agent 尚未处理的结果可重新进入待处理队列。已经向主 agent 发送、但不知道它是否处理的 dispatch 必须先人工核验，不直接重投。

主 agent 丢失时停止自动派发并提示重新绑定/启动；不悄悄建立一个空白主会话并假设继承全部记忆。工作 agent 丢失时保持结果未定，原生会话恢复由显式恢复流程完成。

## 13. Herdr 事件丢失与身份变化

Herdr 订阅事件不持久、不会自动重放；events_lost 会结束订阅，且快照与事件没有共同序号边界。应用将事件作为“需要重新检查”的信号，实际状态以新查询为准。[Herdr 事件订阅](https://herdr.dev/docs/socket-api/#event-subscriptions)

处理原则：

- 断线或 events_lost 后暂停新的自动发送，重新订阅并读取当前快照。
- 因快照与订阅没有原子交界，恢复期间的事件只触发再次 inspect，不把旧 payload 覆盖到新快照上。
- 对活跃对象保留低频定时 inspect；即使订阅正常也能发现遗漏的状态变化。
- native session 或进程身份变化，旧 generation 的所有未发送命令失效，转入人工核验。
- 后端不能证明移动后的对象仍是原来的 agent，就暂停绑定；不按相同 alias 寻找替代进程。
- 原始最终消息由本地 Hook spool 独立保存，Herdr 事件丢失不会被解释为“没有结果”。

## 14. 异常处理与边界

| 场景 | 系统行为 | 用户看到/听到 |
| --- | --- | --- |
| Hook 未加载或未获信任 | 初始化不通过，不宣布完整可用 | 明确缺失能力和处理位置 |
| 原生最终消息为空 | task=uncertain，原因 result_missing | “回合似乎结束了，但没有取得可用结果” |
| 输入写入/启动结果不明 | 保留 unknown，不自动重发 | 明确“可能已送达”，给出核验入口 |
| worker 需要权限或原生表单 | waiting_terminal，不模拟确认键 | 指向对应原生终端 |
| worker 超出预期执行时间 | 保留 running 并显示耗时，可取消 | 不仅凭耗时报告失败 |
| worker 退出/被替换 | 停止自动输入，检查最终事件和未结束任务 | 明确会话异常及尚未确认的结果 |
| 主 agent 忙 | 持久排队；语音层可继续接收 | 控制台显示已收到、待处理 |
| 主 agent 失败或需要原生确认 | 停止自动派发，保留 inbox | 控制台/提示音提示处理主会话 |
| 用户手动输入 | 暂停自动控制并记录外部回合 | 明确已经转为手动操作 |
| STT 空结果/失败/超长 | 不生成可执行用户消息 | 显示重新录音或文字输入入口 |
| TTS/设备失败 | 保留文字和 speech 状态 | 错误可见，可手动重播 |
| 持久化失败 | 停止新的副作用与接收确认 | 明确磁盘/文件错误，不假报接收成功 |
| 后端不支持所需能力 | 返回 unsupported | 不回退到不可靠的屏幕抓取流程 |

默认不保存原始录音；最终消息与转写按本地对话资料保存。清理只针对本应用明确归属的文件，不删除原生 CLI 历史或用户 pane。Hook 正文可能包含项目内容，使用本用户目录，不写入项目仓库。

## 15. 最小代码组织与实施顺序

### 15.1 拟定文件

```text
src/
  main.mjs             # CLI、daemon、IPC、状态、队列、Hook 标准化
  herdr.mjs            # 七个后端操作、Herdr 绑定和诊断
audio/
  voice.py             # 音频采集、模型、转写与播放
prompts/
  main.md              # 主 agent 行为与工具约定
design.md
```

先不创建 BaseBackend、BackendManager、TaskService、EventBus、SpeechProvider 等只有一层转发的模块。后端契约以本文和实际导出函数约束，不为此增加 TypeScript 构建链。其余代码只有在删除该模块会让多个调用方重新承担复杂度时才拆分。

### 15.2 实施里程碑

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| A：文字闭环 | daemon、主会话（最大权限启动）、一个工作会话、工具与状态、Stop Hook 最终消息采集 | 主 agent 可委派，原会话可续接，长任务不阻塞主对话 |
| B：可靠结果 | Hook 关联与去重规则、任务判定、追问、持久队列、uncertain 恢复 | 成功/失败/问题分流，重复事件不重复产生动作 |
| C：本地语音 | 按键录音、VAD/STT、主回复 TTS | 中文请求完整往返，文字/声音对应，停止播放不取消工作 |
| D：唤醒与恢复 | 自定义 KWS、手动接管、断线和重启核验 | 唤醒闭环与下表关键场景通过 |

A/B/C 都是开发里程碑；D 完成后才称第一版满足本设计。实施前确认音频依赖和模型下载；若进入代码仓库主分支开发，按仓库约定先选分支策略。本文仅创建设计文档，不执行安装、运行配置修改或 agent 控制。

## 16. 验收场景

采用真实业务场景验收，不编写或运行单元测试。使用独立临时项目、无副作用任务和明确归属的工作会话，保留关键 journal/Hook/控制台证据。需要验证改文件场景时仅修改临时项目。

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| V01 | 唤醒后进行简单聊天 | 没有创建工作 agent；同一主会话回复并播报 |
| V02 | 指定 Codex/Claude 执行一个临时项目任务 | 新建正确 kind/cwd 的一个工作会话，保留焦点；转达状态准确 |
| V03 | 工作期间问主助手状态 | 主助手可回复；不会把状态查询注入工作会话 |
| V04 | 对未完成任务补充条件 | 同一个 taskId/native session；busy 时显示排队，ready 后才投递 |
| V05 | 工作 agent 问一个普通问题 | 主助手口播；用户回答通过正确 requestId 回到原会话 |
| V06 | 对已经撤销的问题说“可以” | 不投递旧回答、不批准原生权限，主助手解释需要重新指定 |
| V07 | 接管的会话出现原生权限弹窗，或出现其他原生交互 | waiting_terminal 并提醒；语音“允许”不触发 Enter 或其他批准动作 |
| V08 | 工作最终报告失败或验证未执行 | 口播保留失败/验证限制；不因 ready/done 标成成功 |
| V09 | 同一 Hook 文件重复消费 | 只产生一个业务结果处理和一条有效播报，不重复委派 |
| V10 | 主 agent 忙时工作完成 | 结果落盘排队，主 agent 下一轮处理，无终端输入竞争 |
| V11 | Stop 候选后原生回合继续 | 不提前报完成；缺少可确认边界时进入明确未定状态 |
| V12 | 缺少最终消息或 Hook 未获信任 | 不伪造摘要；初始化或任务清楚报出缺口 |
| V13 | 发送后断线/崩溃，无法确认生效 | 标为 unknown/uncertain，重启不自动重发 |
| V14 | 正常运行中的明确取消 | 仅中断目标任务，确认停止才标 cancelled，不关闭 pane 或回滚文件 |
| V15 | 播报期间按键说话 | 当前播放停止并录音；工作任务继续；不把 TTS 当成用户输入 |
| V16 | 自定义中文唤醒短语 | 普通室内环境、约 1 米距离，固定 20 次唤醒至少 18 次成功；30 分钟代表性背景音误唤醒不超过 1 次 |
| V17 | 工作过程中手动接管 | 自动投递暂停；恢复时重新核验，不把手动回合归入旧任务 |
| V18 | agent 被替换或原生 session 改变 | 旧 generation 命令拒绝执行，不因 alias 相同误投 |
| V19 | daemon 重启或 Herdr 订阅中断 | 任务/问题可恢复；没有重复执行或自动重播；当前状态可核验 |
| V20 | 对一个已配置 Hook 的空闲既有会话接管 | 身份与能力检查通过后受管；不修改或接管其他对象 |
| V21 | 第二个工作 agent 创建请求 | 明确返回本版数量限制，不启动额外进程 |
| V22 | 检查后端依赖边界 | 核心业务不解析 Herdr ID/状态字段；不为验收强行实现第二个后端 |
| V23 | 完成任务后释放工作会话，再换一个 kind | 旧会话保持原状，新会话正确受管；任何时刻受管 worker 不超过一个 |
| V24 | 工作 agent 或非在途 dispatch 调用 `tasks.decide` | 返回 not_active_dispatch，任务状态不变 |
| V25 | 本助手新建主 agent 和工作 agent，并执行一个需要改文件和运行命令的临时项目任务 | 两者均以最大权限参数启动，全程没有审批弹窗；Hook 仍正常触发 |
| V26 | 任务进入 uncertain 后，原回合恢复，或用户在控制台确认放弃 | 分别转为 running/reviewing 或 cancelled/failed；之后 worker 可以接新任务 |
| V27 | 工作结果连续要求继续，达到 maxAutoContinue | continue 被拒绝，主 agent 改为向用户提问 |
| V28 | Claude worker 执行一个超过 40 秒的命令 | 不进入后台；同一 prompt_id 只产生一份 Stop，且 background_tasks 为空；不会提前报完成 |
| V29 | Codex 新 Hook 未信任，或 Claude 目标目录未信任 | 启动预检直接报告原因，不启动 agent，也不向审核或信任界面投递输入 |

V16 是第一版目标验收线，不是对所有麦克风、口音和环境的性能承诺。记录实际设备、模型版本、短语与阈值，未达标就不能宣称该配置的免手操作已通过。
| V30 | 释放空闲工作 agent 时 closePane 为 true；另对接管的会话、手动控制中的会话各试一次 | 自启动的 pane 关闭后才标记 released；接管或手动控制的会话被拒绝，pane 和受管状态不变 |

关键耗时按“用户说完→转写完成”“主回复就绪→开始播放”“工作结果就绪→主 agent 处理”分别记录，区分排队、模型和音频耗时。首轮先建立真机基线，不预先承诺未经测量的端到端延迟。

## 17. 已核验事实与实施前检查

设计参考当前调研环境中的 Herdr 0.9.5、Codex CLI 0.164.0 和 Node.js 24.17.0；它们是观察基线，不代表本系统完成兼容性验收。实际部署必须记录客户端/服务器版本与原生 CLI 版本。

2026-10-25 对照官方文档核验了以下事实（只核对文档，未在本机实测）：

- Claude Code：Stop 的输入字段，公共字段 prompt_id，用户中断时不触发 Stop，StopFailure，UserPromptSubmit 的额外触发来源，以及 Hook 改动通常通过文件监视加载。
- Codex：Stop 和 UserPromptSubmit 的 turn_id，可空的 last_assistant_message，Interrupt 事件，以及按哈希记录的 Hook 信任。
- 本机 CLI 参数（Claude Code 2.1.310、codex-cli 0.164.0）：`claude --dangerously-skip-permissions` 存在；`codex --dangerously-bypass-approvals-and-sandbox` 存在，`--yolo` 是它的隐藏别名，二者同时传入会报错。
- Herdr：事件不持久、`events_lost` 只关闭该订阅连接、快照与事件没有共同序号，`agent prompt` 可以向 working 状态的 agent 提交且只确认进入队列，`agent wait` 不跟踪单个回合，`completion_seq` 可能被旧服务器省略。

2026-10-25 在本机做了实测（Herdr 0.9.5、Claude Code 2.1.310、codex-cli 0.164.0）。Hook 通过 Claude 的 `--settings` 和 Codex 的 `-c hooks.*` 临时注入，没有修改 `config.toml`。

- 两个 CLI 的 Hook 进程都继承 `herdr pane split --env` 注入的环境变量；`herdr agent start ... -- <参数>` 能透传 CLI 参数。
- Claude：
  - SessionStart 在启动时触发，session_id 与 Herdr 的 `agent_session.value` 一致；
  - UserPromptSubmit 和 Stop 的 prompt_id 一致，prompt 与投递文本完全一致；
  - Stop 中有 last_assistant_message 和 background_tasks。
- Codex：SessionStart 到第一次提交输入时才触发；UserPromptSubmit 和 Stop 的 turn_id 一致；Stop 中有 last_assistant_message。
- 两个 CLI 在最大权限参数下，Hook 中的 permission_mode 都是 `bypassPermissions`，全程没有审批弹窗。
- 中断：两个 CLI 都用 Esc 中断，都不触发 Stop；Codex 触发带 turn_id 的 Interrupt，Claude 没有对应 Hook。Herdr 在两种情况下都报告 done，completion_seq 递增。
- Claude 后台任务：不设 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 时，`sleep 40` 被放到后台，结果出现在自行发起的下一轮；设为 1 后在同一轮完成，background_tasks 为空。
- Claude 在未信任的目录启动时，会先弹出目录信任确认，跳过权限的参数不会跳过它。
- Codex 遇到未信任的 Hook 时，启动后先显示 Hook 审核界面，Herdr 却报告 idle。本机已有的 Herdr Codex SessionStart Hook 尚未被信任，所以现有 Codex pane 没有 `agent_session`。

里程碑 A、B 实现后，用 Claude 作为主 agent 和工作 agent 跑过以下验收场景，均通过：

- 里程碑 A：V01、V02、V03、V04、V05、V10、V14、V19（仅 daemon 重启后沿用主 agent、不重发）、V21、V24、V26（控制台 resolve 路径）、V28、V29（Claude 目录未信任）。
- 里程碑 B：
  - V06；
  - V09：daemon 停止期间 Hook 照常交接，重复的 spool 文件只处理一次；
  - V11：注入提前的 Stop 候选，回合仍在运行时不结束，以最终的 Stop 为准；
  - V13：注入"已 prepared、未写入"的崩溃状态，重启后标为投递不明，由用户 resubmit；
  - V17、V18（`/clear` 更换原生会话后暂停，拒绝恢复）、V27；
  - journal 尾部截断恢复；
  - 主 agent 丢失时 daemon 拒绝启动，需 `--new-main`。

Codex 路径尚未在 daemon 中端到端运行。

实现中补充的规则：
- Stop 之后需持续就绪 1.5 秒才算回合结束；
- 主助手没有对结果调用 tasks.decide 时提示"结果尚未归类"；
- 主 agent 出现 StopFailure 时暂停自动派发；
- 用户在控制台取消或 resolve 任务后，向主助手投递状态通知，避免它继续处理已撤回的问题。

已知后续项：journal 每条记录写入完整对象，长期运行会持续增长，尚未实现第 12.3 节的 state.json 快照与压缩。

里程碑 C 的验证情况（接入 USB 麦克风后，真人语音）：

- 组件层：用 Kokoro 合成的"你好叮洛"做输入，女声、男声都能唤醒，普通句子不误唤醒；端点检测切分正确。
- C 阶段完成条件：中文请求完整往返通过，包括唤醒→识别→主助手回复→播报，以及按键录音的同样流程；`/stop` 停止播放不影响任务。
- V15 通过：播报中按键，播报标为 interrupted，随即录到新的一句话。
- 实测耗时：说完到识别出文字约 1 秒内，回复就绪到开始播放 1.4 到 1.9 秒；主 agent 自身处理约 7 到 10 秒。
- 实测发现 SenseVoice 在没有前导静音时会吞掉第一个音节（"用四句话"被识别为"四句话"；官方 zh.wav 也丢了开头的"开放"）。识别前补 0.3 秒静音后恢复正常。

macOS 麦克风权限的实测结论：

- Herdr 的服务进程由 launchd 托管。从它的 pane 里启动的进程请求麦克风时，系统不弹授权框，直接返回全零音频。因此音频进程不由 daemon 启动，改为由不在 Herdr 内的前台控制台 `listen --voice` 作为子进程启动，再经 daemon socket 的 `audio.attach` 接入（第 3.1、12.1 节的 stdio 协议不变，只是由控制台中转）。同一时刻只接受一个音频连接，断开后语音不可用，文字仍可使用。
- 本机 Ghostty 的旧麦克风授权记录看起来"已允许"，实际拿不到音频。用 `tccutil reset Microphone com.mitchellh.ghostty` 重置后重新授权即恢复正常。

仍需完成：V16（固定 20 次唤醒的成功率，以及 30 分钟背景音下的误唤醒次数）。

里程碑 D 的实现与验证：

- Herdr 事件订阅：订阅受管 pane 的 `pane.agent_status_changed`，以及全局的 `pane.exited`、`pane.closed`、`pane.agent_detected`，事件只作为立即重查的信号。有在途回合的 agent 每秒检查一次，其余每 10 秒兜底一次。用 lldb 强行关闭 daemon 与 Herdr 之间的订阅连接，daemon 报告中断、暂停新的自动投递，约 1 秒后重新订阅并全量重查，之后恢复投递（V19 的订阅中断部分通过）。
- 全局 Hook：`install-hooks` 在 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 中追加本应用的条目，先备份、可重复执行、不改动已有 Hook。
  - daemon 启动的会话：随启动参数注入的 Hook 带 `--launch`；全局 Hook 看到 `VA_AGENT` 环境变量就跳过，避免重复。
  - 被接管的会话：通过 daemon 写入的 `sessions.json` 识别，写完整事件。
  - 其他会话：只写会话 ID 等元数据，daemon 只记在内存里，不写 journal。
- 接管（V20 通过）：`agents.adopt` 依次检查以下各项，全部通过后才登记：
  - 候选存在，且不是 daemon 自己所在的 pane，也未受管；
  - 未超过 worker 数量上限，且没有未结束的任务；
  - cwd 在 allowedRoots 内；
  - Herdr 报告了原生会话 ID；
  - 已收到该会话的 Hook 事件；
  - 会话当前空闲。
  
  接管后的会话完成了一个改文件的任务，结果经主助手审阅后汇报。
- V07 未完成：本机 Claude 默认处于跳过权限模式，接管的会话不会出现权限弹窗。需要用 `--permission-mode default` 启动的会话再测。

开始实现时仍需核验：

1. 主角色说明的加载方式：Claude 的 `--append-system-prompt` 或等价参数，Codex 的对应配置项。
2. Herdr 事件订阅在本机的实际行为；本程序运行在获授权的 Herdr 上下文中。
3. 本应用的 Codex Hook 由用户通过 `/hooks` 信任一次；不覆盖已有 Hook，并处理可能的 Stop continuation 冲突。
4. Python/音频库/模型组合能在本机加载，中文语音与自定义关键词可运行，设备权限已就绪。
5. 配置目录、状态目录和 Unix socket 的真实位置，以及本机 fsync/原子替换流程按设计实现。
6. Claude 中断判定所用观察窗口的取值，需用真实任务校准。

ACP 留给后续有明确消费者时再实现；Herdr 适配器本身不会自动成为 ACP 服务端。接入 QwenAudio 或其他前台时，先明确谁是唯一主协调者，再设计协议，避免两个主 agent 同时决定路由与播报。

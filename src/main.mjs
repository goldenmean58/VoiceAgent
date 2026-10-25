#!/usr/bin/env node
// voice-assistant：daemon、控制台、主 agent 工具入口与 Hook 交接。设计见 design.md。
import { randomUUID, createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, chmodSync, truncateSync, unlinkSync, writeFileSync, writeSync, watch,
} from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as herdr from "./herdr.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SCRIPT));
const HOME = os.homedir();
const CONFIG_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "voice-assistant", "config.json");
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "voice-assistant", "default");
const SPOOL_DIR = path.join(STATE_DIR, "spool");
const RESULTS_DIR = path.join(STATE_DIR, "results");
const LAUNCH_DIR = path.join(STATE_DIR, "launch");
const SOCKET_PATH = path.join(STATE_DIR, "daemon.sock");
const LOCK_PATH = path.join(STATE_DIR, "daemon.lock");
const JOURNAL_PATH = path.join(STATE_DIR, "journal.ndjson");
const REGISTRY_PATH = path.join(STATE_DIR, "sessions.json"); // 被接管会话的 nativeSessionId → agentId，供全局 Hook 识别
const PROTOCOL_VERSION = 1;
const KINDS = ["claude", "codex"];
const HOOK_EVENTS = { claude: ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"], codex: ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt"] };
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

const POLL_MS = 1000;
const IDLE_POLL_MS = 10000; // 没有在途回合时的兜底检查间隔
const DELIVERY_GRACE_MS = 15000; // 写入后迟迟没有 UserPromptSubmit
const STOP_GRACE_MS = 8000; // 回合已就绪但没有可关联的 Stop
const STOP_SETTLE_MS = 1500; // Stop 之后需持续就绪这么久才算回合结束，防止 Stop 后回合继续
const CANCEL_TIMEOUT_MS = 30000;
const SESSION_START_TIMEOUT_MS = 20000;

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function fsyncDir(dir) {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeFileAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

// ---------- 配置 ----------

function loadConfig() {
  let c;
  try {
    c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    throw new Error(`读取配置 ${CONFIG_FILE} 失败：${e.message}`);
  }
  const errs = [];
  if (c.schemaVersion !== 1) errs.push("schemaVersion 必须为 1");
  if (c.backend !== "herdr") errs.push('backend 必须为 "herdr"');
  if (!KINDS.includes(c.main?.kind)) errs.push("main.kind 必须为 claude 或 codex");
  // main.model / main.effort 可省略：省略时沿用 CLI 自己的默认值。
  if (c.main?.model !== undefined && (typeof c.main.model !== "string" || !c.main.model)) errs.push("main.model 必须为非空字符串");
  if (c.main?.effort !== undefined) {
    const levels = c.main.kind === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["minimal", "low", "medium", "high", "xhigh"];
    if (!levels.includes(c.main.effort)) errs.push(`main.effort 必须为 ${levels.join("/")} 之一`);
  }
  if (!KINDS.includes(c.worker?.defaultKind)) errs.push("worker.defaultKind 必须为 claude 或 codex");
  if (!Number.isInteger(c.worker?.maxManaged) || c.worker.maxManaged < 1) errs.push("worker.maxManaged 必须为正整数");
  if (!Number.isInteger(c.worker?.maxAutoContinue) || c.worker.maxAutoContinue < 0) errs.push("worker.maxAutoContinue 必须为非负整数");
  const roots = [];
  if (!Array.isArray(c.projects?.allowedRoots) || c.projects.allowedRoots.length === 0) {
    errs.push("projects.allowedRoots 必须为非空数组");
  } else {
    for (const r of c.projects.allowedRoots) {
      if (typeof r !== "string" || !path.isAbsolute(r)) { errs.push(`allowedRoots 项必须是绝对路径：${r}`); continue; }
      try { roots.push(realpathSync(r)); } catch { errs.push(`allowedRoots 路径不存在：${r}`); }
    }
  }
  // voice 段可省略：省略时只有文字控制台，不启动音频进程。
  if (c.voice !== undefined) {
    const v = c.voice;
    for (const k of ["displayName", "wakePhrase"]) if (typeof v[k] !== "string" || !v[k]) errs.push(`voice.${k} 必须为非空字符串`);
    if (typeof v.modelManifest !== "string" || !path.isAbsolute(v.modelManifest) || !existsSync(v.modelManifest)) {
      errs.push(`voice.modelManifest 必须是已存在的绝对路径：${v.modelManifest}`);
    }
    for (const k of ["playbackGuardMs", "waitForSpeechMs", "endSilenceMs", "maxUtteranceMs"]) {
      if (!Number.isInteger(v[k]) || v[k] <= 0) errs.push(`voice.${k} 必须为正整数`);
    }
    if (typeof v.ttsSpeed !== "number" || !Number.isFinite(v.ttsSpeed) || v.ttsSpeed <= 0) errs.push("voice.ttsSpeed 必须为正数");
  }
  if (errs.length) throw new Error(`配置 ${CONFIG_FILE} 无效：\n- ${errs.join("\n- ")}`);
  return { ...c, allowedRoots: roots };
}

// ---------- journal：单写入者的权威记录 ----------

const S = { agents: {}, tasks: {}, subs: {}, requests: {}, inbox: {}, ops: {}, events: {}, meta: {}, speech: {} };
let journalFd = null;
let journalSeq = 0;
let pendingOps = [];

function loadJournal() {
  if (!existsSync(JOURNAL_PATH)) return null;
  const raw = readFileSync(JOURNAL_PATH, "utf8");
  const lines = raw.split("\n");
  let offset = 0;
  let notice = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTail = i === lines.length - 1;
    if (line === "") { offset += 1; continue; }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // 最后一行没有换行符且无法解析：视为写入中途崩溃的残片，保留原文后截断。
      if (isTail) {
        const fragment = path.join(STATE_DIR, `journal.fragment-${Date.now()}`);
        writeFileAtomic(fragment, line);
        truncateSync(JOURNAL_PATH, offset); // offset 按字节累计
        notice = `journal 尾部有不完整记录，已保存到 ${fragment} 并截断`;
        break;
      }
      throw new Error(`journal 第 ${i + 1} 行损坏，停止自动运行；请人工检查 ${JOURNAL_PATH}`);
    }
    if (rec.seq !== journalSeq + 1) throw new Error(`journal 序号不连续（第 ${i + 1} 行）`);
    journalSeq = rec.seq;
    for (const op of rec.ops) {
      if (op.del) delete S[op.c][op.id];
      else S[op.c][op.id] = op.v;
    }
    offset += Buffer.byteLength(line) + 1;
  }
  return notice;
}

function save(c, id, obj) {
  pendingOps.push({ c, id, v: JSON.parse(JSON.stringify(obj)) });
}

function commit() {
  if (!pendingOps.length) return;
  const rec = { seq: journalSeq + 1, at: now(), ops: pendingOps };
  writeSync(journalFd, JSON.stringify(rec) + "\n");
  fsyncSync(journalFd);
  journalSeq = rec.seq;
  pendingOps = [];
}

const saveAgent = (a) => save("agents", a.agentId, a);
const saveSub = (s) => save("subs", s.id, s);
const saveReq = (r) => save("requests", r.requestId, r);
const saveItem = (i) => save("inbox", i.id, i);
function saveTask(t) {
  t.revision += 1;
  save("tasks", t.taskId, t);
}

// ---------- Hook：把原生事件交接到 spool ----------

// 两种来源：daemon 启动会话时随参数注入的 Hook（带 --launch，身份来自 VA_AGENT 环境变量），
// 以及用户级配置里的全局 Hook（用于接管既有会话，身份来自 daemon 维护的 sessions.json）。
// 全局 Hook 对未受管会话只记录元数据，不写 prompt 或回复正文。
function hookCommand(kind, event, flags) {
  const input = readFileSync(0, "utf8");
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.stderr.write(`voice-assistant hook: ${kind} ${event} 的输入不是 JSON\n`);
    process.exit(1);
  }
  let [agentId, generation] = (process.env.VA_AGENT || "").split(":");
  const launched = flags.includes("--launch");
  if (!launched && agentId) {
    process.stdout.write("{}\n"); // daemon 启动的会话已由随参数注入的 Hook 记录
    return;
  }
  let full = launched;
  if (!launched) {
    const entry = existsSync(REGISTRY_PATH) && JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))[payload.session_id];
    if (entry) {
      [agentId, generation, full] = [entry.agentId, String(entry.generation), true];
    }
  }
  const rec = {
    schemaVersion: 1,
    eventId: randomUUID(),
    receivedAt: now(),
    kind,
    hookEvent: event,
    agentId: full ? agentId : null,
    generation: full ? Number(generation) : null,
    metadata: !full,
    payload: full ? payload : { session_id: payload.session_id },
  };
  try {
    ensureDir(SPOOL_DIR);
    writeFileAtomic(path.join(SPOOL_DIR, `${Date.now()}-${rec.eventId}.json`), JSON.stringify(rec));
  } catch (e) {
    process.stderr.write(`voice-assistant hook: 写入 spool 失败：${e.message}\n`);
    process.exit(1);
  }
  process.stdout.write("{}\n");
}

// 在用户级配置中追加全局 Hook（接管既有会话需要）。只追加本应用的条目，不改动已有 Hook。
function installHooks() {
  const targets = [
    { kind: "claude", file: path.join(HOME, ".claude", "settings.json") },
    { kind: "codex", file: path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "hooks.json") },
  ];
  for (const { kind, file } of targets) {
    const raw = existsSync(file) ? readFileSync(file, "utf8") : null;
    const cfg = raw ? JSON.parse(raw) : {};
    cfg.hooks ??= {};
    let added = 0;
    for (const event of HOOK_EVENTS[kind]) {
      const command = hookCommandLine(kind, event, false);
      const groups = (cfg.hooks[event] ??= []);
      if (groups.some((g) => g.hooks?.some((h) => h.command === command))) continue;
      groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });
      added += 1;
    }
    if (!added) {
      console.log(`${file}：已安装，未改动`);
      continue;
    }
    if (raw) writeFileSync(`${file}.bak-voice-assistant-${Date.now()}`, raw);
    writeFileAtomic(file, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`${file}：追加 ${added} 条 Hook${raw ? "，原文件已备份" : ""}`);
  }
  console.log("Codex 需要在会话中用 /hooks 信任新增的 Hook 后才会执行。");
}

// ---------- IPC ----------

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    const rpcId = randomUUID();
    let buf = "";
    sock.on("error", (e) => reject(new Error(`无法连接 daemon（${SOCKET_PATH}）：${e.message}`)));
    sock.on("connect", () => sock.write(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, rpcId, method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      sock.end();
      resolve(JSON.parse(buf.slice(0, nl)));
    });
  });
}

async function toolCommand(action) {
  const raw = readFileSync(0, "utf8").trim();
  let input;
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: "bad_input", message: "stdin 必须是 JSON 对象" } }) + "\n");
    process.exit(1);
  }
  const res = await rpc("tool", { action, input });
  process.stdout.write(JSON.stringify(res.ok ? { ok: true, ...res.result } : { ok: false, error: res.error }, null, 2) + "\n");
  process.exit(res.ok ? 0 : 1);
}

// ---------- daemon ----------

let config;
const watchers = new Set();
const readySince = new Map(); // agentId -> 毫秒，仅内存观察值
let polling = false;
let scheduling = false;

function notify(type, text, extra = {}) {
  const msg = { type, at: now(), text, ...extra };
  process.stdout.write(`[${msg.at.slice(11, 19)}] ${type}: ${text}\n`);
  for (const w of watchers) w.write(JSON.stringify(msg) + "\n");
}

function mainAgent() {
  return S.meta.main ? S.agents[S.meta.main.agentId] : null;
}

function managedWorkers() {
  return Object.values(S.agents).filter((a) => a.role === "worker" && !a.released && a.activity !== "exited");
}

function checkWorkerLimit() {
  const n = managedWorkers().length;
  if (n >= config.worker.maxManaged) throw new ToolError("worker_limit", `已管理 ${n} 个工作 agent，达到 worker.maxManaged 上限；先释放一个再启动或接管`);
}

function activeSub(agent) {
  return agent.activeSubmissionId ? S.subs[agent.activeSubmissionId] : null;
}

function hookCommandLine(kind, event, launched = true) {
  return `'${process.execPath}' '${SCRIPT}' hook ${kind} ${event}${launched ? " --launch" : ""}`;
}

function renderMainPrompt() {
  const tool = `'${process.execPath}' '${SCRIPT}' tool`;
  return readFileSync(path.join(ROOT, "prompts", "main.md"), "utf8").replaceAll("{{TOOL}}", tool);
}

function launchArgs(role, kind, agentId, nativeSessionId) {
  if (kind === "claude") {
    const settings = { hooks: Object.fromEntries(HOOK_EVENTS.claude.map((e) => [e, [{ hooks: [{ type: "command", command: hookCommandLine("claude", e) }] }]])) };
    const settingsFile = path.join(LAUNCH_DIR, `${agentId}-settings.json`);
    writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2));
    const args = ["--dangerously-skip-permissions", "--session-id", nativeSessionId, "--settings", settingsFile];
    // Herdr 拒绝含换行的启动参数，角色说明经文件传入。
    if (role === "main") {
      const promptFile = path.join(LAUNCH_DIR, `${agentId}-prompt.md`);
      writeFileAtomic(promptFile, renderMainPrompt());
      args.push("--append-system-prompt-file", promptFile);
      // 主 agent 只通过 Bash 调用工具命令；去掉其余内置工具和用户的 MCP 工具，实测固定上下文可减少约四分之三。
      args.push("--tools", "Bash", "--strict-mcp-config");
      if (config.main.model) args.push("--model", config.main.model);
      if (config.main.effort) args.push("--effort", config.main.effort);
    } else {
      // 硬限制：AskUserQuestion 的选项主 agent 拿不到；接管的会话不重启，只靠 WORKER_ASK_NOTE。
      args.push("--disallowedTools", "AskUserQuestion");
    }
    return args;
  }
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  for (const e of HOOK_EVENTS.codex) {
    args.push("-c", `hooks.${e}=[{hooks=[{type="command",command=${JSON.stringify(hookCommandLine("codex", e))}}]}]`);
  }
  if (role === "main") {
    args.push("-c", `developer_instructions=${JSON.stringify(renderMainPrompt())}`);
    if (config.main.model) args.push("-m", config.main.model);
    if (config.main.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.main.effort)}`);
  }
  return args;
}

async function launchAgent(role, kind, cwd, displayName) {
  const agentId = randomUUID();
  const generation = 1;
  const nativeSessionId = kind === "claude" ? randomUUID() : null; // Codex 首轮输入时才有会话 ID
  const env = { VA_AGENT: `${agentId}:${generation}` };
  if (kind === "claude") env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  // 先登记再启动：SessionStart 可能在 herdr agent start 返回之前到达。
  const agent = {
    agentId, role, kind, nativeSessionId, generation, cwd, displayName,
    control: "managed", activity: "starting", activeSubmissionId: null,
    backendRef: null, released: false, sessionStarted: false, externalTurnKey: null, createdAt: now(),
  };
  S.agents[agentId] = agent;
  saveAgent(agent);
  commit();
  // 主 agent 独占一个 tab，不被工作 agent 的分屏压矮：pane 不足 12 行时 Claude Code 会把多行输入当成粘贴包起来。
  // 工作 agent 留在 daemon 所在的 tab：第一个在 daemon 右侧，之后接在最近启动的工作 agent 下方。
  const lastWorker = managedWorkers().filter((a) => !a.adopted && a.backendRef).at(-1);
  const r = await herdr.start({
    name: `va-${role}-${agentId.slice(0, 6)}`,
    kind,
    cwd,
    env,
    args: launchArgs(role, kind, agentId, nativeSessionId),
    newTab: role === "main",
    fromRef: lastWorker?.backendRef ?? null,
    direction: lastWorker ? "down" : "right",
  });
  agent.backendRef = r.backendRef ?? null;
  if (!r.ok) {
    agent.activity = "exited";
    agent.startError = r.reason;
    saveAgent(agent);
    commit();
    throw new ToolError("start_failed", r.reason);
  }
  agent.activity = "unknown";
  saveAgent(agent);
  commit();
  if (kind === "claude") {
    const deadline = Date.now() + SESSION_START_TIMEOUT_MS;
    while (!S.agents[agentId].sessionStarted) {
      if (Date.now() > deadline) {
        agent.activity = "exited";
        agent.startError = "没有收到 SessionStart Hook";
        saveAgent(agent);
        commit();
        throw new ToolError("start_failed", `${kind} 已启动但 ${SESSION_START_TIMEOUT_MS / 1000}s 内没有收到 SessionStart Hook`);
      }
      await sleep(200);
    }
  }
  const obs = await herdr.inspect(agent.backendRef, kind);
  if (obs.reachable && obs.present) {
    agent.activity = obs.activity;
    saveAgent(agent);
    commit();
  }
  return agent;
}

async function ensureMain(newMain) {
  const main = mainAgent();
  if (main && main.activity !== "exited") {
    const obs = await herdr.inspect(main.backendRef, main.kind);
    if (obs.reachable && obs.present && !(obs.nativeSessionId && main.nativeSessionId && obs.nativeSessionId !== main.nativeSessionId)) {
      notify("main", `沿用已有主 agent（${main.kind}）`);
      return;
    }
  }
  if (main && !newMain) {
    throw new Error("主 agent 已丢失或身份不一致；确认不再需要原会话后，用 `daemon --new-main` 启动新的主会话");
  }
  if (main) {
    main.activity = "exited";
    saveAgent(main);
    commit();
  }
  const agent = await launchAgent("main", config.main.kind, process.cwd(), "主助手");
  S.meta.main = { agentId: agent.agentId };
  save("meta", "main", S.meta.main);
  commit();
  notify("main", `主 agent（${agent.kind}）已就绪`);
}

// 崩溃恢复：prepared 之后是否写入未知，一律标为 unknown，不自动重发。
// 未播完的播报标为 unknown，不在重启后自动重播。
function recoverAfterReplay() {
  for (const sp of Object.values(S.speech)) {
    if (FINAL_SPEECH.has(sp.state)) continue;
    sp.state = "unknown";
    save("speech", sp.speechId, sp);
  }
  for (const sub of Object.values(S.subs)) {
    if (sub.status !== "prepared") continue;
    sub.status = "unknown";
    saveSub(sub);
    if (sub.taskId) markUncertain(S.tasks[sub.taskId], "delivery_unknown");
  }
  commit();
  for (const sub of Object.values(S.subs)) {
    if (sub.role === "main" && sub.status === "unknown" && S.agents[sub.agentId].activeSubmissionId === sub.id) {
      notify("dispatch", `dispatch ${sub.id} 投递结果不明；用控制台 /dispatch ${sub.id} handled|resubmit 处理`);
    }
  }
}

// ---------- 任务状态 ----------

function markUncertain(task, reason) {
  task.state = "uncertain";
  task.uncertainReason = reason;
  saveTask(task);
  enqueueUpdate(task, `任务进入 uncertain（${reason}）`);
}

// 取消请求发出后，即使暂时无法确认而进入 uncertain，之后的回合结束证据仍按取消处理。
const cancelRequested = (task) => task.state === "cancelling" || (task.state === "uncertain" && task.uncertainReason === "cancel_unconfirmed");

function closeRequest(task, state) {
  if (!task.pendingRequestId) return;
  const req = S.requests[task.pendingRequestId];
  req.state = state;
  saveReq(req);
  task.pendingRequestId = null;
}

function enqueueItem(item) {
  item.id ??= randomUUID();
  item.createdAt = now();
  item.status = "queued";
  item.seq = journalSeq + pendingOps.length + 1;
  S.inbox[item.id] = item;
  saveItem(item);
  return item;
}

// 同一任务尚未投递的状态通知只保留最新一条。
function enqueueUpdate(task, detail) {
  const queued = Object.values(S.inbox).find((i) => i.status === "queued" && i.type === "worker.task_update" && i.taskId === task.taskId);
  if (queued) {
    queued.detail = detail;
    saveItem(queued);
  } else {
    enqueueItem({ type: "worker.task_update", taskId: task.taskId, detail });
  }
  notify("task", `${task.title}：${detail}`, { taskId: task.taskId, state: task.state });
}

const WORKER_ASK_NOTE = "（语音助手约定：不要使用 AskUserQuestion 工具。需要用户决定时，在回复末尾用文本写出问题和编号选项，然后结束本轮。）";

async function sendToWorker(task, agent, text) {
  const sub = {
    id: randomUUID(), role: "worker", agentId: agent.agentId, taskId: task.taskId, generation: agent.generation,
    status: "prepared", createdAt: now(), turnKey: null, stop: null, bgTaskIds: [],
  };
  sub.text = `[voice-assistant submission=${sub.id}]\n${text}`;
  // AskUserQuestion 的选项只在 pane 里，Stop Hook 的最终消息拿不到，主 agent 无法转述。
  if (agent.kind === "claude") sub.text += `\n\n${WORKER_ASK_NOTE}`;
  S.subs[sub.id] = sub;
  agent.activeSubmissionId = sub.id;
  task.activeSubmissionId = sub.id;
  task.state = "dispatching";
  task.uncertainReason = null;
  saveSub(sub);
  saveAgent(agent);
  saveTask(task);
  commit();
  const r = await herdr.submit(agent.backendRef, sub.text);
  if (r.status === "written") {
    sub.status = "written";
    sub.writtenAt = Date.now();
    saveSub(sub);
  } else if (r.status === "rejected") {
    sub.status = "rejected";
    agent.activeSubmissionId = null;
    task.activeSubmissionId = null;
    task.state = "failed";
    task.failure = `输入被拒绝：${r.reason}`;
    saveSub(sub);
    saveAgent(agent);
    saveTask(task);
  } else {
    sub.status = "unknown";
    saveSub(sub);
    markUncertain(task, "delivery_unknown");
  }
  commit();
  return { delivery: sub.status, reason: r.reason };
}

// 一轮结束（已有可关联的 Stop 且后端观察到就绪）。
function endTurn(agent, sub) {
  sub.status = "turn_ended";
  sub.endedAt = now();
  agent.activeSubmissionId = null;
  saveSub(sub);
  saveAgent(agent);
  readySince.delete(agent.agentId);
  if (sub.role === "main") {
    const item = S.inbox[sub.inboxId];
    item.status = "done";
    saveItem(item);
    if (sub.stop.message) enqueueSpeech(sub.stop.message, sub.id);
    commit();
    if (sub.stop.message) notify("reply", sub.stop.message, { dispatchId: sub.id });
    else notify("dispatch", `主 agent 本轮${sub.stop.error ? "以原生错误结束" : "没有最终消息"}（dispatch ${sub.id}）`);
    setImmediate(pumpSpeech);
    const task = item.type === "worker.turn_ended" && S.tasks[item.taskId];
    if (task && task.state === "reviewing" && task.latestResultEventId === item.eventId) {
      notify("task", `${task.title}：结果尚未归类（主助手本轮没有调用 tasks.decide），任务保持 reviewing`, { taskId: task.taskId });
    }
    return;
  }
  const task = S.tasks[sub.taskId];
  task.activeSubmissionId = null;
  if (cancelRequested(task)) {
    task.state = "cancelled";
    task.uncertainReason = null;
    task.lateResultEventId = sub.stop.eventId;
    saveTask(task);
    enqueueUpdate(task, "回合已停止，任务已取消（收到的结果作为迟到事件保留）");
  } else if (!sub.stop.message && !sub.stop.error) {
    markUncertain(task, "result_missing");
  } else {
    closeRequest(task, "answered");
    task.state = "reviewing";
    task.uncertainReason = null;
    task.latestResultEventId = sub.stop.eventId;
    saveTask(task);
    enqueueItem({ type: "worker.turn_ended", taskId: task.taskId, eventId: sub.stop.eventId });
    notify("task", `${task.title}：工作 agent 本轮结束，等待主助手审阅`, { taskId: task.taskId, state: task.state });
  }
  commit();
}

// 回合就绪但始终没有可关联的 Stop：中断（Claude 无中断 Hook）或结果缺失。
function endTurnWithoutResult(agent, sub) {
  const task = sub.taskId && S.tasks[sub.taskId];
  if (task && !cancelRequested(task)) {
    // 结果缺失时保留回合关联：迟到的 Stop 仍可把任务转回 reviewing。
    sub.noResultAt = now();
    saveSub(sub);
    if (task.state === "waiting_terminal") {
      closeRequest(task, "withdrawn");
      markUncertain(task, "terminal_unresolved");
    } else if (task.state !== "uncertain") {
      markUncertain(task, "result_missing");
    }
    commit();
    return;
  }
  sub.status = "no_result";
  agent.activeSubmissionId = null;
  saveSub(sub);
  saveAgent(agent);
  readySince.delete(agent.agentId);
  if (sub.role === "main") {
    const item = S.inbox[sub.inboxId];
    item.status = "done";
    saveItem(item);
    commit();
    notify("dispatch", `主 agent 本轮结束但没有 Stop（可能被中断），dispatch ${sub.id} 无回复`);
    return;
  }
  task.activeSubmissionId = null;
  task.state = "cancelled";
  task.uncertainReason = null;
  saveTask(task);
  enqueueUpdate(task, "已确认回合停止，任务已取消");
  commit();
}

// ---------- Hook 事件处理 ----------

// 未受管会话的元数据事件：只记在内存里，用于确认该会话的全局 Hook 已生效，不写 journal。
const seenSessions = new Map();

// 全局 Hook 据此把被接管会话的事件写成完整事件。
function writeRegistry() {
  const reg = {};
  for (const a of Object.values(S.agents)) {
    if (a.adopted && watched(a) && a.nativeSessionId) reg[a.nativeSessionId] = { agentId: a.agentId, generation: a.generation };
  }
  writeFileAtomic(REGISTRY_PATH, JSON.stringify(reg));
}

function onHook(ev) {
  if (ev.metadata) {
    seenSessions.set(ev.payload.session_id, { kind: ev.kind, hookEvent: ev.hookEvent, at: ev.receivedAt });
    return;
  }
  if (S.events[ev.eventId]) return;
  save("events", ev.eventId, true);
  S.events[ev.eventId] = true;
  const agent = S.agents[ev.agentId];
  if (!agent || agent.generation !== ev.generation) {
    commit();
    notify("diag", `忽略不属于受管 agent 的 Hook 事件 ${ev.hookEvent}（${ev.kind}）`);
    return;
  }
  const p = ev.payload;
  if (agent.nativeSessionId === null && p.session_id) {
    agent.nativeSessionId = p.session_id;
    saveAgent(agent);
  } else if (p.session_id && p.session_id !== agent.nativeSessionId) {
    identityChanged(agent, `Hook 报告的会话 ${p.session_id} 与绑定的 ${agent.nativeSessionId} 不一致`);
    commit();
    return;
  }
  const key = agent.kind === "claude" ? p.prompt_id : p.turn_id;
  const sub = activeSub(agent);
  switch (ev.hookEvent) {
    case "SessionStart":
      agent.sessionStarted = true;
      saveAgent(agent);
      break;
    case "UserPromptSubmit":
      onPromptSubmit(agent, sub, key, p.prompt ?? "");
      break;
    case "Stop":
      onStop(agent, sub, key, ev);
      break;
    case "StopFailure":
      if (sub && sub.turnKey === key) {
        sub.stop = { eventId: ev.eventId, message: null, error: p, at: now() };
        storeResult(ev.eventId, { kind: agent.kind, error: p });
        saveSub(sub);
        if (agent.role === "main") {
          agent.control = "paused";
          saveAgent(agent);
          notify("control", `主 agent 遇到原生错误，已暂停自动派发；处理后用控制台 /resume ${agent.agentId} 恢复`);
        }
      }
      break;
    case "Interrupt":
      if (sub && sub.turnKey === key) {
        const task = sub.taskId && S.tasks[sub.taskId];
        if (task && cancelRequested(task)) {
          sub.status = "interrupted";
          agent.activeSubmissionId = null;
          task.activeSubmissionId = null;
          task.state = "cancelled";
          task.uncertainReason = null;
          saveSub(sub);
          saveAgent(agent);
          saveTask(task);
          enqueueUpdate(task, "已确认回合被中断，任务已取消");
        } else {
          sub.interrupted = true;
          saveSub(sub);
        }
      }
      break;
  }
  commit();
}

function onPromptSubmit(agent, sub, key, prompt) {
  if (sub && ["written", "unknown"].includes(sub.status) && prompt.includes(marker(sub))) {
    sub.status = "observed";
    sub.turnKey = key;
    sub.observedAt = now();
    saveSub(sub);
    const task = sub.taskId && S.tasks[sub.taskId];
    if (task && (task.state === "dispatching" || task.state === "uncertain")) {
      task.state = "running";
      task.uncertainReason = null;
      saveTask(task);
    }
    if (sub.role === "main" && sub.status === "observed") notify("dispatch", `主 agent 开始处理 dispatch ${sub.id}`);
    return;
  }
  // 后台任务完成后 CLI 自行发起的续轮，归入同一个 submission。
  if (sub && sub.bgTaskIds.length && prompt.startsWith("<task-notification>") && sub.bgTaskIds.some((id) => prompt.includes(`<task-id>${id}</task-id>`))) {
    sub.turnKey = key;
    sub.bgTaskIds = [];
    saveSub(sub);
    return;
  }
  agent.externalTurnKey = key;
  agent.externalTurnAt = now();
  if (agent.role === "worker") {
    agent.control = "paused";
    const task = sub && S.tasks[sub.taskId];
    if (task && !TERMINAL_STATES.has(task.state)) markUncertain(task, "external_input");
    notify("control", `工作 agent 出现非本系统发起的回合，已暂停自动控制；核验后用 agents.resume 或控制台 /resume ${agent.agentId} 恢复`);
  } else {
    notify("control", "主会话出现非本系统发起的回合，暂停投递，回合结束后自动恢复");
  }
  saveAgent(agent);
}

const marker = (sub) => (sub.role === "main" ? `dispatch=${sub.id}` : `submission=${sub.id}`);

function onStop(agent, sub, key, ev) {
  const p = ev.payload;
  if (agent.externalTurnKey && agent.externalTurnKey === key) {
    agent.externalTurnKey = null;
    saveAgent(agent);
    if (agent.role === "main") notify("control", "主会话外部回合结束，恢复投递");
    return;
  }
  if (!sub || sub.turnKey !== key) {
    storeResult(ev.eventId, { kind: agent.kind, message: p.last_assistant_message ?? null, unmatched: true });
    notify("diag", `收到无法关联的 Stop（${agent.role}），已保留为诊断记录 ${ev.eventId}`);
    return;
  }
  const bg = p.background_tasks ?? [];
  if (bg.length) {
    sub.bgTaskIds = bg.map((t) => t.id);
    sub.stop = null;
  } else {
    storeResult(ev.eventId, { kind: agent.kind, message: p.last_assistant_message ?? null });
    sub.stop = { eventId: ev.eventId, message: p.last_assistant_message || null, at: now() };
  }
  saveSub(sub);
  setImmediate(() => pollAgent(agent.agentId));
}

function storeResult(eventId, body) {
  writeFileAtomic(path.join(RESULTS_DIR, `${eventId}.json`), JSON.stringify({ eventId, ...body }));
}

function readResult(eventId) {
  return JSON.parse(readFileSync(path.join(RESULTS_DIR, `${eventId}.json`), "utf8"));
}

function identityChanged(agent, why) {
  agent.control = "paused";
  saveAgent(agent);
  const sub = activeSub(agent);
  const task = sub?.taskId && S.tasks[sub.taskId];
  if (task && !TERMINAL_STATES.has(task.state)) markUncertain(task, "session_lost");
  notify("control", `${agent.role} agent 身份变化，已暂停自动控制：${why}`);
}

let consuming = false;
function consumeSpool() {
  if (consuming) return;
  consuming = true;
  try {
    for (const name of readdirSync(SPOOL_DIR).filter((n) => n.endsWith(".json")).sort()) {
      const file = path.join(SPOOL_DIR, name);
      let ev;
      try {
        ev = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        ensureDir(path.join(SPOOL_DIR, "bad"));
        renameSync(file, path.join(SPOOL_DIR, "bad", name));
        notify("diag", `spool 文件 ${name} 无法解析，已移到 spool/bad：${e.message}`);
        continue;
      }
      onHook(ev);
      unlinkSync(file);
    }
  } finally {
    consuming = false;
  }
}

// ---------- 运行状态观察 ----------

async function pollAgent(agentId) {
  const agent = S.agents[agentId];
  if (!agent || agent.released || agent.activity === "exited" || agent.activity === "starting") return;
  const obs = await herdr.inspect(agent.backendRef, agent.kind);
  if (!obs.reachable) {
    notify("diag", `无法查询 ${agent.role} agent 状态：${obs.reason}`);
    return;
  }
  if (!obs.present) {
    agent.activity = "exited";
    saveAgent(agent);
    const sub = activeSub(agent);
    const task = sub?.taskId && S.tasks[sub.taskId];
    if (task && !TERMINAL_STATES.has(task.state)) markUncertain(task, "session_lost");
    commit();
    if (agent.adopted) writeRegistry();
    notify("control", agent.role === "main" ? "主 agent 已退出；停止自动派发" : "工作 agent 已退出");
    return;
  }
  if (obs.nativeSessionId && agent.nativeSessionId && obs.nativeSessionId !== agent.nativeSessionId) {
    if (agent.control === "managed") {
      identityChanged(agent, `Herdr 报告会话 ${obs.nativeSessionId}`);
      commit();
    }
    return;
  }
  if (agent.activity !== obs.activity) {
    agent.activity = obs.activity;
    saveAgent(agent);
  }
  if (obs.activity === "ready") {
    if (!readySince.has(agentId)) readySince.set(agentId, Date.now());
  } else {
    readySince.delete(agentId);
  }
  // 就绪时长只从当前回合（或外部回合）开始后算起，不继承上一段空闲。
  const readyAfter = (start) => (obs.activity === "ready" ? Date.now() - Math.max(readySince.get(agentId), start) : 0);
  const sub = activeSub(agent);

  if (agent.externalTurnKey && readyAfter(Date.parse(agent.externalTurnAt)) > STOP_GRACE_MS) {
    // 外部回合被中断时没有 Stop；就绪足够久即视为结束。
    agent.externalTurnKey = null;
    saveAgent(agent);
    if (agent.role === "main") notify("control", "主会话外部回合已结束，恢复投递");
  }

  const task = sub?.taskId && S.tasks[sub.taskId];
  if (task) trackTerminalState(agent, task, obs.activity);
  if (sub) {
    if (sub.status === "written" && readyAfter(sub.writtenAt) > DELIVERY_GRACE_MS) {
      sub.status = "unknown";
      saveSub(sub);
      if (task) markUncertain(task, "delivery_unknown");
      else notify("dispatch", `dispatch ${sub.id} 写入后没有观察到回合开始；用控制台 /dispatch ${sub.id} handled|resubmit 处理`);
    } else if (sub.status === "observed" && obs.activity === "ready") {
      if (sub.stop) {
        if (readyAfter(Date.parse(sub.stop.at)) >= STOP_SETTLE_MS) endTurn(agent, sub);
      }
      else if (!sub.bgTaskIds.length && !sub.noResultAt && readyAfter(Date.parse(sub.observedAt)) > STOP_GRACE_MS) endTurnWithoutResult(agent, sub);
    }
  }
  if (task && task.state === "cancelling" && Date.now() - task.cancelRequestedAt > CANCEL_TIMEOUT_MS) {
    markUncertain(task, "cancel_unconfirmed");
  }
  commit();
}

function trackTerminalState(agent, task, activity) {
  if (activity === "blocked" && (task.state === "running" || task.state === "dispatching")) {
    task.state = "waiting_terminal";
    const req = { requestId: randomUUID(), taskId: task.taskId, generation: agent.generation, type: "terminal_action", question: "工作 agent 的终端需要人工处理", sourceEventId: null, state: "open" };
    S.requests[req.requestId] = req;
    task.pendingRequestId = req.requestId;
    saveReq(req);
    saveTask(task);
    enqueueUpdate(task, "工作 agent 的终端出现原生交互，需要用户在对应 pane 处理");
  } else if (activity === "working" && task.state === "waiting_terminal") {
    closeRequest(task, "answered");
    task.state = "running";
    saveTask(task);
  }
}

// 有在途回合或外部回合的 agent 每轮都查（超时窗口靠它计时），其余低频兜底；
// 订阅事件到达时立即查对应 agent。
const lastPolled = new Map();
const watched = (a) => !a.released && a.activity !== "exited" && a.activity !== "starting";

async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    ensureSubscription();
    for (const a of Object.values(S.agents)) {
      if (!watched(a)) continue;
      if (!a.activeSubmissionId && !a.externalTurnKey && Date.now() - (lastPolled.get(a.agentId) ?? 0) < IDLE_POLL_MS) continue;
      lastPolled.set(a.agentId, Date.now());
      await pollAgent(a.agentId);
    }
    await scheduleMain();
  } catch (e) {
    fatal(e);
  } finally {
    polling = false;
  }
}

// ---------- Herdr 事件订阅 ----------

let unsubscribe = null;
let subscribedKey = null;
let herdrSynced = false; // 订阅建立并完成全量检查之前，暂停新的自动投递

function ensureSubscription() {
  const refs = Object.values(S.agents).filter(watched).map((a) => a.backendRef).sort();
  const key = refs.join("|");
  if (unsubscribe && key === subscribedKey) return;
  unsubscribe?.();
  subscribedKey = key;
  herdrSynced = false;
  unsubscribe = herdr.subscribe(refs, onBackendChange, (reason) => {
    unsubscribe = null;
    herdrSynced = false;
    notify("diag", `Herdr 事件订阅中断（${reason}），暂停新的自动投递并重新订阅`);
    setTimeout(() => {
      try { ensureSubscription(); } catch (e) { fatal(e); }
    }, 1000);
  });
}

async function onBackendChange(change) {
  try {
    if (change.reason === "started") {
      // 快照与事件没有共同序号：以订阅建立后的一次全量检查为准。
      for (const a of Object.values(S.agents)) if (watched(a)) await pollAgent(a.agentId);
      herdrSynced = true;
      await scheduleMain();
      return;
    }
    const agent = Object.values(S.agents).find((a) => a.backendRef === change.backendRef && watched(a));
    if (!agent) return;
    lastPolled.set(agent.agentId, Date.now());
    await pollAgent(agent.agentId);
    await scheduleMain();
  } catch (e) {
    fatal(e);
  }
}

// ---------- 主 agent 调度 ----------

function renderDispatch(item, dispatchId) {
  if (item.type === "user.message") {
    return `[voice-assistant dispatch=${dispatchId} message=${item.id} source=user]\n${item.text}`;
  }
  const task = S.tasks[item.taskId];
  const head = `[voice-assistant dispatch=${dispatchId} source=${item.type}]\n` +
    `task=${task.taskId} title=${JSON.stringify(task.title)} state=${task.state} revision=${task.revision} openRequest=${task.pendingRequestId ?? "none"}`;
  if (item.type === "worker.turn_ended") {
    const chars = (readResult(item.eventId).message ?? "").length;
    return `${head} resultEventId=${item.eventId} resultChars=${chars}\n工作 agent 的这一轮已结束。先用 tasks.get 读取结果原文，再用 tasks.decide 归类，最后给用户简短口播。`;
  }
  return `${head}\n${item.detail}`;
}

async function scheduleMain() {
  if (scheduling) return;
  const main = mainAgent();
  if (!herdrSynced || !main || main.control !== "managed" || main.activity !== "ready" || main.activeSubmissionId || main.externalTurnKey) return;
  const item = Object.values(S.inbox).filter((i) => i.status === "queued").sort((a, b) => a.seq - b.seq)[0];
  if (!item) return;
  scheduling = true;
  try {
    const obs = await herdr.inspect(main.backendRef, main.kind);
    if (!obs.reachable || !obs.present || obs.activity !== "ready") return;
    const sub = { id: randomUUID(), role: "main", agentId: main.agentId, inboxId: item.id, generation: main.generation, status: "prepared", createdAt: now(), turnKey: null, stop: null, bgTaskIds: [] };
    sub.text = renderDispatch(item, sub.id);
    S.subs[sub.id] = sub;
    item.status = "dispatched";
    main.activeSubmissionId = sub.id;
    saveSub(sub);
    saveItem(item);
    saveAgent(main);
    commit();
    const r = await herdr.submit(main.backendRef, sub.text);
    if (r.status === "written") {
      sub.status = "written";
      sub.writtenAt = Date.now();
    } else if (r.status === "rejected") {
      sub.status = "rejected";
      item.status = "queued";
      main.activeSubmissionId = null;
      saveItem(item);
      saveAgent(main);
      notify("dispatch", `主 agent 拒绝输入：${r.reason}；稍后重试`);
    } else {
      sub.status = "unknown";
      notify("dispatch", `dispatch ${sub.id} 写入结果不明：${r.reason}；用控制台 /dispatch ${sub.id} handled|resubmit 处理`);
    }
    saveSub(sub);
    commit();
  } finally {
    scheduling = false;
  }
}

// ---------- 语音：音频子进程与播报队列 ----------

// 音频进程由前台控制台（listen --voice）启动并经 socket 接入：macOS 不会为
// Herdr 后台服务里的进程弹麦克风授权，只有从有权限的终端 App 启动才能录音。
let audio = null; // { sock, ready, input, speaking }
const sendAudio = (cmd) => audio.sock.write(JSON.stringify(cmd) + "\n");
const FINAL_SPEECH = new Set(["played", "interrupted", "failed", "unknown", "stale", "skipped"]);

// 本轮通过 ask_user 打开的问题；播报前要核对它仍然开放。
function requestOpenedBy(dispatchId) {
  const op = Object.values(S.ops).find((o) => o.dispatchId === dispatchId && o.action === "tasks.decide" && o.result.task?.openRequest);
  return op ? op.result.task.openRequest.requestId : null;
}

function enqueueSpeech(text, dispatchId) {
  if (!config.voice) return;
  const sp = { speechId: randomUUID(), dispatchId, requestId: dispatchId ? requestOpenedBy(dispatchId) : null, text, state: "ready", createdAt: now() };
  S.speech[sp.speechId] = sp;
  save("speech", sp.speechId, sp);
}

// 只去掉残留的 Markdown 标记，不改写或删减文字。
const speakable = (text) => text.replace(/```[a-z]*|`|\*\*|__|^#+\s*|^>\s*|^\s*[-*]\s+/gm, "");

function pumpSpeech() {
  if (!audio?.ready || audio.speaking) return;
  const next = Object.values(S.speech).filter((s) => s.state === "ready").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!next) return;
  if (next.requestId && S.requests[next.requestId]?.state !== "open") {
    next.state = "stale";
    save("speech", next.speechId, next);
    commit();
    notify("voice", "相关问题已回答或撤回，跳过一条过时的播报");
    return pumpSpeech();
  }
  next.state = "sent";
  save("speech", next.speechId, next);
  commit();
  audio.speaking = next.speechId;
  sendAudio({ cmd: "speak", speechId: next.speechId, text: speakable(next.text) });
}

function setSpeechState(speechId, state, message) {
  const sp = S.speech[speechId];
  if (!sp) return;
  sp.state = state;
  if (state === "playing") sp.startedAt = now(); // 与 createdAt 之差即"回复就绪→开始播放"耗时
  save("speech", speechId, sp);
  commit();
  if (state === "failed") notify("voice", `播报失败：${message}；文字已显示，可用 /replay 重播`);
  if (FINAL_SPEECH.has(state) && audio?.speaking === speechId) {
    audio.speaking = null;
    setImmediate(pumpSpeech);
  }
}

const REJECT_REASONS = { no_speech: "没有听到说话", too_long: "这句话太长了，请分句再说", empty: "没有识别出内容，请重说或用文字输入" };

function onAudioEvent(ev) {
  switch (ev.event) {
    case "ready":
      audio.ready = true;
      audio.input = ev.input;
      notify("voice", `语音就绪：输入 ${ev.input ?? "无（不能唤醒和录音）"}，输出 ${ev.output}，唤醒短语「${ev.wakePhrase}」`);
      pumpSpeech();
      break;
    case "error":
      notify("voice", `音频错误（${ev.code}）：${ev.message}`);
      break;
    case "wake": {
      // 播报中唤醒即打断：音频进程已停止当前播放并清空其队列，这里丢弃尚未下发的普通回复，录音结束后不再接着播旧内容。
      // 关联 ask_user 问题的播报保留，录音结束后照常播放（播放前仍会核对问题是否开放）。
      if (!audio.speaking) {
        notify("voice", "已唤醒，请说话");
        break;
      }
      const pending = Object.values(S.speech).filter((s) => s.state === "ready" && !s.requestId);
      for (const sp of pending) {
        sp.state = "skipped";
        save("speech", sp.speechId, sp);
      }
      if (pending.length) commit();
      notify("voice", `已唤醒，停止播报${pending.length ? `并跳过 ${pending.length} 条待播内容（文字已显示）` : ""}，请说话`);
      break;
    }
    case "state":
      if (ev.state === "listening") notify("voice", "正在听…");
      break;
    case "utterance_rejected":
      notify("voice", REJECT_REASONS[ev.reason] ?? ev.reason);
      break;
    case "transcript": {
      const item = enqueueItem({ type: "user.message", text: ev.text, source: "voice" });
      commit();
      notify("heard", ev.text, { messageId: item.id, audioMs: ev.audioMs, asrMs: ev.asrMs });
      setImmediate(scheduleMain);
      break;
    }
    case "speech":
      if (ev.state === "playing") setSpeechState(ev.speechId, "playing");
      else setSpeechState(ev.speechId, ev.state, ev.message);
      break;
    default:
      notify("diag", `未知音频事件：${JSON.stringify(ev)}`);
  }
}

function attachAudio(sock) {
  if (!config.voice) throw new ToolError("voice_disabled", "配置中没有 voice 段");
  if (audio) throw new ToolError("audio_busy", "已有音频进程接入；同一时刻只接受一个");
  audio = { sock, ready: false, input: null, speaking: null };
  sock.isAudio = true;
  notify("voice", "音频进程已接入，正在加载模型");
}

function detachAudio(sock) {
  if (audio?.sock !== sock) return;
  const speaking = audio.speaking;
  audio = null;
  if (speaking) setSpeechState(speaking, "unknown");
  notify("voice", "音频进程已断开，语音不可用，文字控制台仍可使用");
}

function needAudio() {
  if (!config.voice) throw new ToolError("voice_disabled", "配置中没有 voice 段，只能用文字");
  if (!audio?.ready) throw new ToolError("voice_unavailable", "音频进程未就绪");
  return audio;
}

// ---------- 主 agent 工具 ----------

const SIDE_EFFECT_ACTIONS = new Set(["agents.start", "agents.adopt", "agents.release", "agents.pause", "agents.resume", "tasks.submit", "tasks.send", "tasks.decide", "tasks.reply", "tasks.cancel"]);

async function handleTool(action, input) {
  const handler = TOOLS[action];
  if (!handler) throw new ToolError("unknown_action", `未知 action：${action}`);
  if (!SIDE_EFFECT_ACTIONS.has(action)) return handler(input);

  const main = mainAgent();
  const sub = input.dispatchId && S.subs[input.dispatchId];
  if (!sub || sub.role !== "main" || main.activeSubmissionId !== sub.id || !["written", "observed"].includes(sub.status)) {
    throw new ToolError("not_active_dispatch", "dispatchId 不是当前在途的主 agent dispatch");
  }
  const obs = await herdr.inspect(main.backendRef, main.kind);
  if (!obs.present || obs.activity !== "working") throw new ToolError("not_active_dispatch", "主 agent 当前不在活动回合中");
  if (typeof input.operationId !== "string" || !input.operationId) throw new ToolError("bad_input", "缺少 operationId");

  const { dispatchId, operationId, ...args } = input;
  const digest = createHash("sha256").update(action + JSON.stringify(args)).digest("hex");
  const prior = S.ops[operationId];
  if (prior) {
    if (prior.digest !== digest) throw new ToolError("operation_conflict", "同一 operationId 已用于不同的请求");
    return prior.result;
  }
  const result = await handler(args, dispatchId);
  const op = { operationId, action, digest, dispatchId, result, at: now() };
  S.ops[operationId] = op;
  save("ops", operationId, op);
  commit();
  return result;
}

function needTask(taskId, expectedRevision) {
  const task = S.tasks[taskId];
  if (!task) throw new ToolError("not_found", `任务不存在：${taskId}`);
  if (expectedRevision !== undefined && expectedRevision !== task.revision) {
    throw new ToolError("revision_mismatch", "任务已变化，请基于最新状态重新判断", { task: taskView(task) });
  }
  return task;
}

function needText(v, field) {
  if (typeof v !== "string" || !v.trim()) throw new ToolError("bad_input", `缺少 ${field}`);
  return v;
}

async function needReadyWorker(agentId) {
  const agent = S.agents[agentId];
  if (!agent || agent.role !== "worker" || agent.released) throw new ToolError("not_found", `受管工作 agent 不存在：${agentId}`);
  if (agent.control !== "managed") throw new ToolError("agent_paused", "工作 agent 处于手动控制，需先核验并恢复");
  if (agent.activeSubmissionId) throw new ToolError("agent_busy", "工作 agent 还有未结束的回合");
  if (!herdrSynced) throw new ToolError("backend_resyncing", "Herdr 事件订阅正在恢复，暂停新的自动投递；稍后重试");
  const obs = await herdr.inspect(agent.backendRef, agent.kind);
  if (!obs.present) throw new ToolError("agent_exited", "工作 agent 已退出");
  if (obs.activity !== "ready") throw new ToolError("agent_busy", `工作 agent 当前状态为 ${obs.activity}`);
  return agent;
}

function taskView(task) {
  const req = task.pendingRequestId && S.requests[task.pendingRequestId];
  return {
    taskId: task.taskId, title: task.title, state: task.state, revision: task.revision,
    uncertainReason: task.uncertainReason, workerAgentId: task.workerAgentId,
    latestResultEventId: task.latestResultEventId, pendingInputs: task.pendingInputs.length,
    autoContinueCount: task.autoContinueCount, decision: task.decision ?? null,
    openRequest: req && req.state === "open" ? { requestId: req.requestId, type: req.type, question: req.question, options: req.options ?? null } : null,
  };
}

function agentView(a) {
  return { agentId: a.agentId, role: a.role, kind: a.kind, cwd: a.cwd, displayName: a.displayName, activity: a.activity, control: a.control, released: a.released };
}

function withPending(task, text) {
  const extra = task.pendingInputs.map((t) => `补充要求：${t}`);
  task.pendingInputs = [];
  return [text, ...extra].join("\n\n");
}

function dropPending(task) {
  const dropped = task.pendingInputs;
  task.pendingInputs = [];
  return dropped;
}

const TOOLS = {
  async "agents.list"() {
    const managedRefs = new Set(Object.values(S.agents).map((a) => a.backendRef));
    const candidates = (await herdr.discover()).filter((c) => !managedRefs.has(c.candidateRef));
    // 不列出主 agent 自己：实测 Sonnet 会把列表里的主 agent 当成工作 agent 汇报。
    // activeTaskId 让主 agent 在多个工作 agent 中挑出空闲的那个。
    const workers = managedWorkers().map((a) => {
      const task = Object.values(S.tasks).find((t) => t.workerAgentId === a.agentId && !TERMINAL_STATES.has(t.state));
      return { ...agentView(a), activeTaskId: task?.taskId ?? null };
    });
    return { workers, candidates };
  },

  async "agents.start"({ kind = config.worker.defaultKind, cwd, name }) {
    if (!KINDS.includes(kind)) throw new ToolError("bad_input", "kind 必须为 claude 或 codex");
    let real;
    try { real = realpathSync(needText(cwd, "cwd")); } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError("bad_input", `目录不存在：${cwd}`);
    }
    if (!config.allowedRoots.some((r) => real === r || real.startsWith(r + path.sep))) {
      throw new ToolError("cwd_not_allowed", `${real} 不在 projects.allowedRoots 内`);
    }
    checkWorkerLimit();
    const agent = await launchAgent("worker", kind, real, name || `${kind} 工作 agent`);
    notify("agent", `已启动工作 agent（${kind}，${real}）`);
    return { agent: agentView(agent) };
  },

  async "agents.release"({ agentId }) {
    const agent = S.agents[agentId];
    if (!agent || agent.role !== "worker" || agent.released) throw new ToolError("not_found", `受管工作 agent 不存在：${agentId}`);
    const unfinished = Object.values(S.tasks).find((t) => t.workerAgentId === agentId && !TERMINAL_STATES.has(t.state));
    if (unfinished) throw new ToolError("task_unfinished", `任务 ${unfinished.taskId} 尚未结束（${unfinished.state}）`);
    if (agent.activeSubmissionId) throw new ToolError("agent_busy", "工作 agent 还有未结束的回合");
    agent.released = true;
    saveAgent(agent);
    commit();
    if (agent.adopted) writeRegistry();
    return { released: agentId };
  },

  // 按设计第 5.3 节接管用户明确指定的既有会话；任一检查不通过都不接管。
  async "agents.adopt"({ candidateRef }) {
    const cand = (await herdr.discover()).find((c) => c.candidateRef === candidateRef);
    if (!cand) throw new ToolError("not_found", "找不到该候选会话，可能已退出；请重新 agents.list");
    if (cand.isCaller) throw new ToolError("not_adoptable", "这是 daemon 自己所在的会话，不能接管");
    if (Object.values(S.agents).some((a) => a.backendRef === candidateRef && watched(a))) throw new ToolError("already_managed", "该会话已经受管");
    if (!KINDS.includes(cand.kind)) throw new ToolError("unsupported_kind", `不支持接管 ${cand.kind}`);
    let real;
    try { real = realpathSync(cand.cwd); } catch { throw new ToolError("bad_input", `会话目录不存在：${cand.cwd}`); }
    if (!config.allowedRoots.some((r) => real === r || real.startsWith(r + path.sep))) throw new ToolError("cwd_not_allowed", `${real} 不在 projects.allowedRoots 内`);
    if (!cand.nativeSessionId) throw new ToolError("no_native_session", "Herdr 没有报告该会话的原生 session ID（Codex 需先信任 Herdr 的 Hook 并进行过一轮对话）");
    if (!seenSessions.has(cand.nativeSessionId)) {
      throw new ToolError("hook_not_verified", "还没收到该会话的 Hook 事件，无法确认 Hook 已生效；请在该会话里进行一轮对话（Codex 需先用 /hooks 信任），再重试");
    }
    const obs = await herdr.inspect(candidateRef, cand.kind);
    if (!obs.present || obs.activity !== "ready") throw new ToolError("agent_busy", `该会话当前状态为 ${obs.activity}；空闲且没有原生弹窗时才能接管`);
    checkWorkerLimit(); // 放在最后一次 await 之后，与登记之间没有让出点
    const agent = {
      agentId: randomUUID(), role: "worker", kind: cand.kind, nativeSessionId: cand.nativeSessionId, generation: 1, cwd: real,
      displayName: `接管的 ${cand.kind} 会话`, control: "managed", activity: "ready", activeSubmissionId: null,
      backendRef: candidateRef, released: false, sessionStarted: true, externalTurnKey: null, adopted: true, createdAt: now(),
    };
    S.agents[agent.agentId] = agent;
    saveAgent(agent);
    commit();
    writeRegistry();
    notify("agent", `已接管 ${cand.kind} 会话（${real}）`);
    return { agent: agentView(agent) };
  },

  async "agents.pause"({ agentId }) {
    const agent = S.agents[agentId];
    if (!agent || agent.role !== "worker") throw new ToolError("not_found", `工作 agent 不存在：${agentId}`);
    agent.control = "paused";
    saveAgent(agent);
    commit();
    return { agent: agentView(agent) };
  },

  async "agents.resume"({ agentId }) {
    return { agent: agentView(await resumeAgent(agentId)) };
  },

  async "tasks.submit"({ agentId, originMessageId, title, text }, dispatchId) {
    const origin = S.inbox[originMessageId];
    if (!origin || origin.type !== "user.message") throw new ToolError("bad_input", "originMessageId 必须是本轮用户消息的 message id");
    // 同一轮可为一条消息建多个任务；消息被重新投递（resubmit）后的新一轮不能再建。
    const dup = Object.values(S.tasks).find((t) => t.originMessageId === originMessageId && t.dispatchId !== dispatchId);
    if (dup) throw new ToolError("duplicate_origin", "该用户消息已在之前的一轮建过任务", { task: taskView(dup) });
    const agent = await needReadyWorker(agentId);
    const unfinished = Object.values(S.tasks).find((t) => t.workerAgentId === agentId && !TERMINAL_STATES.has(t.state));
    if (unfinished) throw new ToolError("task_unfinished", `工作 agent 已有未结束的任务 ${unfinished.taskId}`, { task: taskView(unfinished) });
    const task = {
      taskId: randomUUID(), conversationId: "default", originMessageId, dispatchId, workerAgentId: agentId,
      title: needText(title, "title"), state: "dispatching", revision: 0, activeSubmissionId: null,
      pendingRequestId: null, latestResultEventId: null, autoContinueCount: 0, uncertainReason: null,
      pendingInputs: [], createdAt: now(),
    };
    S.tasks[task.taskId] = task;
    const delivery = await sendToWorker(task, agent, needText(text, "text"));
    return { task: taskView(task), ...delivery };
  },

  async "tasks.send"({ taskId, expectedRevision, text }) {
    const task = needTask(taskId, expectedRevision);
    if (task.state === "waiting_user") throw new ToolError("use_reply", "任务正在等待用户回答问题；用 tasks.reply 回答，或先取消任务");
    if (TERMINAL_STATES.has(task.state) || task.state === "uncertain" || task.state === "cancelling") {
      throw new ToolError("bad_state", `任务处于 ${task.state}，不能追加输入`);
    }
    task.pendingInputs.push(needText(text, "text"));
    task.autoContinueCount = 0;
    saveTask(task);
    commit();
    return { queued: true, task: taskView(task), note: "已排队，未转达；工作 agent 本轮结束后随下一轮投递" };
  },

  async "tasks.get"({ taskId, offset = 0, limit = 4000 }) {
    const task = needTask(taskId);
    const view = taskView(task);
    if (!task.latestResultEventId) return { task: view, result: null };
    const res = readResult(task.latestResultEventId);
    const text = res.message ?? "";
    const slice = text.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    return {
      task: view,
      result: { eventId: res.eventId, nativeError: res.error ?? null, totalChars: text.length, offset, text: slice, nextOffset, complete: nextOffset >= text.length },
    };
  },

  async "tasks.decide"({ taskId, expectedRevision, sourceEventId, decision, text, question, options, summary }) {
    const task = needTask(taskId, expectedRevision);
    if (task.state !== "reviewing" || task.latestResultEventId !== sourceEventId) {
      throw new ToolError("not_pending_result", "sourceEventId 不是该任务当前待处理的结果", { task: taskView(task) });
    }
    if (decision === "complete" || decision === "fail") {
      task.state = decision === "complete" ? "completed" : "failed";
      task.decision = { decision, summary: needText(summary, "summary"), sourceEventId };
      const dropped = dropPending(task);
      saveTask(task);
      commit();
      return { task: taskView(task), droppedInputs: dropped };
    }
    if (decision === "ask_user") {
      const req = { requestId: randomUUID(), taskId, generation: S.agents[task.workerAgentId].generation, type: "question", question: needText(question, "question"), options: options ?? null, sourceEventId, state: "open" };
      S.requests[req.requestId] = req;
      task.state = "waiting_user";
      task.pendingRequestId = req.requestId;
      saveReq(req);
      saveTask(task);
      commit();
      return { task: taskView(task) };
    }
    if (decision === "continue") {
      const hasUserInput = task.pendingInputs.length > 0;
      if (!hasUserInput && task.autoContinueCount >= config.worker.maxAutoContinue) {
        throw new ToolError("auto_continue_limit", `已连续自动继续 ${task.autoContinueCount} 次；请向用户提问或给出结论`);
      }
      const agent = await needReadyWorker(task.workerAgentId);
      task.autoContinueCount = hasUserInput ? 0 : task.autoContinueCount + 1;
      const delivery = await sendToWorker(task, agent, withPending(task, needText(text, "text")));
      return { task: taskView(task), ...delivery };
    }
    throw new ToolError("bad_input", "decision 必须为 complete、fail、ask_user 或 continue");
  },

  async "tasks.reply"({ requestId, expectedRevision, answer }) {
    const req = S.requests[requestId];
    if (!req || req.type !== "question") throw new ToolError("not_found", `问题不存在：${requestId}`);
    const task = needTask(req.taskId, expectedRevision);
    if (req.state !== "open" || task.state !== "waiting_user" || task.pendingRequestId !== requestId) {
      throw new ToolError("request_closed", "该问题已撤回或已回答，不能转达旧回答", { task: taskView(task) });
    }
    const agent = await needReadyWorker(task.workerAgentId);
    if (agent.generation !== req.generation) throw new ToolError("request_closed", "工作会话已变化，问题失效");
    closeRequest(task, "answered");
    task.autoContinueCount = 0;
    const delivery = await sendToWorker(task, agent, withPending(task, needText(answer, "answer")));
    return { task: taskView(task), ...delivery };
  },

  async "tasks.cancel"({ taskId, expectedRevision }) {
    return cancelTask(needTask(taskId, expectedRevision));
  },
};

async function cancelTask(task) {
  if (TERMINAL_STATES.has(task.state) || task.state === "cancelling") throw new ToolError("bad_state", `任务处于 ${task.state}`);
  const dropped = dropPending(task);
  if (task.state === "waiting_user" || task.state === "reviewing") {
    closeRequest(task, "withdrawn");
    task.state = "cancelled";
    saveTask(task);
    commit();
    return { task: taskView(task), droppedInputs: dropped, stopped: "no_running_turn" };
  }
  if (task.state === "uncertain") throw new ToolError("bad_state", "任务处于 uncertain；在控制台用 /resolve 处理");
  closeRequest(task, "withdrawn");
  task.state = "cancelling";
  task.cancelRequestedAt = Date.now();
  saveTask(task);
  commit();
  const worker = S.agents[task.workerAgentId];
  const r = await herdr.cancel(worker.backendRef, worker.kind);
  notify("task", `${task.title}：已请求中断（${r.status}）`, { taskId: task.taskId });
  return { task: taskView(task), droppedInputs: dropped, interrupt: r.status, note: "已请求停止，确认停止后才会标为 cancelled" };
}

async function resumeAgent(agentId) {
  const agent = S.agents[agentId];
  if (!agent || agent.released) throw new ToolError("not_found", `agent 不存在：${agentId}`);
  const obs = await herdr.inspect(agent.backendRef, agent.kind);
  if (!obs.present) throw new ToolError("agent_exited", "agent 已退出");
  if (obs.nativeSessionId && agent.nativeSessionId && obs.nativeSessionId !== agent.nativeSessionId) throw new ToolError("identity_mismatch", "会话身份已变化，不能恢复");
  if (obs.activity !== "ready") throw new ToolError("agent_busy", `agent 当前状态为 ${obs.activity}，空闲后再恢复`);
  agent.control = "managed";
  agent.externalTurnKey = null;
  saveAgent(agent);
  commit();
  return agent;
}

// ---------- 控制台方法（用户确定性操作） ----------

const CONSOLE = {
  async "console.send"({ text }) {
    const item = enqueueItem({ type: "user.message", text: needText(text, "text") });
    commit();
    const position = Object.values(S.inbox).filter((i) => i.status === "queued").length;
    setImmediate(scheduleMain);
    return { messageId: item.id, position };
  },

  async "voice.listen"() {
    needAudio();
    sendAudio({ cmd: "listen" });
    return { listening: true };
  },

  // 停止播放由 daemon 直接处理，不经过主 agent，也不影响任务。
  async "voice.stop"() {
    needAudio();
    sendAudio({ cmd: "stop_playback" });
    return { stopped: true };
  },

  async "speech.replay"() {
    needAudio();
    const last = Object.values(S.speech).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!last) throw new ToolError("not_found", "还没有可重播的内容");
    enqueueSpeech(last.text, null);
    commit();
    pumpSpeech();
    return { replaying: last.text };
  },

  async status() {
    return {
      voice: config.voice ? (audio ? { ready: audio.ready, input: audio.input, speaking: audio.speaking } : "unavailable") : "disabled",
      agents: Object.values(S.agents).filter((a) => !a.released && a.activity !== "exited").map(agentView),
      tasks: Object.values(S.tasks).filter((t) => !TERMINAL_STATES.has(t.state)).map(taskView),
      queued: Object.values(S.inbox).filter((i) => i.status === "queued").length,
      activeDispatch: mainAgent()?.activeSubmissionId ?? null,
    };
  },

  async "task.cancel"({ taskId }) {
    const task = needTask(taskId);
    const result = await cancelTask(task);
    // 主助手不知道控制台操作，用状态通知告知它，避免继续追问已撤回的问题。
    enqueueUpdate(task, task.state === "cancelled" ? "用户在控制台取消了任务，待回答的问题已撤回" : "用户在控制台请求取消任务，等待确认停止");
    commit();
    return result;
  },

  // 只能由用户执行：把 uncertain 任务确认为 cancelled 或 failed。
  async "task.resolve"({ taskId, to }) {
    const task = needTask(taskId);
    if (task.state !== "uncertain") throw new ToolError("bad_state", `任务处于 ${task.state}，不是 uncertain`);
    if (to !== "cancelled" && to !== "failed") throw new ToolError("bad_input", "to 必须为 cancelled 或 failed");
    const agent = S.agents[task.workerAgentId];
    const sub = task.activeSubmissionId && S.subs[task.activeSubmissionId];
    if (sub) {
      sub.status = "abandoned";
      saveSub(sub);
      if (agent.activeSubmissionId === sub.id) {
        agent.activeSubmissionId = null;
        saveAgent(agent);
      }
    }
    task.activeSubmissionId = null;
    task.state = to;
    task.decision = { decision: to, summary: `用户在控制台确认（原因：${task.uncertainReason}）` };
    task.uncertainReason = null;
    dropPending(task);
    saveTask(task);
    enqueueUpdate(task, `用户在控制台把 uncertain 任务确认为 ${to}`);
    commit();
    return { task: taskView(task) };
  },

  async "dispatch.resolve"({ dispatchId, action }) {
    const sub = S.subs[dispatchId];
    const main = mainAgent();
    if (!sub || sub.role !== "main" || sub.status !== "unknown" || main.activeSubmissionId !== sub.id) {
      throw new ToolError("bad_state", "该 dispatch 不是待处理的未知投递");
    }
    if (action !== "handled" && action !== "resubmit") throw new ToolError("bad_input", "action 必须为 handled 或 resubmit");
    sub.status = "abandoned";
    main.activeSubmissionId = null;
    const item = S.inbox[sub.inboxId];
    item.status = action === "resubmit" ? "queued" : "done";
    saveSub(sub);
    saveAgent(main);
    saveItem(item);
    commit();
    setImmediate(scheduleMain);
    return { dispatchId, action };
  },

  async "agent.pause"({ agentId }) {
    const agent = S.agents[agentId];
    if (!agent) throw new ToolError("not_found", `agent 不存在：${agentId}`);
    agent.control = "paused";
    saveAgent(agent);
    commit();
    return { agent: agentView(agent) };
  },

  async "agent.resume"({ agentId }) {
    return { agent: agentView(await resumeAgent(agentId)) };
  },
};

function serve() {
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); // 已持有实例锁，旧 socket 必为残留
  const server = net.createServer((sock) => {
    let buf = "";
    const closed = () => {
      watchers.delete(sock);
      detachAudio(sock);
    };
    sock.on("error", closed);
    sock.on("close", closed);
    sock.on("data", async (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        // 接入后的音频连接只传事件，不再是请求。
        if (!sock.isAudio) await respond(sock, line);
        else {
          try {
            onAudioEvent(JSON.parse(line));
          } catch (e) {
            fatal(e);
          }
        }
      }
    });
  });
  server.listen(SOCKET_PATH, () => chmodSync(SOCKET_PATH, 0o600));
}

async function respond(sock, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return sock.write(JSON.stringify({ ok: false, error: { code: "bad_request", message: "请求不是 JSON" } }) + "\n");
  }
  const reply = (body) => sock.write(JSON.stringify({ rpcId: req.rpcId, ...body }) + "\n");
  if (req.protocolVersion !== PROTOCOL_VERSION) return reply({ ok: false, error: { code: "bad_version", message: `协议版本必须为 ${PROTOCOL_VERSION}` } });
  try {
    if (req.method === "watch") {
      watchers.add(sock);
      return reply({ ok: true, result: { watching: true } });
    }
    if (req.method === "audio.attach") {
      attachAudio(sock);
      return reply({ ok: true, result: { attached: true, voice: config.voice } });
    }
    let result;
    if (req.method === "tool") result = await handleTool(req.params.action, req.params.input ?? {});
    else if (CONSOLE[req.method]) result = await CONSOLE[req.method](req.params ?? {});
    else throw new ToolError("unknown_method", `未知方法：${req.method}`);
    reply({ ok: true, result });
  } catch (e) {
    if (e instanceof ToolError) return reply({ ok: false, error: { code: e.code, message: e.message, ...e.extra } });
    reply({ ok: false, error: { code: "internal", message: e.message } });
    fatal(e);
  }
}

function acquireLock() {
  try {
    const fd = openSync(LOCK_PATH, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const pid = Number(readFileSync(LOCK_PATH, "utf8"));
  try {
    process.kill(pid, 0);
    throw new Error(`已有 daemon 实例在运行（pid ${pid}）`);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  unlinkSync(LOCK_PATH);
  acquireLock();
}

function releaseLock() {
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(LOCK_PATH); } catch {}
}

function fatal(e) {
  process.stderr.write(`daemon 致命错误，停止运行：${e.stack || e.message}\n`);
  releaseLock();
  process.exit(1);
}

async function daemonCommand(flags) {
  herdr.assertAvailable();
  config = loadConfig();
  await herdr.serverStatus();
  for (const d of [STATE_DIR, SPOOL_DIR, RESULTS_DIR, LAUNCH_DIR]) ensureDir(d);
  chmodSync(STATE_DIR, 0o700);
  acquireLock();
  process.on("SIGINT", () => { releaseLock(); process.exit(0); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
  try {
    const notice = loadJournal();
    if (notice) notify("diag", notice);
    journalFd = openSync(JOURNAL_PATH, "a", 0o600);
    recoverAfterReplay();
    writeRegistry();
    serve();
    consumeSpool();
    watch(SPOOL_DIR, () => { try { consumeSpool(); } catch (e) { fatal(e); } });
    setInterval(() => { try { consumeSpool(); } catch (e) { fatal(e); } }, 500);
    if (config.voice) notify("voice", "等待音频进程接入：在有麦克风权限的终端（不在 Herdr 内）运行 `node src/main.mjs listen --voice`");
    else notify("voice", "配置中没有 voice 段，只使用文字控制台");
    await ensureMain(flags.includes("--new-main"));
    setInterval(pollAll, POLL_MS);
    notify("daemon", `就绪；用 \`node ${path.relative(process.cwd(), SCRIPT) || SCRIPT} listen\` 打开控制台`);
  } catch (e) {
    releaseLock();
    throw e;
  }
}

// ---------- 控制台 ----------

const HELP = `输入文字直接发给主助手；直接回车开始录一句话（会先停止正在播放的内容）。命令：
  /stop                           停止当前播放（不影响任务）
  /replay                         重播最近一条回复
  /status                         查看语音、agent、未结束任务和排队情况
  /cancel <taskId>                取消任务
  /resolve <taskId> cancelled|failed   确认 uncertain 任务的结局
  /dispatch <dispatchId> handled|resubmit   处理投递结果不明的 dispatch
  /pause <agentId>  /resume <agentId>
  /quit                           退出控制台（不影响 daemon 和 agent）`;

// 在当前终端启动音频进程并经 socket 接入 daemon；麦克风权限归属于当前终端 App。
async function startAudioBridge() {
  const python = path.join(ROOT, "audio", ".venv", "bin", "python");
  if (!existsSync(python)) throw new Error(`缺少音频环境 ${python}；按 audio/requirements.txt 创建虚拟环境`);
  const sock = net.createConnection(SOCKET_PATH);
  const lines = readline.createInterface({ input: sock });
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", (e) => reject(new Error(`无法连接 daemon：${e.message}`)));
  });
  sock.write(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, rpcId: "audio", method: "audio.attach" }) + "\n");
  const iter = lines[Symbol.asyncIterator]();
  const reply = JSON.parse((await iter.next()).value);
  if (!reply.ok) throw new Error(`音频接入被拒绝：${reply.error.message}`);

  const proc = spawn(python, ["-I", path.join(ROOT, "audio", "voice.py"), JSON.stringify(reply.result.voice)], { stdio: ["pipe", "pipe", "pipe"] });
  const stderrTail = [];
  readline.createInterface({ input: proc.stdout }).on("line", (line) => sock.write(line + "\n"));
  readline.createInterface({ input: proc.stderr }).on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > 20) stderrTail.shift();
  });
  proc.on("exit", (code, signal) => {
    process.stdout.write(`\n音频进程已退出（${signal ?? code}）${stderrTail.length ? `：\n${stderrTail.join("\n")}` : ""}\n> `);
    sock.end();
  });
  sock.on("close", () => proc.kill());
  (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => iter }) proc.stdin.write(line + "\n");
  })();
}

async function listenCommand(flags) {
  if (flags.includes("--voice")) await startAudioBridge();
  const sock = net.createConnection(SOCKET_PATH);
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", (e) => reject(new Error(`无法连接 daemon：${e.message}`)));
  });
  sock.write(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, rpcId: "watch", method: "watch" }) + "\n");
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.rpcId === "watch") continue;
      const prefix = { reply: "主助手", heard: "你说", voice: "语音" }[msg.type] ?? msg.type;
      process.stdout.write(`\n[${msg.at.slice(11, 19)}] ${prefix}：${msg.text}\n> `);
    }
  });
  sock.on("close", () => { process.stdout.write("\ndaemon 连接已断开\n"); process.exit(1); });
  process.stdout.write(HELP + "\n> ");
  const rl = readline.createInterface({ input: process.stdin });
  for await (const raw of rl) {
    const line = raw.trim();
    const [cmd, a, b] = line.split(/\s+/);
    let res;
    try {
      if (!line) res = await rpc("voice.listen", {});
      else if (cmd === "/quit") process.exit(0);
      else if (cmd === "/stop") res = await rpc("voice.stop", {});
      else if (cmd === "/replay") res = await rpc("speech.replay", {});
      else if (cmd === "/status") res = await rpc("status", {});
      else if (cmd === "/cancel") res = await rpc("task.cancel", { taskId: a });
      else if (cmd === "/resolve") res = await rpc("task.resolve", { taskId: a, to: b });
      else if (cmd === "/dispatch") res = await rpc("dispatch.resolve", { dispatchId: a, action: b });
      else if (cmd === "/pause") res = await rpc("agent.pause", { agentId: a });
      else if (cmd === "/resume") res = await rpc("agent.resume", { agentId: a });
      else if (cmd.startsWith("/")) { process.stdout.write(HELP + "\n> "); continue; }
      else {
        res = await rpc("console.send", { text: line });
        if (res.ok) { process.stdout.write(`已收到，等待主助手处理（队列第 ${res.result.position} 位）\n> `); continue; }
      }
    } catch (e) {
      res = { ok: false, error: { message: e.message } };
    }
    process.stdout.write((res.ok ? JSON.stringify(res.result, null, 2) : `错误：${res.error.message}`) + "\n> ");
  }
}

// ---------- 入口 ----------

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "daemon") await daemonCommand(rest);
  else if (cmd === "listen") await listenCommand(rest);
  else if (cmd === "tool" && rest[0]) await toolCommand(rest[0]);
  else if (cmd === "hook" && KINDS.includes(rest[0]) && rest[1]) hookCommand(rest[0], rest[1], rest.slice(2));
  else if (cmd === "install-hooks") installHooks();
  else {
    process.stderr.write("用法：voice-assistant daemon [--new-main] | listen [--voice] | tool <action> | hook <claude|codex> <event> | install-hooks\n");
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}

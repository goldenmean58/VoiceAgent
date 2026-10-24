// Herdr 后端：只向应用暴露 discover/start/inspect/submit/cancel。
// pane、terminal、agent 名称和 Herdr 错误码都留在本文件内；backendRef 对业务代码不透明。
import { execFile } from "node:child_process";
import net from "node:net";
import readline from "node:readline";

function run(args, { timeoutMs = 30000, json = true } = {}) {
  return new Promise((resolve) => {
    execFile("herdr", args, { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (!err) {
        if (!json) return resolve({ ok: true, text: stdout });
        try {
          return resolve({ ok: true, result: JSON.parse(stdout).result });
        } catch {
          return resolve({ ok: false, code: "bad_output", message: `herdr ${args.slice(0, 2).join(" ")} 输出不是 JSON` });
        }
      }
      if (err.killed) return resolve({ ok: false, code: "timeout", message: `herdr ${args.slice(0, 2).join(" ")} 超时` });
      try {
        const e = JSON.parse(stderr).error;
        return resolve({ ok: false, code: e.code, message: e.message });
      } catch {
        return resolve({ ok: false, code: "error", message: (stderr || err.message).trim() });
      }
    });
  });
}

function activityOf(status) {
  if (status === "idle" || status === "done") return "ready";
  if (status === "working") return "working";
  if (status === "blocked") return "blocked";
  return "unknown";
}

function observe(pane, kind) {
  const present = pane.agent === kind;
  return {
    present,
    activity: present ? activityOf(pane.agent_status) : "exited",
    nativeSessionId: pane.agent_session?.value ?? null,
    completionSeq: pane.completion_seq ?? null,
  };
}

export function assertAvailable() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) {
    throw new Error("必须在 Herdr 管理的 pane 中运行（HERDR_ENV=1，且有 HERDR_PANE_ID 和 HERDR_SOCKET_PATH）");
  }
}

// 订阅这些 agent 的状态变化以及全局 pane 退出/关闭。事件不持久、没有与快照共享的序号，
// 只作为"需要重新检查"的信号：onChange({ reason: "started" }) 表示订阅已建立，调用方应全量
// 重新检查；onChange({ backendRef }) 表示该对象可能变化；onClose(reason) 后订阅失效。
export function subscribe(backendRefs, onChange, onClose) {
  const byPane = new Map(backendRefs.map((ref) => [JSON.parse(ref).paneId, ref]));
  const sock = net.createConnection(process.env.HERDR_SOCKET_PATH);
  let closedReason = "connection_closed";
  sock.on("connect", () => {
    const subscriptions = [...byPane.keys()].map((pane_id) => ({ type: "pane.agent_status_changed", pane_id }));
    subscriptions.push({ type: "pane.exited" }, { type: "pane.closed" }, { type: "pane.agent_detected" });
    sock.write(JSON.stringify({ id: "va-sub", method: "events.subscribe", params: { subscriptions } }) + "\n");
  });
  readline.createInterface({ input: sock }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.error) {
      closedReason = msg.error.code;
      return;
    }
    if (msg.result?.type === "subscription_started") return onChange({ reason: "started" });
    const ref = byPane.get(msg.data?.pane_id);
    if (ref) onChange({ backendRef: ref, reason: msg.event });
  });
  sock.on("error", (e) => (closedReason = e.code || e.message));
  sock.on("close", () => onClose(closedReason));
  return () => {
    sock.removeAllListeners("close");
    sock.destroy();
  };
}

export async function serverStatus() {
  const r = await run(["status"], { json: false });
  if (!r.ok) throw new Error(`herdr status 失败：${r.message}`);
  if (!/server:\s*\n\s*status:\s*running/.test(r.text)) throw new Error("Herdr 服务器未运行");
  if (/endpoint_compatible:\s*no/.test(r.text)) throw new Error("Herdr 客户端与服务器不兼容");
}

export async function discover() {
  const r = await run(["agent", "list"]);
  if (!r.ok) throw new Error(`herdr agent list 失败：${r.message}`);
  return r.result.agents.map((a) => ({
    candidateRef: JSON.stringify({ paneId: a.pane_id, terminalId: a.terminal_id }),
    kind: a.agent,
    nativeSessionId: a.agent_session?.value ?? null,
    cwd: a.cwd,
    activity: activityOf(a.agent_status),
    isCaller: a.pane_id === process.env.HERDR_PANE_ID, // daemon 自己所在的 pane，不能被接管
  }));
}

// 在 fromRef（或当前 pane）旁新建 pane 并启动 agent。成功返回 backendRef；
// 启动后停在原生交互界面（信任确认、Hook 审核）时返回 ok:false 并说明原因，pane 保留供用户查看。
export async function start({ name, kind, cwd, env, args, fromRef, direction }) {
  const from = fromRef ? JSON.parse(fromRef).paneId : process.env.HERDR_PANE_ID;
  const splitArgs = ["pane", "split", from, "--direction", direction, "--cwd", cwd, "--no-focus"];
  for (const [k, v] of Object.entries(env)) splitArgs.push("--env", `${k}=${v}`);
  const split = await run(splitArgs);
  if (!split.ok) return { ok: false, reason: `创建 pane 失败：${split.message}` };
  const pane = split.result.pane;
  const backendRef = JSON.stringify({ paneId: pane.pane_id, terminalId: pane.terminal_id });

  // 新 pane 的 shell 初始化完成前，Herdr 返回 agent_pane_busy 且不发送任何输入；等它进入提示符。
  let started;
  for (const deadline = Date.now() + 20000; ;) {
    started = await run(["agent", "start", name, "--kind", kind, "--pane", pane.pane_id, "--timeout", "60000", "--", ...args], { timeoutMs: 70000 });
    if (started.ok || started.code !== "agent_pane_busy" || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!started.ok) {
    const screen = await readScreen(backendRef);
    if (/trust this folder/i.test(screen)) {
      return { ok: false, backendRef, reason: `${kind} 要求先信任目录 ${cwd}；请在 pane ${pane.pane_id} 中确认后重试` };
    }
    return { ok: false, backendRef, reason: `启动 ${kind} 失败（${started.code}）：${started.message}` };
  }
  // Herdr 把 Codex 的 Hook 审核界面报告为 idle，只能在启动诊断时读屏识别。
  if (kind === "codex" && /Hooks need review/i.test(await readScreen(backendRef))) {
    return { ok: false, backendRef, reason: `Codex 的 Hook 尚未信任；请在 pane ${pane.pane_id} 中用 /hooks 信任后重试` };
  }
  return { ok: true, backendRef };
}

async function readScreen(backendRef) {
  const r = await run(["agent", "read", JSON.parse(backendRef).paneId, "--source", "detection", "--lines", "40"], { json: false });
  return r.ok ? r.text : "";
}

export async function inspect(backendRef, kind) {
  const { paneId, terminalId } = JSON.parse(backendRef);
  const r = await run(["pane", "get", paneId]);
  if (!r.ok) {
    if (r.code === "pane_not_found") return { reachable: true, present: false, activity: "exited", nativeSessionId: null, completionSeq: null };
    return { reachable: false, reason: r.message };
  }
  if (r.result.pane.terminal_id !== terminalId) return { reachable: true, present: false, activity: "exited", nativeSessionId: null, completionSeq: null };
  return { reachable: true, ...observe(r.result.pane, kind) };
}

// 只确认输入写入 Herdr；不代表回合已开始。
export async function submit(backendRef, text) {
  const r = await run(["agent", "prompt", JSON.parse(backendRef).paneId, text]);
  if (r.ok) return { status: "written" };
  if (r.code === "agent_blocked" || r.code === "agent_not_found") return { status: "rejected", reason: r.message };
  return { status: "unknown", reason: r.message };
}

// 实测：Claude 前台执行 Bash 时 Esc 无法中断，Ctrl+C 可以；Codex 用 Esc 可以中断。
export async function cancel(backendRef, kind) {
  const r = await run(["agent", "send-keys", JSON.parse(backendRef).paneId, kind === "claude" ? "ctrl+c" : "esc"]);
  return r.ok ? { status: "requested" } : { status: "unknown", reason: r.message };
}

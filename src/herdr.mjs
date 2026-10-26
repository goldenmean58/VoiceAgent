// Herdr 后端：只向应用暴露 discover/start/inspect/submit/cancel/close。
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
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID || !process.env.HERDR_SOCKET_PATH) {
    throw new Error("必须在 Herdr 管理的 pane 中运行（HERDR_ENV=1，且有 HERDR_PANE_ID、HERDR_WORKSPACE_ID 和 HERDR_SOCKET_PATH）");
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

// POSIX shell 单引号转义，供 pane run 拼命令行。
function shellQuote(s) {
  return /^[\w+:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

// 在当前 workspace 的新 tab（newTab）或 fromRef（或当前 pane）旁新建 pane，用 command 启动 kind 类 agent。成功返回 backendRef；
// 启动后停在原生交互界面（信任确认、Hook 审核）时返回 ok:false 并说明原因，pane 保留供用户查看。
// herdr agent start 只能运行 kind 的内置可执行文件，因此改为在 shell 中运行命令行，再等 Herdr 识别出同类 agent 并就绪。
// command 可以是包装脚本（如 doubao），但最终必须启动该 kind 的 CLI，否则 Herdr 识别不到。
export async function start({ name, kind, command, cwd, env, args, newTab, fromRef, direction }) {
  const createArgs = newTab
    ? ["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID, "--cwd", cwd, "--label", name, "--no-focus"]
    : ["pane", "split", fromRef ? JSON.parse(fromRef).paneId : process.env.HERDR_PANE_ID, "--direction", direction, "--cwd", cwd, "--no-focus"];
  for (const [k, v] of Object.entries(env)) createArgs.push("--env", `${k}=${v}`);
  const created = await run(createArgs);
  if (!created.ok) return { ok: false, reason: `创建 ${newTab ? "tab" : "pane"} 失败：${created.message}` };
  const pane = newTab ? created.result.root_pane : created.result.pane;
  const backendRef = JSON.stringify({ paneId: pane.pane_id, terminalId: pane.terminal_id });

  // 新 pane 的 shell 进入提示符前终端处于 canonical 模式，超过 1024 字节的命令行会被拒（pane_send_failed）且不发送任何输入；
  // 等它进入提示符。较短的命令行会作为预输入排队，shell 就绪后执行。
  const line = [command, ...args].map(shellQuote).join(" ");
  let ran;
  for (const deadline = Date.now() + 20000; ;) {
    ran = await run(["pane", "run", pane.pane_id, line], { json: false });
    if (ran.ok || ran.code !== "pane_send_failed" || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ran.ok) return { ok: false, backendRef, reason: `在 pane ${pane.pane_id} 中运行 ${command} 失败（${ran.code}）：${ran.message}` };

  // 与 herdr agent start 相同的就绪判定：识别出同类 agent 且 idle/done；启动阶段 blocked 立即按未就绪处理。
  let status = null;
  for (const deadline = Date.now() + 60000; !["idle", "done", "blocked"].includes(status) && Date.now() < deadline;) {
    await new Promise((r) => setTimeout(r, 500));
    const got = await run(["pane", "get", pane.pane_id]);
    if (!got.ok) return { ok: false, backendRef, reason: `查询 pane ${pane.pane_id} 失败：${got.message}` };
    status = got.result.pane.agent === kind ? got.result.pane.agent_status : null;
  }
  if (status !== "idle" && status !== "done") {
    const screen = await readScreen(backendRef);
    if (/trust this folder/i.test(screen)) {
      return { ok: false, backendRef, reason: `${kind} 要求先信任目录 ${cwd}；请在 pane ${pane.pane_id} 中确认后重试` };
    }
    return {
      ok: false, backendRef,
      reason: status === "blocked" ? `${command} 启动后停在待确认界面；请在 pane ${pane.pane_id} 中查看` : `${command} 运行后 60s 内 Herdr 没有识别到就绪的 ${kind}；请在 pane ${pane.pane_id} 中查看`,
    };
  }
  const renamed = await run(["agent", "rename", pane.pane_id, name]);
  if (!renamed.ok) return { ok: false, backendRef, reason: `命名 agent 失败：${renamed.message}` };
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

// 关闭 backendRef 对应的 pane，其中的 CLI 进程随之结束。pane 已不存在或已换了终端时视为已关闭，不去动别人的 pane。
export async function close(backendRef) {
  const { paneId, terminalId } = JSON.parse(backendRef);
  const got = await run(["pane", "get", paneId]);
  if (!got.ok) return got.code === "pane_not_found" ? { ok: true } : { ok: false, reason: got.message };
  if (got.result.pane.terminal_id !== terminalId) return { ok: true };
  const r = await run(["pane", "close", paneId], { json: false });
  if (r.ok || r.code === "pane_not_found") return { ok: true };
  return { ok: false, reason: r.message };
}

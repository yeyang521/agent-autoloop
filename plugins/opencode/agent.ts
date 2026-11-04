// OpenCode: the user's own, installed and signed in by them. A run is `opencode run --format json`; the session id comes
// back in the events, so an answer or a retry goes on in the same conversation.
//
// Two things about this CLI the worker has to be told. It asks before reading a path outside the directory it was started
// in, and a headless run has nobody to answer, so the run's own folder (which holds context.json) is allowed up front.
// And its JSON stream can end without the last text event, so an answer that isn't there is read back from the session.
import { execFileSync } from "node:child_process";
import { addUsage, type Usage } from "../../protocol/validate.ts";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";

/** Which built-in agent carries which permission: plan reads but won't write; build does both. */
const AGENT = { read: "plan", edit: "build", full: "build" };

/** The run's folder holds context.json, which opencode would ask about; a headless run has nobody to ask. */
function permissions(turn: { access: "read" | "edit" | "full"; folder: string }) {
  return turn.access === "full"
    ? { permission: { external_directory: "allow" } }
    : { permission: { external_directory: { [`${turn.folder}/**`]: "allow" } } };
}

type Event = {
  type?: string;
  sessionID?: string;
  part?: {
    messageID?: string;
    text?: string;
    tokens?: { input?: number; output?: number; cache?: { read?: number } };
    /** What this step was charged, in dollars. */
    cost?: number;
  };
  error?: { message?: string; data?: { message?: string } };
};

/** A step's tokens and what it was charged: a step that says nothing about money adds no price, not a price of zero. */
function used(part: Event["part"]): Usage | undefined {
  const tokens = part?.tokens;
  const cost = part?.cost;
  if (!tokens && typeof cost !== "number") return undefined;
  return {
    ...(tokens && { input: tokens.input ?? 0, output: tokens.output ?? 0, cached: tokens.cache?.read ?? 0 }),
    ...(typeof cost === "number" && { cost }),
  };
}

/** The stream can end without its last text event; the session keeps the message it belonged to. */
function readBack(session: string | undefined, message: string | undefined) {
  if (!session || !message) return undefined;
  try {
    const printed = execFileSync(findProgram("opencode"), ["export", session], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const exported = JSON.parse(printed) as {
      messages?: { info?: { id?: string }; parts?: { type?: string; text?: string }[] }[];
    };
    const said = exported.messages?.find((entry) => entry.info?.id === message);
    return said?.parts?.filter((part) => part.type === "text" && typeof part.text === "string").at(-1)?.text;
  } catch {
    return undefined;
  }
}

export default {
  command: (turn) => [
    "/usr/bin/env",
    `OPENCODE_CONFIG_CONTENT=${JSON.stringify(permissions(turn))}`,
    findProgram("opencode"),
    "run",
    "--format",
    "json",
    ...(turn.resume ? ["--session", turn.resume] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--variant", turn.effort] : []),
    "--agent",
    AGENT[turn.access],
    ...(turn.access === "full" ? ["--dangerously-skip-permissions"] : []),
    // Not after `--`: this CLI reads a message after the separator as no message at all.
    turn.prompt,
  ],
  read(stdout, code, stderr) {
    const events: Event[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
    const session = events.find((event) => event.sessionID)?.sessionID;
    const started = events.some((event) =>
      ["step_start", "text", "tool_use", "step_finish"].includes(event.type ?? ""),
    );
    const usage = events.reduce<Usage | undefined>((total, event) => addUsage(total, used(event.part)), undefined);
    // What it has taken so far is known every time; whether it started is only ever said when it did.
    const known = { ...(session && { session }), ...(started && { started: true }), ...(usage && { usage }) };
    // While it runs, what it has said so far is not its answer.
    if (code === null) return known;
    const failure = events.find((event) => event.type === "error");
    const error = failure
      ? (failure.error?.data?.message ?? failure.error?.message ?? "OpenCode 没跑完这一轮")
      : code !== 0
        ? tail(stderr) || `退出码 ${code}`
        : undefined;
    if (error) return { ...known, error };
    const text =
      events.findLast((event) => event.type === "text" && typeof event.part?.text === "string")?.part?.text ??
      readBack(session, events.findLast((event) => event.part?.messageID)?.part?.messageID);
    return { ...known, ...(text !== undefined && { text }) };
  },
  check() {
    try {
      const printed = execFileSync(findProgram("opencode"), ["providers", "list"], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const count = /(\d+)\s+credentials?/.exec(printed);
      return count && Number(count[1]) > 0 ? null : "OpenCode 没有登录：运行 opencode auth login";
    } catch (error) {
      return `OpenCode 用不了：${String((error as Error).message).split("\n")[0]}`;
    }
  },
} satisfies Adapter;

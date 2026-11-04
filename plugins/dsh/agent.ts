// DeepSeek Harness: the user's own, installed and signed in by them. A run is its headless profile with --json: the
// session id comes back in the events, so an answer or a retry goes on in the same conversation.
//
// Two things about this profile the worker has to be told. It ships with the local credential store turned off, so a
// machine already signed in can't run: the run's own folder carries a patch that turns it back on and hands over a
// chosen model. And what it may touch is DSH_PERMISSION_MODE: with no approval channel in a headless run, anything
// outside that mode is refused at once rather than waited on.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { addUsage, type Usage } from "../../protocol/validate.ts";
import { findProgram, tail, type Adapter, type Turn } from "../../worker/agents.ts";

const MODE = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
const IN_THE_APP = ["/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"];

/** A value as a YAML scalar: JSON's quoting is YAML's too. */
const scalar = (value: string) => JSON.stringify(value);

/** The patch a run carries: the credential store back on, and the model it was given, if any. */
function overlay(turn: Turn) {
  const file = path.join(turn.folder, "dsh.yml");
  // `init` asks every adapter for a command line before there is a run folder; there is nothing to patch yet.
  if (!turn.folder) return file;
  const entries = ["- id: credentials", "  disabled: false"];
  if (turn.model) {
    const [provider, ...rest] = turn.model.split("/");
    const model = rest.join("/");
    entries.push(
      "- id: agent-default-model",
      "  config:",
      ...(model
        ? [`    provider: ${scalar(provider)}`, `    model: ${scalar(model)}`]
        : [`    model: ${scalar(provider)}`]),
    );
  }
  writeFileSync(file, `${entries.join("\n")}\n`);
  return file;
}

/** A headless run needs a key: one in the environment, or one the local store hands out. */
function hasKey() {
  if (Object.keys(process.env).some((name) => /_API_KEY$/.test(name))) return true;
  const home = process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
  try {
    // The store lists what it can hand out under `refs`, one indented name per entry.
    const stored = readFileSync(path.join(home, ".credentials.yaml"), "utf8");
    return /^[ \t]+\S+:/m.test(stored.slice(stored.search(/^refs:/m)));
  } catch {
    return false;
  }
}

type Event = {
  type?: string;
  sessionId?: string;
  phase?: string;
  text?: string;
  message?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  reason?: { kind?: string; error?: { message?: string } };
};

export default {
  command: (turn) => [
    "/usr/bin/env",
    `DSH_PERMISSION_MODE=${MODE[turn.access]}`,
    findProgram("dsh", () => IN_THE_APP),
    "--patch",
    overlay(turn),
    "--profile",
    "headless",
    "--json",
    ...(turn.resume ? ["--session-id", turn.resume] : []),
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
    const session = events.find((event) => event.type === "session")?.sessionId;
    const usage = events.reduce<Usage | undefined>((total, event) => {
      const used = event.usage;
      if (!used) return total;
      return addUsage(total, {
        input: used.inputTokens ?? 0,
        output: used.outputTokens ?? 0,
        cached: used.cacheReadTokens ?? 0,
      });
    }, undefined);
    // It has the turn's prompt once a step has run: one that couldn't start leaves no usage behind.
    const started = events.some((event) => event.type === "text" || event.usage);
    const known = { ...(session && { session }), ...(started && { started: true }), ...(usage && { usage }) };
    const ended = events.findLast((event) => event.type === "status" && event.phase === "turn_end");
    const failure = events.find((event) => event.type === "error");
    // While it runs, what it has said so far is not its answer.
    if (!ended) {
      if (code === null) return known;
      return { ...known, error: failure?.message ?? (tail(stderr) || `退出码 ${code}`) };
    }
    if (ended.reason?.kind !== "completed") {
      const error = failure?.message ?? ended.reason?.error?.message ?? "DeepSeek Harness 没跑完这一轮";
      return { ...known, finished: true, error };
    }
    const text = events.findLast((event) => event.type === "final")?.text;
    if (!text?.trim()) return { ...known, finished: true, error: "DeepSeek Harness 没有完成并留下实际结果" };
    return { ...known, text, finished: true };
  },
  check() {
    try {
      execFileSync(
        findProgram("dsh", () => IN_THE_APP),
        ["--profile", "headless", "--dump-config"],
        {
          encoding: "utf8",
          timeout: 20_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      return `DeepSeek Harness 用不了：${String((error as Error).message).split("\n")[0]}`;
    }
    return hasKey() ? null : "DeepSeek Harness 没有模型凭据：在 DSH 里存好密钥，或把密钥写进 secrets.env";
  },
} satisfies Adapter;

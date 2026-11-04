// What's different about DeepSeek Harness. Failure cases: a level of access maps to the wrong sandbox mode, so a read
// run can write or a full run can't; the headless profile's credential store stays off, so a signed-in machine can't
// run; a chosen model isn't handed over; a resumed run starts a new conversation instead of going on; a turn that never
// got going says it started, so its work is redone in a session it never had; a turn that ended in an error is taken for
// an answer; what the steps used isn't added up; check calls a machine with no key ready.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

// The program itself is looked up once, through the login shell: a stub answers for it on machines without DSH.
process.env.PATH = `/nonexistent:${process.env.PATH}`;
const dir = setup("dsh");
const program = join(dir, "dsh.sh");
const lookup = join(dir, "lookup.sh");
writeFileSync(lookup, `#!/bin/sh\nprintf "%s\\n" '${program}'\n`, { mode: 0o755 });
process.env.SHELL = lookup;
process.env.DSH_HOME = join(dir, "dsh-home");
mkdirSync(process.env.DSH_HOME, { recursive: true });
const adapter: import("../worker/agents.ts").Adapter = (await import("../plugins/dsh/agent.ts")).default;

const folder = join(dir, "run");
mkdirSync(folder, { recursive: true });
const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: join(folder, "context.json"),
  folder,
};
const patchFile = join(folder, "dsh.yml");
const mode = (argv: string[]) => argv[1].slice("DSH_PERMISSION_MODE=".length);
const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
const session = { type: "session", sessionId: "session-1", cwd: "/x" };
const step = (input: number, output: number, cached: number) => ({
  type: "status",
  phase: "step_end",
  turn: 1,
  step: 1,
  usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached },
});
const ended = { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } };
const final = (text: string) => ({ type: "final", text });

test("DeepSeek Harness: access, new and going on", () => {
  const argv = adapter.command({ ...turn });
  assert.equal(argv[0], "/usr/bin/env");
  assert.equal(mode(argv), "workspace-write");
  assert.equal(argv[2], program);
  assert.deepEqual(argv.slice(3, 5), ["--patch", patchFile]);
  assert.equal(argv[argv.indexOf("--profile") + 1], "headless");
  assert.ok(argv.includes("--json"));
  assert.equal(argv.at(-1), "做这件事");
  assert.ok(!argv.includes("--session-id"), "a new turn lets the CLI make its own session");

  assert.equal(mode(adapter.command({ ...turn, access: "read" })), "read-only");
  assert.equal(mode(adapter.command({ ...turn, access: "full" })), "danger-full-access");

  const again = adapter.command({ ...turn, resume: "session-old" });
  assert.equal(again[again.indexOf("--session-id") + 1], "session-old");
});

test("DeepSeek Harness: init can ask for a command line before there is a run folder", () => {
  const argv = adapter.command({ ...turn, folder: "" });
  assert.equal(argv.at(-1), "做这件事");
  assert.ok(!existsSync(join(dir, "dsh.yml")), "nothing is written where there is no run folder");
});

test("DeepSeek Harness: the headless profile's credential store is turned on, and a chosen model goes with it", () => {
  adapter.command({ ...turn });
  const plain = readFileSync(patchFile, "utf8");
  assert.match(plain, /- id: credentials\n\s+disabled: false/);
  assert.ok(!plain.includes("agent-default-model"), "no model asked for, so the profile's own stands");

  adapter.command({ ...turn, model: "opencode-go/deepseek-v4.1-flash" });
  const chosen = readFileSync(patchFile, "utf8");
  assert.match(
    chosen,
    /- id: agent-default-model\n\s+config:\n\s+provider: "opencode-go"\n\s+model: "deepseek-v4\.1-flash"/,
  );
});

test("DeepSeek Harness: only a turn that ended with a message is an answer", () => {
  assert.equal(adapter.read(lines(session, step(5, 2, 3)), null, "").text, undefined, "still going, so not over");
  const reading = adapter.read(lines(session, step(5, 2, 3), step(7, 1, 4), ended, final("好了")), 0, "");
  assert.equal(reading.text, "好了");
  assert.equal(reading.session, "session-1");
  assert.equal(reading.started, true);
  assert.equal(reading.finished, true);
  assert.deepEqual(reading.usage, { input: 12, output: 3, cached: 7 });
  // A turn over but the process still up is still its answer.
  assert.equal(adapter.read(lines(session, step(5, 2, 3), ended, final("好了")), null, "").text, "好了");
});

test("DeepSeek Harness: a run that never got going doesn't say it started", () => {
  const refused = adapter.read(
    lines({ type: "error", message: 'session "session-x" does not exist; omit --session-id to start a new Session' }),
    1,
    "",
  );
  assert.equal(refused.started, undefined);
  assert.equal(refused.session, undefined);
  assert.match(refused.error!, /does not exist/);
  // Died without ending its turn: nothing it said is an answer.
  const died = adapter.read(lines(session, step(5, 2, 3)), 1, "");
  assert.equal(died.started, true);
  assert.equal(died.text, undefined);
  assert.match(died.error!, /退出码 1/);
});

test("DeepSeek Harness: a turn that ended in an error is why it failed, not an answer", () => {
  const failed = {
    type: "status",
    phase: "turn_end",
    turn: 1,
    reason: { kind: "error", error: { message: "MISSING_CREDENTIAL: no API key", code: "MISSING_CREDENTIAL" } },
  };
  const reading = adapter.read(lines(session, failed, final("")), 0, "");
  assert.match(reading.error!, /MISSING_CREDENTIAL/);
  assert.equal(reading.text, undefined);
  assert.equal(reading.finished, true);
});

test("DeepSeek Harness: check says whether there's a key to run with", () => {
  writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(process.env.DSH_HOME!, ".credentials.yaml"), "version: 1\nrecords: {}\nrefs: {}\n");
  assert.match(adapter.check!()!, /凭据/);
  writeFileSync(
    join(process.env.DSH_HOME!, ".credentials.yaml"),
    'version: 1\nrefs:\n  OPENCODE_GO_API_KEY: "ref-1"\n',
  );
  assert.equal(adapter.check!(), null);
  writeFileSync(program, "#!/bin/sh\necho 'no such profile' >&2\nexit 1\n", { mode: 0o755 });
  assert.match(adapter.check!()!, /用不了/);
});

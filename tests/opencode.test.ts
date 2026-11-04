// What's different about OpenCode. Failure cases: a level of access maps to the wrong built-in agent or hands out full
// permissions unasked; a resumed run starts a new conversation instead of going on; the run's own folder isn't allowed,
// so the agent can't read the context file it was told about; the JSON stream's missing last text event is taken for an
// answer of nothing; an error event is taken for a finished answer; a turn that got going doesn't say so, so a broken
// one is redone from scratch in a new session; the session isn't picked out.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

// The program itself is looked up once, through the login shell: a stub answers for it on machines without OpenCode.
process.env.PATH = `/nonexistent:${process.env.PATH}`;
const dir = setup("opencode");
const program = join(dir, "opencode.sh");
const lookup = join(dir, "lookup.sh");
writeFileSync(lookup, `#!/bin/sh\nprintf "%s\\n" '${program}'\n`, { mode: 0o755 });
process.env.SHELL = lookup;
const adapter: import("../worker/agents.ts").Adapter = (await import("../plugins/opencode/agent.ts")).default;

const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/run/context.json",
  folder: "/run",
};
const config = (argv: string[]) => JSON.parse(argv[1].slice("OPENCODE_CONFIG_CONTENT=".length));
const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
const started = { type: "step_start", sessionID: "s", part: { messageID: "m1" } };
const said = (text: string, messageID = "m2") => ({ type: "text", sessionID: "s", part: { messageID, text } });
const ended = {
  type: "step_finish",
  sessionID: "s",
  part: { messageID: "m1", tokens: { input: 9, output: 2, cache: { read: 3 } } },
};

/** What the stub prints for `export` and `providers list`, the two times the adapter asks it something. */
const programSays = (exported: object, credentials = "1 credentials") =>
  writeFileSync(
    program,
    `#!/bin/sh\ncase "$1" in\n  export) printf '%s' '${JSON.stringify(exported)}' ;;\n  providers) printf '%s\\n' '${credentials}' ;;\nesac\n`,
    { mode: 0o755 },
  );

test("OpenCode: access, new and going on, model", () => {
  const argv = adapter.command({ ...turn });
  assert.equal(argv[0], "/usr/bin/env");
  assert.equal(argv[2], program);
  assert.deepEqual(argv.slice(3, 5), ["run", "--format"]);
  assert.equal(argv[5], "json");
  assert.equal(argv[argv.indexOf("--agent") + 1], "build");
  assert.equal(argv.at(-1), "做这件事");
  assert.ok(!argv.includes("--"), "after -- this CLI reads no message at all");
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
  // The run's own folder holds context.json: opencode asks before reading outside the directory it was started in, and
  // a headless run has nobody to answer, so it has to be allowed up front.
  assert.deepEqual(config(argv), { permission: { external_directory: { "/run/**": "allow" } } });

  const read = adapter.command({ ...turn, access: "read" });
  assert.equal(read[read.indexOf("--agent") + 1], "plan", "plan can read but not write");
  assert.ok(!read.includes("--dangerously-skip-permissions"));

  const full = adapter.command({ ...turn, access: "full" });
  assert.equal(full[full.indexOf("--agent") + 1], "build");
  assert.ok(full.includes("--dangerously-skip-permissions"));
  assert.deepEqual(config(full), { permission: { external_directory: "allow" } });

  const again = adapter.command({ ...turn, resume: "old-id", model: "p/m", effort: "high" });
  assert.equal(again[again.indexOf("--session") + 1], "old-id");
  assert.equal(again[again.indexOf("--model") + 1], "p/m");
  assert.equal(again[again.indexOf("--variant") + 1], "high");
  assert.ok(!argv.includes("--session"), "a new turn lets the CLI make its own session");
});

test("OpenCode: only what it ends with is its answer", () => {
  assert.equal(adapter.read(lines(started, said("中途")), null, "").text, undefined, "still going, so not over");
  const reading = adapter.read(lines(started, said("中途"), ended, said("好了")), 0, "");
  assert.equal(reading.text, "好了");
  assert.equal(reading.session, "s");
  assert.equal(reading.started, true);
  assert.deepEqual(reading.usage, { input: 9, output: 2, cached: 3 });
});

test("OpenCode: a turn that got going says so, however it ended", () => {
  const reading = adapter.read(lines(started), 143, "");
  assert.equal(reading.started, true);
  assert.equal(reading.session, "s");
  assert.equal(reading.error, "退出码 143");
  assert.equal(adapter.read("", 1, "cannot resume: session not found").error, "cannot resume: session not found");
  assert.equal(adapter.read("", 1, "").started, undefined, "it never got going, so a new session is fine");
});

test("OpenCode: an error event is why it failed, not an answer", () => {
  const failure = {
    type: "error",
    sessionID: "s",
    error: { name: "UnknownError", data: { message: "Model not found: x/y." } },
  };
  const reading = adapter.read(lines(failure), 1, "");
  assert.equal(reading.error, "Model not found: x/y.");
  assert.equal(reading.text, undefined);
});

test("OpenCode: the stream can end without its last text event, so the session is asked", () => {
  programSays({
    messages: [
      { info: { id: "m1" }, parts: [{ type: "step-start" }, { type: "text", text: "好了" }] },
      { info: { id: "m0" }, parts: [{ type: "text", text: "上一轮" }] },
    ],
  });
  assert.equal(adapter.read(lines(started), 0, "").text, "好了", "the message the stream ended on is read back");
  programSays({ messages: [{ info: { id: "other" }, parts: [{ type: "text", text: "别的" }] }] });
  assert.equal(adapter.read(lines(started), 0, "").text, undefined, "another turn's message isn't this turn's answer");
  programSays({ messages: [{ info: { id: "m1" }, parts: [{ type: "tool" }] }] });
  assert.equal(adapter.read(lines(started), 0, "").text, undefined, "a message with no text says nothing");
});

test("OpenCode: check says whether it is signed in", () => {
  programSays({}, "1 credentials");
  assert.equal(adapter.check!(), null);
  programSays({}, "0 credentials");
  assert.match(adapter.check!()!, /auth login/);
});

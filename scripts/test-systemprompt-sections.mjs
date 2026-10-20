/**
 * Regression #19: Caveman must leave Pi's prompt composable for later handlers.
 * Requires Pi 1.3.0+; runs its real runner without making a model request.
 *
 *   node scripts/test-systemprompt-sections.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

// Keep the test independent of the user's saved default level.
const configDir = mkdtempSync(join(tmpdir(), "pi-caveman-sections-test-"));
process.env.PI_CODING_AGENT_DIR = configDir;
process.on("exit", () => rmSync(configDir, { recursive: true, force: true }));

const { default: caveman } = await import("../extensions/caveman.ts");
const handlers = new Map();
let command;
caveman({
  on(event, handler) { handlers.set(event, handler); },
  registerCommand(name, options) {
    if (name === "caveman") command = options.handler;
  },
  appendEntry() {},
});
assert.equal(typeof command, "function");
const before = handlers.get("before_agent_start");
assert.equal(typeof before, "function");
const ctx = { ui: { setStatus() {}, notify() {} } };

const sections = { ponytail: "PONYTAIL_SENTINEL", mcp: "MCP_SENTINEL" };
const event = {
  systemPromptOptions: { sections },
  get systemPrompt() { throw new Error("Modern path must not capture the whole prompt"); },
};

for (const level of ["lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra", "micro"]) {
  await command(level, ctx);
  assert.equal(await before(event), undefined, `${level} must not return a prompt override`);
  const style = sections.caveman;
  assert.equal(typeof style, "string");
  assert.ok(style.length > 0);
  assert.deepEqual(sections, {
    ponytail: "PONYTAIL_SENTINEL", mcp: "MCP_SENTINEL", caveman: style,
  });
  assert.equal(event.systemPromptOptions.sections, sections);
  assert.equal(await before(event), undefined);
  assert.equal(sections.caveman, style, "Repeated turns must not duplicate the style");

  // Each mode must have the same rules as the legacy path.
  for (const systemPromptOptions of [undefined, {}, { sections: null }]) {
    const legacy = await before({ systemPrompt: "BASE", systemPromptOptions });
    assert.equal(legacy.systemPrompt, `BASE\n\n${style}`);
  }
  const blocks = ["part-a", "part-b"];
  assert.deepEqual((await before({ systemPrompt: blocks })).systemPrompt, [...blocks, style]);
  assert.deepEqual(blocks, ["part-a", "part-b"], "Legacy arrays must not be mutated");
}

for (const off of ["off", "stop", "quit", ""]) {
  await command("full", ctx);
  await before(event);
  await command(off, ctx);
  assert.equal(await before(event), undefined);
  assert.deepEqual(sections, { ponytail: "PONYTAIL_SENTINEL", mcp: "MCP_SENTINEL" });
  assert.equal(await before({ systemPrompt: "BASE" }), undefined);
}

// Reproduce the report through Pi's real runner: the next handler must see
// Caveman and its own later section when it renders the outgoing prompt.
await command("full", ctx);
let outgoingPrompt;
const host = {
  extensions: [before, (e) => {
    e.systemPromptOptions.sections.late = "LATE_SENTINEL";
    outgoingPrompt = e.systemPrompt;
  }].map((handler, i) => ({
    path: `fixture-${i}`, handlers: new Map([["before_agent_start", [handler]]]),
  })),
  createContext: () => ctx,
  assertActive() {},
  emitError(e) { throw new Error(e.error); },
};
const run = (options) => ExtensionRunner.prototype.emitBeforeAgentStart.call(
  host, { messageType: "user", prompt: "probe" }, options,
);
const { systemPromptOptions: options } = await run({
  cwd: process.cwd(), customPrompt: "BASE", selectedTools: [], skills: [],
  sections: { ponytail: "PONYTAIL_SENTINEL", mcp: "MCP_SENTINEL" },
});
assert.equal(options.forceSystemPrompt, undefined);
for (const text of ["BASE", "CAVEMAN MODE", "PONYTAIL_SENTINEL", "MCP_SENTINEL", "LATE_SENTINEL"]) {
  assert.ok(outgoingPrompt.includes(text), `Outgoing prompt missing ${text}`);
}
assert.equal(outgoingPrompt.match(/CAVEMAN MODE/g).length, 1);

// Reuse prompt options across turns to catch stale styles when switching/off.
await command("micro", ctx);
const switched = await run(options);
assert.equal(switched.systemPromptOptions.forceSystemPrompt, undefined);
assert.ok(outgoingPrompt.includes("# Token efficiency"));
assert.ok(!outgoingPrompt.includes("CAVEMAN MODE"));
await command("off", ctx);
const disabled = await run(switched.systemPromptOptions);
assert.equal(disabled.systemPromptOptions.forceSystemPrompt, undefined);
assert.ok(!Object.hasOwn(disabled.systemPromptOptions.sections, "caveman"));
assert.ok(!outgoingPrompt.includes("# Token efficiency"));
assert.ok(outgoingPrompt.includes("LATE_SENTINEL"));
assert.ok(outgoingPrompt.includes("PONYTAIL_SENTINEL"));
assert.ok(outgoingPrompt.includes("MCP_SENTINEL"));

console.log("PASS: all modes compose; off clears; legacy prompts preserved; Pi runner retains later sections");

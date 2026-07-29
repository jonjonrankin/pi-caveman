/**
 * Regression: before_agent_start must preserve OMP's ordered string[] prompt
 * blocks while appending caveman rules. Pi's string path must still work.
 *
 *   bun scripts/test-systemprompt-coerce.mjs
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const handlers = new Map();
let commandHandler = null;
const theme = { fg: (_c, s) => s, bold: (s) => s };

const stub = {
  on(event, handler) {
    handlers.set(event, handler);
  },
  registerCommand(name, opts) {
    if (name === "caveman") commandHandler = opts.handler;
  },
  appendEntry() {},
};

const mod = await import(pathToFileURL(join(root, "extensions/caveman.ts")).href);
mod.default(stub);

const ctx = {
  ui: { theme, setStatus() {}, notify() {}, custom() {} },
  sessionManager: { getEntries() { return []; } },
  hasUI: true,
};

if (!commandHandler) {
  console.error("FAIL: /caveman command not registered");
  process.exit(1);
}
await commandHandler("full", ctx);

const before = handlers.get("before_agent_start");
if (typeof before !== "function") {
  console.error("FAIL: before_agent_start missing");
  process.exit(1);
}

const result = await before({
  type: "before_agent_start",
  prompt: "x",
  systemPrompt: ["part-a", "part-b"],
});
const sp = result?.systemPrompt;
if (!Array.isArray(sp)) {
  console.error("FAIL: expected string[] systemPrompt");
  process.exit(1);
}
if (sp.length !== 3 || sp[0] !== "part-a" || sp[1] !== "part-b") {
  console.error("FAIL: original OMP prompt blocks were not preserved", sp);
  process.exit(1);
}
if (!/CAVEMAN MODE|caveman/i.test(sp[2])) {
  console.error("FAIL: caveman rules not appended");
  process.exit(1);
}

const result2 = await before({
  type: "before_agent_start",
  prompt: "x",
  systemPrompt: "solo-prompt",
});
if (typeof result2?.systemPrompt !== "string" || !result2.systemPrompt.includes("solo-prompt")) {
  console.error("FAIL: string systemPrompt path broken");
  process.exit(1);
}
if (!/CAVEMAN MODE|caveman/i.test(result2.systemPrompt)) {
  console.error("FAIL: string path missing caveman rules");
  process.exit(1);
}

await commandHandler("off", ctx);
const result3 = await before({
  type: "before_agent_start",
  prompt: "x",
  systemPrompt: ["a", "b"],
});
if (result3) {
  console.error("FAIL: off should not rewrite systemPrompt");
  process.exit(1);
}

console.log("PASS: string[] blocks preserved; string path ok; off no-op");

/**
 * Regression: `/caveman config` draws plain rows (omp 19.2 refuses pi-tui imports)
 * and keeps the old keys: ↑↓/jk move with wrap-around, ←→/hl/tab/enter/space
 * cycle the value and save it, esc closes. Also checks no pi-tui import is left.
 *
 *   node scripts/test-config-menu.mjs   (or bun)
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Set before importing: the extension resolves CONFIG_PATH at module load.
const configDir = mkdtempSync(join(tmpdir(), "pi-caveman-config-test-"));
process.env.PI_CODING_AGENT_DIR = configDir;
process.on("exit", () => rmSync(configDir, { recursive: true, force: true }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message, detail) => {
  console.error(`FAIL: ${message}`, detail ?? "");
  process.exit(1);
};

const source = readFileSync(join(root, "extensions/caveman.ts"), "utf8");
if (/pi-tui/.test(source.replace(/\/\/.*$/gm, ""))) fail("caveman.ts still imports a pi-tui package");

let commandHandler = null;
const mod = await import(pathToFileURL(join(root, "extensions/caveman.ts")).href);
mod.default({
  on() {},
  registerCommand(name, opts) {
    if (name === "caveman") commandHandler = opts.handler;
  },
  appendEntry() {},
});

let view = null;
let closed = false;
let renders = 0;
const theme = { fg: (_color, text) => text, bold: (text) => text };
const ctx = {
  ui: {
    setStatus() {},
    notify() {},
    theme,
    custom: (factory) =>
      new Promise((resolve) => {
        view = factory({ requestRender: () => renders++ }, theme, {}, (value) => {
          closed = true;
          resolve(value);
        });
      }),
  },
  sessionManager: { getEntries: () => [] },
};

const opened = commandHandler("config", ctx);
for (let i = 0; i < 20 && !view; i++) await new Promise((r) => setTimeout(r, 5));
if (!view) fail("config did not open a custom view");
for (const method of ["render", "handleInput", "invalidate"]) {
  if (typeof view[method] !== "function") fail(`view has no ${method}()`);
}

const rows = () => view.render(80);
const selectedRow = () => rows().find((row) => row.startsWith("→ "));
const saved = async () => {
  await new Promise((r) => setTimeout(r, 20));
  return JSON.parse(readFileSync(join(configDir, "caveman.json"), "utf8"));
};

if (!rows().some((row) => row.includes("Caveman Config"))) fail("title row missing", rows());
if (!/Default level for new sessions\s+full$/.test(selectedRow() ?? "")) fail("first item not selected with value full", rows());

view.handleInput("\x1b[C"); // right
if (!/\s+ultra$/.test(selectedRow())) fail("right did not cycle full -> ultra", selectedRow());
view.handleInput("h");
view.handleInput("\x1b[D"); // left
if (!/\s+lite$/.test(selectedRow())) fail("h, left did not cycle ultra -> full -> lite", selectedRow());
if ((await saved()).defaultLevel !== "lite") fail("defaultLevel not saved");

view.handleInput("\x1b[B"); // down
if (!/Show animated status bar\s+on$/.test(selectedRow())) fail("down did not move to showStatus", rows());
view.handleInput("\r"); // enter
if (!/\s+off$/.test(selectedRow())) fail("enter did not cycle on -> off", selectedRow());
if ((await saved()).showStatus !== false) fail("showStatus not saved");
view.handleInput(" ");
if (!/\s+on$/.test(selectedRow())) fail("space did not cycle off -> on", selectedRow());

view.handleInput("j"); // wraps to the first item
if (!/^→ Default level/.test(selectedRow())) fail("j did not wrap to the first item", rows());
view.handleInput("\x1b[1;1A"); // xterm up with modifier param, wraps to last
if (!/^→ Show animated/.test(selectedRow())) fail("up did not wrap to the last item", rows());

const plain = (row) => row.replace(/\x1b\[[0-9;]*m/g, "");
if (view.render(20).some((row) => plain(row).length > 20)) fail("render(20) wider than 20 columns", view.render(20));
if (renders === 0) fail("handleInput never requested a render");

view.handleInput("\x1b"); // esc
await opened;
if (!closed) fail("esc did not close the dialog");

console.log("PASS: config menu draws plain rows; move, cycle, save and esc work");

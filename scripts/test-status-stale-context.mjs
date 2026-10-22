/**
 * Regression #21: stale animation contexts must not crash Pi or leak timers.
 *
 *   node scripts/test-status-stale-context.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "pi-caveman-stale-test-"));
process.env.PI_CODING_AGENT_DIR = configDir;
process.on("exit", () => rmSync(configDir, { recursive: true, force: true }));
const { default: caveman } = await import("../extensions/caveman.ts");

const staleError = new Error("This extension ctx is stale after session replacement or reload.");
const timers = new Map();
let nextTimer = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback) => {
  const id = ++nextTimer;
  timers.set(id, callback);
  return id;
};
globalThis.clearInterval = (id) => timers.delete(id);

async function fixture() {
  const handlers = new Map();
  let command;
  let failure;
  let error;
  let uiReads = 0;
  const writes = [];
  const failAt = (location) => { if (failure === location) throw error; };
  const ui = {
    get theme() {
      failAt("theme");
      return { fg: (_color, text) => text };
    },
    setStatus(key, text) {
      failAt("status");
      writes.push({ key, text });
    },
    notify() {},
  };
  const ctx = {
    get ui() {
      uiReads++;
      failAt("ui");
      return ui;
    },
    sessionManager: { getEntries: () => [] },
  };
  caveman({
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(_name, options) { command = options.handler; },
    appendEntry() {},
  });
  await handlers.get("session_start")({}, ctx);
  return {
    emit: (event) => handlers.get(event)({}, ctx),
    command: (args) => command(args, ctx),
    fail(location, reason = staleError) { failure = location; error = reason; },
    get uiReads() { return uiReads; },
    writes,
  };
}

try {
  // Guard both initial rendering and asynchronous ticks, including UI getters.
  for (const location of ["ui", "theme", "status"]) {
    const initial = await fixture();
    initial.fail(location);
    await assert.doesNotReject(() => initial.emit("agent_start"));
    assert.equal(timers.size, 0, `${location}: failed first frame must not start a timer`);

    const active = await fixture();
    await active.emit("agent_start");
    assert.equal(timers.size, 1);
    const tick = [...timers.values()][0];
    tick();
    assert.ok(active.writes.length >= 3, "Healthy animation keeps rendering");
    active.fail(location);
    assert.doesNotThrow(tick);
    assert.equal(timers.size, 0, `${location}: stale tick must clear its timer`);
    const reads = active.uiReads;
    tick();
    assert.equal(active.uiReads, reads, "Stopped callback must not access stale UI again");
  }

  // Clearing disabled status also touches UI and needs the same protection.
  for (const location of ["ui", "status"]) {
    const disabled = await fixture();
    await disabled.command("off");
    disabled.fail(location);
    await assert.doesNotReject(() => disabled.emit("agent_start"));
    assert.equal(timers.size, 0);
  }

  const session = await fixture();
  await session.emit("agent_start");
  const supersededTick = [...timers.values()][0];
  await session.emit("agent_start");
  const readsBeforeSupersededTick = session.uiReads;
  supersededTick();
  assert.equal(session.uiReads, readsBeforeSupersededTick, "Superseded callback must not touch UI");
  assert.equal(timers.size, 1, "Status refresh must leave exactly one timer");
  const oldTick = [...timers.values()][0];
  await session.emit("session_shutdown");
  await session.emit("session_shutdown");
  assert.equal(timers.size, 0, "Shutdown cleanup is idempotent");
  session.fail("ui");

  const fresh = await fixture();
  await fresh.emit("agent_start");
  const reads = session.uiReads;
  oldTick();
  assert.equal(session.uiReads, reads, "Obsolete callback must not access old context");
  assert.equal(timers.size, 1, "Obsolete callback must not stop fresh animation");
  await fresh.emit("agent_end");
  assert.equal(timers.size, 0, "Agent end stops animation");

  // Do not hide unrelated bugs while hardening against lifecycle invalidation.
  const broken = await fixture();
  await broken.emit("agent_start");
  const bug = new Error("Unexpected rendering bug");
  broken.fail("status", bug);
  assert.throws([...timers.values()][0], (error) => error === bug);
  assert.equal(timers.size, 0, "Unexpected failure also stops its timer");

  console.log("PASS: stale UI stops animation; initial failure starts no timer; shutdown and restart safe; unrelated errors preserved");
} finally {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
}

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
function declaration(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  if (!start) return "";
  const next = /^(?:async )?function \w+\(/gm; next.lastIndex = start.index + start[0].length;
  return source.slice(start.index, next.exec(source)?.index ?? source.length);
}
function context(names, globals) {
  const c = vm.createContext({ console, ...globals });
  for (const name of ["requiresXinhuoAIReply", "blockXinhuoConfiguration", ...names]) vm.runInContext(declaration(name), c);
  return c;
}

for (const taskType of ["点赞", "关注", "关注+点赞", "like", "follow"]) {
  for (const command of ["DEBUG_XINHUO_CLAIM_OPEN_X", "DEBUG_XINHUO_RUN_X_REPLY"]) {
    test(`${command} preserves the known ${taskType} path without an AI Key`, async () => {
      let dispatched = 0;
      const state = { runId: "run", running: false, manuallyStopped: true, currentTask: { taskType } };
      const c = context(["runManualDebugCommand"], {
        runtimeState: state, getSettings: async () => ({ aiApiKey: "" }), lockRuntimeWindowForCommand: () => ({ ok: true }),
        prepareDebugRunForCommand: async () => { state.running = true; state.mode = "debug"; },
        debugClaimXinhuoTaskAndOpenX: async () => { dispatched++; return { ok: true }; },
        debugRunXinhuoXReply: async () => { dispatched++; return { ok: true }; }
      });
      assert.equal((await c.runManualDebugCommand({ type: command }, 1)).ok, true);
      assert.equal(dispatched, 1);
    });
  }
}
for (const taskType of ["", "未知", "评论", "评论+点赞", "reply+like"]) test(`unknown or commenting task ${taskType || "empty"} still blocks keyless claim`, async () => {
  let dispatched = 0;
  const state = { runId: "run", manuallyStopped: true, currentTask: { taskType } };
  const c = context(["runManualDebugCommand"], {
    runtimeState: state, getSettings: async () => ({ aiApiKey: "" }), lockRuntimeWindowForCommand: () => ({ ok: true }),
    prepareDebugRunForCommand: async () => { dispatched++; }
  });
  assert.equal((await c.runManualDebugCommand({ type: "DEBUG_XINHUO_CLAIM_OPEN_X" }, 1)).ok, false);
  assert.equal(dispatched, 0); assert.equal(state.manuallyStopped, true);
});

for (const fn of ["debugClaimXinhuoTaskAndOpenX", "debugRunXinhuoXReply"]) test(`${fn} also permits known interaction-only tasks`, async () => {
  const state = { runId: "run", running: true, currentTask: { taskType: "点赞" } };
  let sends = 0;
  const c = context([fn], {
    runtimeState: state, getSettings: async () => ({ aiApiKey: "", actionDelayMs: 0 }),
    getOrCreateXinhuoTab: async () => ({ id: 1 }), assertXinhuoTab() {}, beginXinhuoXOpenWatch() {}, clearXinhuoXOpenWatch() {},
    chrome: { tabs: { update: async () => {} } }, toContentSettings: value => value,
    sendToTab: async () => { sends++; return { ok: false }; }, failDebugStep: () => ({ ok: false, testedDispatch: true }),
    resolveCurrentXinhuoXTab: async () => ({ id: 2 }), focusXinhuoXTab: async () => {}, waitForTabComplete: async () => {},
    delay: async () => {}, XINHUO_X_HYDRATION_MS: 0
  });
  assert.equal((await c[fn]()).testedDispatch, true); assert.equal(sends, 1);
});

for (const error of [false, true]) test(`next scan ${error ? "credential read failure" : "missing stored key"} stops without entering automatic recovery`, async () => {
  const order = { taskKey: "/tasks/previous", claimed: true };
  const state = { runId: "run", running: true, mode: "auto", currentTask: order };
  let recoveries = 0, alarmsCleared = 0;
  const c = context(["runNextXinhuoTask"], {
    runtimeState: state, isActiveRun: runId => state.running && state.runId === runId,
    getSettings: async () => { if (error) throw Error("fixture credential error"); return { aiApiKey: "" }; },
    stopWithFailure: async () => { recoveries++; return { ok: false }; },
    setStage: value => { state.stage = value; }, log() {}, clearXinhuoXOpenWatch() {}, clearXinhuoXSubmission() {},
    clearXinhuoKeepalive: async () => { alarmsCleared++; }
  });
  assert.equal((await c.runNextXinhuoTask("next")).ok, false);
  assert.equal(state.running, false); assert.equal(state.currentTask, order);
  assert.equal(recoveries, 0); assert.equal(alarmsCleared, 1);
});

test("manual completion credential-read failure finishes its queue without starting or stranding a runner", async () => {
  const state = { runId: "run", running: true, mode: "debug" };
  const c = context(["resumeXinhuoAutoAfterDebug"], {
    runtimeState: state, isActiveRun: (runId, mode) => state.running && state.runId === runId && (!mode || state.mode === mode),
    getSettings: async () => { throw Error("fixture credential error"); },
    setStage: value => { state.stage = value; }, log() {}, clearXinhuoXOpenWatch() {}, clearXinhuoXSubmission() {}, clearXinhuoKeepalive: async () => {}
  });
  const result = await c.resumeXinhuoAutoAfterDebug("run", "after_submit");
  assert.equal(result.ok, false); assert.equal(result.queueFinished, true); assert.equal(state.running, false);
});

for (const fn of ["runNextXinhuoTask", "resumeXinhuoAutoAfterDebug"]) test(`STOP while ${fn} credential read fails cannot alter the replacement state`, async () => {
  let reject;
  const oldState = { runId: "run", running: true, mode: fn === "runNextXinhuoTask" ? "auto" : "debug" };
  const stopped = { runId: "stopped", running: false, manuallyStopped: true, logs: [] };
  const c = context([fn], {
    runtimeState: oldState, isActiveRun: (runId, mode) => c.runtimeState.running && c.runtimeState.runId === runId && (!mode || c.runtimeState.mode === mode),
    getSettings: () => new Promise((_, fail) => { reject = fail; }),
    setStage() { throw Error("late state mutation"); }, log() { throw Error("late log"); },
    clearXinhuoXOpenWatch() {}, clearXinhuoXSubmission() {}, clearXinhuoKeepalive: async () => {}
  });
  const pending = fn === "runNextXinhuoTask" ? c[fn]("next") : c[fn]("run", "after_submit");
  c.runtimeState = stopped; reject(Error("late credential failure"));
  assert.equal((await pending).cancelled, true); assert.equal(c.runtimeState, stopped); assert.deepEqual(stopped.logs, []);
});

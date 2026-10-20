"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
const KEY = "xinhuoAutoRunStateV1";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const session = {};
  const actions = [], hooks = {}, stored = { settings: { aiApiUrl: "https://api.vayne.cc.cd/v1/responses", aiApiKey: "fixture", replyMode: "post", autoSubmitXinhuo: true },
    xinhuoReplyHistoryRecords: [{ id: "completed-history" }] };
  const event = { addListener() {} };
  const tab = { id: 7, windowId: 3, url: "https://xinhuo123.com/tasks", status: "complete" };
  const chrome = {
    runtime: { id: "fixture", getURL: value => `chrome-extension://fixture/${value}`, getManifest: () => ({ version: "0.1.48" }),
      onInstalled: event, onMessage: event, getPlatformInfo: async () => { await hooks.platform?.(); } },
    storage: { local: { setAccessLevel: async () => {}, get: async keys => Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, clone(stored[key])])),
      set: async values => { await hooks.save?.(values); Object.assign(stored, clone(values)); } },
      session: { setAccessLevel: async () => {}, get: async keys => Object.fromEntries(keys.filter(key => Object.hasOwn(session, key)).map(key => [key, clone(session[key])])),
        set: async values => { Object.assign(session, clone(values)); } } },
    alarms: { onAlarm: event, create: async () => { actions.push(["alarm-create"]); await hooks.alarmCreate?.(); }, clear: async () => { actions.push(["alarm-clear"]); } },
    windows: { update: async id => { actions.push(["window-focus", id]); return { id }; } },
    tabs: { onRemoved: event, onCreated: event, onUpdated: event,
      get: async id => { await hooks.get?.(id); return { ...tab, id }; },
      query: async query => { await hooks.query?.(query); return [{ ...tab }]; },
      update: async (id, data) => { actions.push(["tab-update", id, data]); await hooks.update?.(); return { ...tab, id, ...data }; },
      create: async data => { actions.push(["tab-create", data]); return { ...tab, id: 8, ...data }; },
      remove: async id => { actions.push(["tab-remove", id]); },
      reload: async id => { actions.push(["tab-reload", id]); await hooks.reload?.(); },
      sendMessage: async (id, message) => { actions.push(["message", id, clone(message)]); return await hooks.message?.(id, message) || { ok: true }; } },
    scripting: { executeScript: async value => { actions.push(["inject", value]); } }
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, setTimeout, clearTimeout, importScripts() {},
    generateLighthouseAIReply: async () => { actions.push(["ai"]); return { replyText: "fixture", diagnostics: [] }; } });
  vm.runInContext(source, c);
  await vm.runInContext("runtimeStateReady", c);
  vm.runInContext(`runtimeState = { ...createInitialState(), running: true, mode: "auto", stage: "selecting_task", runId: "current-run",
    windowId: 3, xinhuoTabId: 7, xTabId: 9, xTabWindowId: 3, currentTask: { taskKey: "/tasks/old", detailPath: "/tasks/old", tweetUrl: "https://x.com/user/status/123", claimed: true },
    uncertainAction: { type: "XINHUO_CLAIM", runId: "older-claim-run", tabId: 11 },
    completionEvidence: { taskKey: "/tasks/old" }, pendingXOpen: { xinhuoTabId: 12, candidates: [], createdAt: {} }, pendingXSubmission: { tabId: 10 },
    attemptedTasks: [{ taskKey: "/tasks/old" }], scheduledResumeAt: 123, marketplaceNoClaimSince: 123,
    logs: [{ text: "old log" }], claimRecoveryInFlight: true, claimRecoveryToken: {}, marketplaceRefreshInFlight: true };
    directXinhuoXOpen = { taskKey: "/tasks/old", promise: Promise.resolve(null) };
    xinhuoMarketplaceTabPromise = Promise.resolve({ id: 7 });`, c);
  const read = expression => vm.runInContext(expression, c);
  return { c, read, actions, hooks, stored, state: () => read("runtimeState"),
    stop: () => c.stopXinhuoRun(), flush: () => read("runtimeStateWriteTail") };
}
function assertClean(h) {
  const state = h.state();
  assert.equal(state.running, false); assert.equal(state.mode, "idle"); assert.equal(state.stage, "stopped");
  assert.equal(state.manuallyStopped, true);
  for (const key of ["currentTask", "xinhuoTabId", "xTabId", "xTabWindowId", "windowId", "lastXResult", "completionEvidence", "pendingXOpen", "pendingXSubmission"])
    assert.equal(state[key], null, `${key} must be cleared`);
  for (const key of ["uncertainAction", "claimRecoveryToken"]) assert.equal(state[key] == null, true, `${key} must be cleared`);
  for (const key of ["attempts", "completed", "failed", "scheduledResumeAt", "marketplaceNoClaimSince"]) assert.equal(state[key], 0);
  assert.equal(state.logs.length, 0); assert.equal(state.attemptedTasks.length, 0);
  assert.equal(h.read("directXinhuoXOpen"), null); assert.equal(h.read("xinhuoMarketplaceTabPromise"), null);
}
function mutations(h) { return h.actions.filter(item => ["tab-update", "tab-create", "tab-remove", "tab-reload", "window-focus", "inject", "ai"].includes(item[0])); }
function prepareActive(h, mode = "auto") {
  h.read(`delete runtimeState.uncertainAction; runtimeState.claimRecoveryInFlight = false; runtimeState.marketplaceRefreshInFlight = false;
    runtimeState.mode = ${JSON.stringify(mode)}; directXinhuoXOpen = null; xinhuoMarketplaceTabPromise = null;`);
}

test("STOP clears runtime records and old controls while preserving settings and completed history", async () => {
  const h = await fixture(), settings = clone(h.stored.settings), history = clone(h.stored.xinhuoReplyHistoryRecords);
  await h.stop(); await h.flush(); assertClean(h);
  assert.notEqual(h.state().runId, "current-run");
  assert.deepEqual(h.stored.settings, settings); assert.deepEqual(h.stored.xinhuoReplyHistoryRecords, history);
  assert.equal(h.stored[KEY].uncertainAction, undefined); assert.equal(h.stored[KEY].currentTask, null);
  const cancels = h.actions.filter(item => item[0] === "message" && item[2].type.startsWith("CANCEL_"));
  for (const id of [7, 9, 10, 11, 12]) assert.ok(cancels.some(item => item[1] === id && item[2].reset === true), `old tab ${id} must reset`);
  assert.ok(cancels.some(item => item[1] === 11 && item[2].runId === "older-claim-run"));
  assert.equal(mutations(h).length, 0);
});
test("STOP still cancels pages and keeps memory empty when persisting the reset fails", async () => {
  const h = await fixture(); h.hooks.save = () => { throw Error("storage unavailable"); };
  await assert.rejects(h.stop(), /保存失败|storage unavailable/); assertClean(h);
  assert.ok(h.actions.some(item => item[0] === "message" && item[2].reset === true));
});
test("manual STOP invalidates queued single steps and a newly requested step can start", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(), calls = [];
  prepareActive(h); h.c.runManualDebugCommand = async message => { calls.push(message.type); entered.resolve(); await release.promise; return { ok: true }; };
  const first = h.c.enqueueManualDebugCommand({ type: "first" }, 3); await entered.promise;
  const queued = h.c.enqueueManualDebugCommand({ type: "old-second" }, 3);
  await h.stop(); release.resolve(); await first; assert.equal((await queued).ok, false);
  await h.c.enqueueManualDebugCommand({ type: "new-explicit" }, 3);
  assert.deepEqual(calls, ["first", "new-explicit"]);
});
test("old or unscoped page logs stay silent after STOP", async () => {
  const h = await fixture(); await h.stop();
  await h.c.handleMessage({ type: "CONTENT_LOG", text: "old page" }, {});
  await h.c.handleMessage({ type: "CONTENT_LOG", runId: "current-run", text: "late page" }, {});
  assert.equal(h.state().logs.length, 0);
});
test("STOP during debug takeover cancellation cannot revive the old command", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  h.c.sendToTab = async () => { entered.resolve(); await release.promise; return { ok: true }; };
  const pending = h.c.prepareDebugRunForCommand(3, "DEBUG_XINHUO_OPEN_TASKS"); await entered.promise;
  h.c.sendToTab = async () => ({ ok: true }); await h.stop(); release.resolve(); await pending; assertClean(h);
});
for (const boundary of ["settings", "marketplace"]) {
  test(`STOP during automatic scan ${boundary} prevents later navigation and page messages`, async () => {
    const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
    const original = boundary === "settings" ? h.c.getSettings : h.c.ensureXinhuoMarketplaceTab;
    h.c[boundary === "settings" ? "getSettings" : "ensureXinhuoMarketplaceTab"] = async () => {
      entered.resolve(); await release.promise; return boundary === "settings" ? { aiApiKey: "fixture", maxTasksPerRun: 10, maxTaskAttempts: 10 } : { id: 7, url: "https://xinhuo123.com/tasks/old" };
    };
    const pending = h.c.runNextXinhuoTask("fixture"); await entered.promise; await h.stop();
    const before = mutations(h).length; release.resolve(); await pending;
    assert.equal(mutations(h).length, before); assertClean(h);
    assert.equal(h.actions.some(item => item[0] === "message" && item[2].type === "XINHUO_SELECT_AND_CLAIM"), false);
  });
}
test("late single-step reply cannot restore results or write reply history after STOP", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h, "debug");
  h.c.resolveCurrentXinhuoXTab = async () => ({ id: 9, windowId: 3 }); h.c.delay = async () => {};
  h.c.sendToTab = async () => { entered.resolve(); await release.promise; return { ok: true, replyText: "late" }; };
  let records = 0; h.c.recordReplyHistory = async () => { records++; };
  const pending = h.c.debugRunXinhuoXReply(); await entered.promise;
  h.c.sendToTab = async () => ({ ok: true }); await h.stop(); release.resolve(); await pending;
  assert.equal(records, 0); assertClean(h);
});
test("late X fallback lookup cannot open or bind a page after STOP", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  h.c.getBoundMatchingXinhuoXTab = async () => null;
  h.c.findTargetXTab = async () => { entered.resolve(); await release.promise; return null; };
  const pending = h.c.openXinhuoFallbackXTab(h.state().currentTask, 7, "current-run");
  await entered.promise; await h.stop(); release.resolve(); await pending;
  assert.equal(mutations(h).length, 0); assertClean(h);
});
test("late worker-restart inspection cannot restore an order or restart scanning after STOP", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  Object.assign(h.state(), { running: false, mode: "idle", stage: "interrupted_not_resumed", completionEvidence: null });
  h.c.inspectInterruptedXinhuoOrder = async () => { entered.resolve(); await release.promise; return { kind: "claimed", task: { claimed: true }, tab: { id: 7 } }; };
  const pending = h.c.tryResumeXinhuoAfterInterruption(); await entered.promise; await h.stop(); release.resolve(); await pending; assertClean(h);
});
test("a keepalive tick paused before restart cannot restart a manually stopped runner", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  Object.assign(h.state(), { currentTask: null, marketplaceNoClaimSince: Date.now() - 600000 });
  h.hooks.platform = async () => { entered.resolve(); await release.promise; };
  let starts = 0; h.c.startXinhuoRun = async () => { starts++; };
  const pending = h.c.handleXinhuoKeepaliveTick(); await entered.promise; await h.stop(); release.resolve(); await pending;
  assert.equal(starts, 0); assert.equal(mutations(h).length, 0); assertClean(h);
});
test("AI work waiting for settings cannot call a provider or append logs after STOP", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  h.c.getSettings = async () => { entered.resolve(); await release.promise; return { aiApiKey: "fixture" }; };
  const pending = h.c.generateReply({}, h.state().currentTask, "current-run").catch(error => error);
  await entered.promise; await h.stop(); release.resolve(); await pending;
  assert.equal(h.actions.some(item => item[0] === "ai"), false); assertClean(h);
});
test("restoring a manually stopped snapshot stays empty and does not recreate keepalive", async () => {
  const h = await fixture(); await h.stop(); await h.flush(); h.actions.length = 0;
  await h.c.restoreRuntimeState(); await h.flush(); assertClean(h);
  assert.equal(h.actions.some(item => item[0] === "alarm-create"), false);
});

test("a keepalive creation finishing after STOP cannot leave an alarm behind", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  let active = false;
  h.c.chrome.alarms.create = async () => { entered.resolve(); await release.promise; active = true; };
  h.c.chrome.alarms.clear = async () => { active = false; };
  const pending = h.c.ensureXinhuoKeepalive(); await entered.promise; await h.stop(); release.resolve(); await pending;
  assert.equal(active, false); assertClean(h);
});
test("a missing content receiver cannot trigger injection after STOP", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  h.hooks.message = async (_id, message) => {
    if (message.type === "CHECK_XINHUO_CONTENT") { entered.resolve(); await release.promise; return { ok: false }; }
    return { ok: true };
  };
  const pending = h.c.sendToTab(7, { type: "XINHUO_SELECT_AND_CLAIM", runId: "current-run" });
  await entered.promise; await h.stop(); release.resolve(); await pending;
  assert.equal(h.actions.some(item => item[0] === "inject"), false); assertClean(h);
});
test("a failed old receipt save cannot put its unknown intent into the stopped state", async () => {
  const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
  h.c.ensureXinhuoContentReady = async () => ({ ok: true });
  h.hooks.message = async (_id, message) => {
    if (message.type !== "XINHUO_SELECT_AND_CLAIM") return { ok: true };
    h.state().uncertainAction = { type: "XINHUO_CLAIM", runId: "current-run", tabId: 7, taskKey: "/tasks/old" };
    return { ok: true, task: { taskKey: "/tasks/old", claimed: true } };
  };
  h.hooks.save = async value => {
    if (value[KEY]?.running && !value[KEY]?.uncertainAction) { entered.resolve(); await release.promise; throw Error("old write failed"); }
  };
  const pending = h.c.sendToTab(7, { type: "XINHUO_SELECT_AND_CLAIM", runId: "current-run" });
  await entered.promise; const stop = h.stop(); release.resolve(); await stop; await pending; assertClean(h);
});
for (const diagnostic of [false, true]) {
  test(`STOP during a ${diagnostic ? "diagnostic" : "reply"} history read prevents a late history write`, async () => {
    const h = await fixture(), entered = deferred(), release = deferred(); prepareActive(h);
    const key = diagnostic ? "xinhuoReplyDiagnosticHistoryRecords" : "xinhuoReplyHistoryRecords";
    const before = clone(h.stored[key]);
    h.c[diagnostic ? "getReplyDiagnosticRecords" : "getReplyHistoryRecords"] = async () => { entered.resolve(); await release.promise; return before || []; };
    const pending = diagnostic ? h.c.recordReplyDiagnosticHistory(h.c.buildReplyFailureRecord("ai_api_error", "late failure"))
      : h.c.recordReplyHistory({ replyText: "late reply" });
    await entered.promise; await h.stop(); release.resolve(); await pending;
    assert.deepEqual(h.stored[key], before); assertClean(h);
  });
}

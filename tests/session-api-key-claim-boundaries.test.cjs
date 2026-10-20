"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const key = "xinhuoAiApiKeyV1";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const local = { [key]: "fixture-local-key", settings: { aiApiUrl: "https://api.vayne.cc.cd/v1/responses", aiModel: "selected-model", replyMode: "post", autoSubmitXinhuo: true } };
  const session = { [key]: "fixture-session-key" }, hooks = {}, actions = [];
  const event = { addListener() {} };
  const area = (data, name) => ({ setAccessLevel: async () => {},
    get: async keys => { await hooks[`${name}Get`]?.(keys); return Object.fromEntries(keys.filter(k => Object.hasOwn(data, k)).map(k => [k, clone(data[k])])); },
    set: async values => { await hooks[`${name}Set`]?.(values); Object.assign(data, clone(values)); } });
  let listener;
  const chrome = {
    runtime: { id: "fixture", getURL: value => `chrome-extension://fixture/${value}`, getManifest: () => ({ version: "0.1.50" }),
      onInstalled: event, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: area(local, "local"), session: area(session, "session") },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: { onRemoved: event, onCreated: event, onUpdated: event, query: async () => [],
      get: async () => ({ id: 1, windowId: 1, url: "https://xinhuo123.com/tasks/a", status: "complete" }),
      sendMessage: async (_id, message) => { actions.push(message.type); return { ok: true, claimProtocol: 1, path: "/tasks/a" }; } }
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, setTimeout, clearTimeout, importScripts() {} });
  vm.runInContext(source, c); await vm.runInContext("runtimeStateReady", c);
  const read = expression => vm.runInContext(expression, c);
  const send = message => new Promise(resolve => listener(message, { id: "fixture", url: "chrome-extension://fixture/src/debug/debug.html" }, resolve));
  return { c, read, local, session, hooks, actions, send, state: () => read("runtimeState"),
    activate: (mode = "auto", taskType = "评论") => {
      c.fixtureTaskType = taskType; c.fixtureMode = mode;
      read('runtimeState = { ...createInitialState(), runId: "run", running: true, mode: fixtureMode, xinhuoTabId: 1, windowId: 1, currentTask: { taskType: fixtureTaskType, taskKey: "/tasks/a", tweetUrl: "https://x.com/a/status/123" } };');
    },
    claim: taskType => c.recordXinhuoClaimIntent({ runId: "run", task: { taskKey: "/tasks/a", tweetUrl: "https://x.com/a/status/123", taskType } },
      { id: "fixture", url: "https://xinhuo123.com/tasks/a", tab: { id: 1 }, frameId: 0 }) };
}

for (const failure of ["cleared", "read-error"]) test(`claim intent refuses an automatic candidate after credential ${failure}`, async () => {
  const h = await fixture(); h.activate();
  if (failure === "cleared") h.local[key] = "";
  else h.hooks.localGet = keys => { if (keys.includes("settings")) throw Error("fixture unavailable"); };
  const result = await h.claim("评论");
  assert.equal(result.ok, false); assert.match(result.error, /API Key|会话/);
  assert.equal(h.state().uncertainAction, undefined);
  assert.equal(h.local.xinhuoAutoRunStateV1?.uncertainAction, undefined);
});

for (const taskType of ["评论", "评论+点赞", ""]) test(`claim intent rejects keyless debug ${taskType || "unknown"} candidates`, async () => {
  const h = await fixture(); h.activate("debug", taskType); h.local[key] = "";
  assert.equal((await h.claim(taskType)).ok, false); assert.equal(h.state().uncertainAction, undefined);
});

test("claim intent still accepts a known interaction-only debug candidate without an AI Key", async () => {
  const h = await fixture(); h.activate("debug", "点赞"); h.local[key] = "";
  assert.equal((await h.claim("点赞")).ok, true); assert.equal(h.state().uncertainAction?.taskKey, "/tasks/a");
});

test("STOP invalidates a claim intent waiting on its credential read", async () => {
  const h = await fixture(); h.activate(); const gate = deferred(); let reads = 0;
  h.hooks.localGet = async keys => { if (keys.includes("settings")) { reads++; await gate.promise; } };
  const pending = h.claim("评论"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, "claim authorization must consult current credential settings");
  await h.send({ type: "STOP_RUN" }); const stopped = h.state(); gate.resolve();
  assert.equal((await pending).ok, false); assert.equal(h.state(), stopped);
  assert.equal(stopped.uncertainAction, undefined); assert.equal(stopped.running, false);
});

test("a stalled old GET cannot block an explicit new START after STOP", async () => {
  const h = await fixture();
  await h.c.getSettings();
  const entered = deferred(), gate = deferred(); let reads = 0;
  h.hooks.localGet = async keys => { if (keys.includes("settings") && ++reads === 1) { entered.resolve(); await gate.promise; } };
  const oldGet = h.c.getSettings(); await entered.promise;
  await h.send({ type: "STOP_RUN" });
  let scans = 0; h.c.runNextXinhuoTask = async () => { scans++; return { ok: true }; };
  const newStart = h.send({ type: "START_RUN", clientWindowId: 1 });
  const timeout = Symbol("blocked");
  const result = await Promise.race([newStart, new Promise(resolve => setTimeout(() => resolve(timeout), 100))]);
  gate.resolve(); await oldGet; await newStart;
  assert.notEqual(result, timeout, "new explicit START must not await the old GET");
  assert.equal(result.ok, true); assert.equal(scans, 1);
});

test("a GET snapshot overlapping an in-flight SAVE cannot return the previous key", async () => {
  const h = await fixture(); await h.c.getSettings();
  const entered = deferred(), gate = deferred();
  h.hooks.localSet = async values => { if (Object.hasOwn(values, key)) { entered.resolve(); await gate.promise; } };
  const saving = h.send({ type: "SAVE_SETTINGS", settings: { aiApiKey: "", aiApiUrl: "https://api.vayne.cc.cd/v1/responses" } });
  await entered.promise;
  const reading = h.c.getSettings(); await new Promise(resolve => setImmediate(resolve));
  gate.resolve(); assert.equal((await saving).ok, true);
  assert.equal((await reading).aiApiKey, "");
});

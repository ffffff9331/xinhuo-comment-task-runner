"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const local = { settings: { aiApiUrl: "https://api.vayne.cc.cd/v1/responses", aiModel: "selected-model", replyMode: "post", autoSubmitXinhuo: true } };
  const session = { xinhuoAiApiKeyV1: "fixture-key" }, hooks = {};
  const event = { addListener() {} };
  const area = (data, name) => ({
    async setAccessLevel() {},
    async get(keys) {
      await hooks[`${name}Get`]?.(keys);
      return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])]));
    },
    async set(values) { await hooks[`${name}Set`]?.(values); Object.assign(data, clone(values)); }
  });
  let listener;
  const chrome = {
    runtime: { id: "fixture", getURL: value => `chrome-extension://fixture/${value}`, onInstalled: event,
      onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: area(local, "local"), session: area(session, "session") },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: { onRemoved: event, onCreated: event, onUpdated: event, query: async () => [], sendMessage: async () => ({ ok: true }) }
  };
  const context = vm.createContext({ chrome, console, URL, AbortController, setTimeout, clearTimeout, importScripts() {} });
  vm.runInContext(source, context);
  await vm.runInContext("runtimeStateReady", context);
  const send = message => new Promise(resolve => listener(message, { id: "fixture", url: "chrome-extension://fixture/src/debug/debug.html" }, resolve));
  return { context, hooks, send };
}

test("STOP followed by a fresh START does not await an old GET revalidating after SAVE", async () => {
  const h = await fixture();
  assert.equal((await h.send({ type: "GET_STATE" })).ok, true);
  const saveEntered = deferred(), saveGate = deferred(), revalidationEntered = deferred(), revalidationGate = deferred();
  const pending = [];
  let timeout;
  try {
    h.hooks.localSet = async values => { if (Object.hasOwn(values, "xinhuoAiApiKeyV1")) { saveEntered.resolve(); await saveGate.promise; } };
    const saving = h.send({ type: "SAVE_SETTINGS", settings: { aiApiKey: "new-fixture-key" } });
    pending.push(saving);
    await saveEntered.promise;
    let reads = 0;
    h.hooks.localGet = async keys => {
      if (keys.includes("settings") && ++reads === 2) { revalidationEntered.resolve(); await revalidationGate.promise; }
    };
    const oldGet = h.send({ type: "GET_STATE" });
    pending.push(oldGet);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, "the old GET has read a snapshot while SAVE is pending");
    saveGate.resolve();
    assert.equal((await saving).ok, true);
    await revalidationEntered.promise;

    assert.equal((await h.send({ type: "STOP_RUN" })).ok, true);
    let scans = 0;
    h.context.runNextXinhuoTask = async () => { scans++; return { ok: true }; };
    const starting = h.send({ type: "START_RUN", clientWindowId: 1 });
    pending.push(starting);
    const blocked = Symbol("blocked by old GET");
    const result = await Promise.race([starting, new Promise(resolve => { timeout = setTimeout(() => resolve(blocked), 200); })]);
    assert.notEqual(result, blocked, "a fresh explicit START must finish its settings preflight without releasing the old GET");
    assert.equal(result.ok, true);
    assert.equal(scans, 1);
  } finally {
    clearTimeout(timeout);
    saveGate.resolve();
    revalidationGate.resolve();
    await Promise.allSettled(pending);
  }
});

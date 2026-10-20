"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
const STORED_KEY = "xinhuoAiApiKeyV1";
const endpoint = "https://api.vayne.cc.cd/v1/responses";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(options = {}) {
  const local = options.local || { settings: { aiApiUrl: endpoint, aiApiKey: "legacy-fixture-key", aiModel: "chosen-model", replyMode: "post", autoSubmitXinhuo: true } };
  const session = options.session || {};
  const actions = [], hooks = options.hooks || {}, callbacks = {};
  const event = { addListener() {} };
  const area = (name, data) => ({
    async setAccessLevel(value) { actions.push([`${name}-access`, clone(value)]); await hooks[`${name}Access`]?.(); },
    async get(keys) { await hooks[`${name}Get`]?.(keys); return Object.fromEntries(keys.filter(key => own(data, key)).map(key => [key, clone(data[key])])); },
    async set(values) { actions.push([`${name}-write`, clone(values)]); await hooks[`${name}Set`]?.(values); Object.assign(data, clone(values)); }
  });
  const chrome = {
    runtime: { id: "fixture", getURL: value => `chrome-extension://fixture/${value}`, getManifest: () => ({ version: "0.1.50" }),
      onInstalled: { addListener(fn) { callbacks.install = fn; } }, onMessage: { addListener(fn) { callbacks.message = fn; } } },
    storage: { local: area("local", local), ...(options.noSession ? {} : { session: area("session", session) }) },
    sidePanel: { setPanelBehavior: async () => {} },
    alarms: { onAlarm: event, create: async () => actions.push(["alarm-create"]), clear: async () => actions.push(["alarm-clear"]) },
    tabs: { onRemoved: event, onCreated: event, onUpdated: event, query: async () => [],
      get: async id => ({ id, windowId: 1, url: "https://xinhuo123.com/tasks/a", status: "complete" }),
      update: async () => { actions.push(["navigation"]); throw Error("unexpected navigation"); },
      create: async () => { actions.push(["navigation"]); throw Error("unexpected navigation"); },
      sendMessage: async (_id, message) => { actions.push(["content", clone(message)]); return { ok: true }; } },
    windows: { update: async () => { actions.push(["navigation"]); } },
    scripting: { executeScript: async () => { actions.push(["injection"]); } }
  };
  const context = vm.createContext({ chrome, console, URL, AbortController, setTimeout, clearTimeout, importScripts() {},
    generateLighthouseAIReply: async () => { actions.push(["ai"]); return { replyText: "fixture", diagnostics: [] }; } });
  vm.runInContext(source, context);
  await vm.runInContext("runtimeStateReady", context);
  const read = expression => vm.runInContext(expression, context);
  const send = (message, sender = { id: "fixture", url: "chrome-extension://fixture/src/debug/debug.html" }) =>
    new Promise(resolve => callbacks.message(message, sender, resolve));
  return { context, read, local, session, actions, hooks, callbacks, send, state: () => read("runtimeState"),
    get: () => send({ type: "GET_STATE" }), save: settings => send({ type: "SAVE_SETTINGS", settings }) };
}
function assertNoPublicSettingsSecret(h) {
  for (const [, value] of h.actions.filter(([name, value]) => name === "local-write" && own(value, "settings")))
    assert.equal(own(value.settings, "aiApiKey"), false, "public settings must not include the API Key property");
  assert.equal(own(h.local.settings, "aiApiKey"), false);
}

test("legacy key migrates to trusted dedicated local storage before settings cleanup", async () => {
  const h = await fixture();
  const response = await h.get();
  assert.equal(response.ok, true); assert.equal(response.settings.aiApiKey, "legacy-fixture-key");
  assert.equal(h.local[STORED_KEY], "legacy-fixture-key"); assertNoPublicSettingsSecret(h);
  const writes = h.actions.filter(([name]) => name.endsWith("-write"));
  assert.equal(writes[0][0], "local-write");
  assert.equal(writes[0][1][STORED_KEY], "legacy-fixture-key");
  assert.ok(h.actions.some(([name, value]) => name === "local-access" && value.accessLevel === "TRUSTED_CONTEXTS"));
  assert.equal(response.settings.aiModel, "chosen-model");
  assert.equal(own(h.context.toContentSettings(response.settings), "aiApiKey"), false);
});

for (const value of ["newer-session-fixture", ""]) test(`existing session ${value ? "key" : "explicit clear"} wins over legacy local`, async () => {
  const h = await fixture({ session: { [STORED_KEY]: value } });
  assert.equal((await h.get()).settings.aiApiKey, value); assert.equal(h.local[STORED_KEY], value); assertNoPublicSettingsSecret(h);
});

test("a legacy key for another provider URL is discarded instead of migrated to the relay", async () => {
  const h = await fixture({ local: { settings: { aiApiUrl: "https://old-provider.example/v1", aiApiKey: "wrong-provider-fixture" } } });
  assert.equal((await h.get()).settings.aiApiKey, "");
  assert.notEqual(h.local[STORED_KEY], "wrong-provider-fixture"); assertNoPublicSettingsSecret(h);
});

test("dedicated local migration write failure preserves legacy key, reports failure and never falls back", async () => {
  const h = await fixture({ hooks: { localSet(values) { if (own(values, STORED_KEY)) throw Error("storage failure with legacy-fixture-key"); } } });
  const response = await h.get();
  assert.equal(response.ok, false); assert.match(response.error, /本地|保存/i);
  assert.equal(response.error.includes("legacy-fixture-key"), false);
  assert.equal(h.local.settings.aiApiKey, "legacy-fixture-key"); assert.equal(own(h.local, STORED_KEY), false);
});

test("settings cleanup failure retries without reimporting old session or legacy keys over dedicated local", async () => {
  const hooks = { localSet(values) { if (values.settings) throw Error("cleanup failed"); } };
  const h = await fixture({ hooks });
  assert.equal((await h.get()).ok, false); assert.equal(h.local[STORED_KEY], "legacy-fixture-key");
  h.local[STORED_KEY] = "newer-local-fixture"; h.session[STORED_KEY] = "changed-old-session"; delete hooks.localSet;
  assert.equal((await h.get()).settings.aiApiKey, "newer-local-fixture"); assertNoPublicSettingsSecret(h);
});

test("SAVE replaces, preserves omitted, and clears keys only in dedicated local storage", async () => {
  const h = await fixture();
  assert.equal((await h.save({ aiApiUrl: endpoint, aiApiKey: "replacement-fixture", aiModel: "custom-model" })).ok, true);
  assert.equal(h.local[STORED_KEY], "replacement-fixture");
  let result = await h.save({ aiApiUrl: endpoint, aiModel: "another-model" });
  assert.equal(result.settings.aiApiKey, "replacement-fixture"); assert.equal(result.settings.aiModel, "another-model");
  result = await h.save({ aiApiUrl: endpoint, aiApiKey: "" });
  assert.equal(result.settings.aiApiKey, ""); assert.equal(h.local[STORED_KEY], ""); assertNoPublicSettingsSecret(h);
});

test("failed dedicated local SAVE preserves the prior credential and returns a visible error", async () => {
  const h = await fixture(); await h.get();
  h.hooks.localSet = values => { if (own(values, STORED_KEY)) throw Error("replacement-fixture failed"); };
  const result = await h.save({ aiApiUrl: endpoint, aiApiKey: "replacement-fixture" });
  assert.equal(result.ok, false); assert.equal(h.local[STORED_KEY], "legacy-fixture-key");
  assert.equal(result.error.includes("replacement-fixture"), false); assertNoPublicSettingsSecret(h);
});

for (const value of ["replacement-fixture", ""]) test(`GET and SAVE serialize so ${value ? "replacement" : "clear"} wins over delayed migration`, async () => {
  const entered = deferred(), release = deferred(); let reads = 0;
  const h = await fixture({ hooks: { async localGet(keys) { if (keys.includes("settings") && ++reads === 1) { entered.resolve(); await release.promise; } } } });
  const reading = h.get();
  // The assertion fails immediately on the old implementation instead of waiting forever for a credential read.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, "GET must consult dedicated local storage"); await entered.promise;
  const saving = h.save({ aiApiUrl: endpoint, aiApiKey: value });
  const afterSaveRead = h.get(); release.resolve();
  assert.equal((await reading).ok, true); assert.equal((await saving).ok, true);
  assert.equal((await afterSaveRead).settings.aiApiKey, value); assert.equal(h.local[STORED_KEY], value); assertNoPublicSettingsSecret(h);
});

for (const failure of ["missing", "access", "read"]) test(`local credential ${failure} failure blocks credentials but STOP remains available`, async () => {
  const h = await fixture();
  if (failure === "missing") delete h.context.chrome.storage.local.get;
  if (failure === "access") h.hooks.localAccess = () => { throw Error("access denied"); };
  if (failure === "read") h.hooks.localGet = keys => { if (keys.includes("settings")) throw Error("read failed"); };
  assert.equal((await h.get()).ok, false);
  assert.equal((await h.send({ type: "STOP_RUN" })).ok, true);
  assert.equal(h.state().manuallyStopped, true); assert.equal(h.state().running, false);
});

test("worker restart and a fresh browser session retain the dedicated local credential", async () => {
  const first = await fixture(); await first.get();
  const restarted = await fixture({ local: first.local, session: first.session });
  assert.equal((await restarted.get()).settings.aiApiKey, "legacy-fixture-key");
  const fresh = await fixture({ local: first.local, noSession: true });
  assert.equal((await fresh.get()).settings.aiApiKey, "legacy-fixture-key");
  let scans = 0;
  fresh.context.runNextXinhuoTask = async () => { scans++; return { ok: true }; };
  assert.equal((await fresh.send({ type: "START_RUN", clientWindowId: 1 })).ok, true);
  assert.equal(scans, 1);
});

test("an explicitly cleared local credential blocks full start and comment claim", async () => {
  const fresh = await fixture({ local: { [STORED_KEY]: "", settings: { aiApiUrl: endpoint, replyMode: "post", autoSubmitXinhuo: true } } });
  assert.equal((await fresh.get()).settings.aiApiKey, "");
  assert.equal((await fresh.send({ type: "START_RUN", clientWindowId: 1 })).ok, false);
  await fresh.send({ type: "STOP_RUN" });
  const claim = await fresh.send({ type: "DEBUG_XINHUO_CLAIM_OPEN_X", clientWindowId: 1 });
  assert.equal(claim.ok, false); assert.match(claim.error, /API Key/);
  assert.equal(fresh.state().manuallyStopped, true);
  assert.equal(fresh.actions.some(([name]) => name === "navigation" || name === "ai"), false);
});

test("credential read failure during START leaves no active runner", async () => {
  const h = await fixture({ hooks: { localGet(keys) { if (keys.includes("settings")) throw Error("read failed"); } } });
  const result = await h.send({ type: "START_RUN", clientWindowId: 1 });
  assert.equal(result.ok, false); assert.equal(h.state().running, false);
  assert.equal(h.actions.some(([name]) => name === "navigation" || name === "alarm-create"), false);
});

test("STOP preserves the persistent credential and completed history", async () => {
  const h = await fixture(); await h.get(); h.local.xinhuoReplyHistoryRecords = [{ id: "completed" }];
  assert.equal((await h.send({ type: "STOP_RUN" })).ok, true);
  assert.equal(h.local[STORED_KEY], "legacy-fixture-key");
  assert.deepEqual(h.local.xinhuoReplyHistoryRecords, [{ id: "completed" }]);
});

for (const command of ["START_RUN", "DEBUG_XINHUO_CLAIM_OPEN_X"]) test(`STOP during ${command} credential read prevents navigation or claim`, async () => {
  const h = await fixture(); await h.get();
  const entered = deferred(), release = deferred(); let reads = 0;
  h.hooks.localGet = async keys => { if (keys.includes("settings")) { reads++; entered.resolve(); await release.promise; } };
  const pending = h.send({ type: command, clientWindowId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, "preflight must read the credential before any browser action"); await entered.promise;
  await h.send({ type: "STOP_RUN" }); const stopState = h.state(); const actionsAfterStop = h.actions.length;
  release.resolve(); await pending;
  assert.equal(h.state(), stopState); assert.equal(h.state().running, false); assert.equal(h.state().manuallyStopped, true);
  assert.equal(h.actions.slice(actionsAfterStop).some(([name]) => ["navigation", "content", "ai", "alarm-create"].includes(name)), false);
});

test("an empty dedicated local key prevents direct AI calls", async () => {
  const h = await fixture({ local: { [STORED_KEY]: "", settings: { aiApiUrl: endpoint } } });
  h.read('runtimeState.running = true; runtimeState.runId = "test-run";');
  const result = await h.send({ type: "GENERATE_AI_REPLY", runId: "test-run", tweet: {}, task: {} });
  assert.equal(result.ok, false); assert.match(result.error, /API Key|会话/);
  assert.equal(h.actions.some(([name]) => name === "ai"), false);
});

test("installation uses the same safe migration and never stores a key inside public settings", async () => {
  const h = await fixture(); await h.callbacks.install();
  assert.equal(h.local[STORED_KEY], "legacy-fixture-key"); assertNoPublicSettingsSecret(h);
});

function declaration(text, name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(text); assert.ok(start, name);
  const next = /^(?:async )?function \w+\(/gm; next.lastIndex = start.index + start[0].length;
  return text.slice(start.index, next.exec(text)?.index ?? text.length);
}
for (const failure of ["response", "throw"]) test(`popup ${failure} from SAVE is visible and never starts a run`, async () => {
  const popup = fs.readFileSync(path.join(__dirname, "../src/popup/popup.js"), "utf8");
  const messages = [], statuses = [], status = { textContent: "" };
  const c = vm.createContext({ chrome: { runtime: { sendMessage: async message => {
    messages.push(message.type);
    if (message.type === "GET_STATE") return { ok: true, settings: { aiApiUrl: endpoint }, state: {} };
    if (message.type === "SAVE_SETTINGS") { if (failure === "throw") throw Error("fixture save failed"); return { ok: false, error: "fixture save failed" }; }
    return { ok: true };
  } } }, readSettings: () => ({ aiApiKey: "fixture" }), loadState: async () => {}, withClientWindowId: async value => value,
    showSaveStatus: value => statuses.push(value), saveStatus: status, statusBadge: status, settingsStatus: status,
    document: { getElementById: () => status } });
  vm.runInContext(declaration(popup, "saveSettings") + declaration(popup, "startRun"), c);
  await c.startRun();
  assert.equal(messages.includes("START_RUN"), false);
  assert.match(statuses.join(" ") + status.textContent, /fixture save failed|保存失败/);
});

test("sidebar SAVE failure stays visible without clearing dirty fields", async () => {
  const sidebar = fs.readFileSync(path.join(__dirname, "../src/debug/debug.js"), "utf8");
  const statuses = [];
  const c = vm.createContext({ commandGeneration: 0, settingsDirty: true, readSettings: () => ({ aiApiUrl: endpoint }),
    requestCustomAIHostPermission: async () => true,
    chrome: { runtime: { sendMessage: async () => ({ ok: false, error: "fixture local save failed" }) } },
    showSaveStatus: value => statuses.push(value), showCommandStatus: value => statuses.push(value), renderSettings() {} });
  vm.runInContext(declaration(sidebar, "saveSettings"), c);
  assert.equal(await c.saveSettings(), false); assert.equal(c.settingsDirty, true);
  assert.match(statuses.join(" "), /fixture local save failed|保存失败/);
});

for (const scenario of [
  { name: "successful replacement", key: "fixture-replacement", failLocal: false },
  { name: "explicit clear", key: "", failLocal: false },
  { name: "dedicated key saved but public settings rejected", key: "fixture-partial", failLocal: true }
]) {
  test(`a delayed GET rebases after ${scenario.name}`, async () => {
    const h = await fixture({ session: { [STORED_KEY]: "fixture-before" } });
    await h.get();
    const before = clone(h.local.settings);
    const entered = deferred(), release = deferred();
    const storage = h.context.chrome.storage.local;
    const readStored = storage.get;
    let captureOnce = true;
    storage.get = async keys => {
      const snapshot = await readStored(keys);
      if (captureOnce && keys.includes("settings")) {
        captureOnce = false;
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    };
    const reading = h.get();
    await entered.promise;
    if (scenario.failLocal) h.hooks.localSet = async values => {
      if (values.settings) throw Error("fixture local save failure");
    };
    try {
      const saved = await h.save({ aiApiKey: scenario.key, aiModel: "replacement-model" });
      assert.equal(saved.ok, !scenario.failLocal);
      if (scenario.failLocal) assert.match(saved.error, /配置保存|清理失败/);
    } finally {
      delete h.hooks.localSet;
      release.resolve();
    }
    const refreshed = await reading;
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.settings.aiApiKey, scenario.key, "an old snapshot must not resurrect the previous credential");
    assert.equal(h.local[STORED_KEY], scenario.key);
    assert.equal(refreshed.settings.aiModel, scenario.failLocal ? before.aiModel : "replacement-model");
    if (scenario.failLocal) assert.deepEqual(h.local.settings, before);
    assertNoPublicSettingsSecret(h);
  });
}

for (const value of ["dedicated-fixture", ""]) {
  for (const oldSession of ["old-session-fixture", ""]) test(`dedicated local ${value ? "key" : "clear"} overrides old session ${oldSession ? "key" : "clear"} and legacy settings`, async () => {
    const h = await fixture({ local: { [STORED_KEY]: value, settings: { aiApiUrl: endpoint, aiApiKey: "legacy-fixture" } },
      session: { [STORED_KEY]: oldSession }, hooks: { sessionGet() { throw Error("must not read old session"); }, sessionAccess() { throw Error("must not access old session"); } } });
    assert.equal((await h.get()).settings.aiApiKey, value);
    assert.equal(h.local[STORED_KEY], value);
    assertNoPublicSettingsSecret(h);
    assert.equal(h.actions.some(([name]) => name === "session-access" || name === "session-write"), false);
  });
}

test("missing old session storage falls back to a legacy settings key", async () => {
  const h = await fixture({ noSession: true });
  assert.equal((await h.get()).settings.aiApiKey, "legacy-fixture-key");
  assert.equal(h.local[STORED_KEY], "legacy-fixture-key");
  assertNoPublicSettingsSecret(h);
});

for (const failure of ["access", "read"]) test(`old session migration ${failure} failure is explicit and retains legacy data`, async () => {
  const h = await fixture({ hooks: failure === "access"
    ? { sessionAccess() { throw Error("legacy-fixture-key access failure"); } }
    : { sessionGet() { throw Error("legacy-fixture-key read failure"); } } });
  const result = await h.get();
  assert.equal(result.ok, false);
  assert.match(result.error, /迁移读取失败/);
  assert.equal(result.error.includes("legacy-fixture-key"), false);
  assert.equal(h.local.settings.aiApiKey, "legacy-fixture-key");
  assert.equal(own(h.local, STORED_KEY), false);
  assert.equal((await h.send({ type: "STOP_RUN" })).ok, true);
});

test("session migration only needs read access and survives a later empty session", async () => {
  const h = await fixture({ session: { [STORED_KEY]: "session-to-persistent-fixture" } });
  delete h.context.chrome.storage.session.set;
  assert.equal((await h.get()).settings.aiApiKey, "session-to-persistent-fixture");
  const restarted = await fixture({ local: h.local, session: {} });
  assert.equal((await restarted.get()).settings.aiApiKey, "session-to-persistent-fixture");
  assertNoPublicSettingsSecret(restarted);
});

test("successful clear remains authoritative after browser restart even when old sources remain", async () => {
  const h = await fixture({ session: { [STORED_KEY]: "old-session-fixture" } });
  assert.equal((await h.save({ aiApiKey: "" })).ok, true);
  h.local.settings.aiApiKey = "stale-settings-fixture";
  const restarted = await fixture({ local: h.local, session: h.session });
  assert.equal((await restarted.get()).settings.aiApiKey, "");
  assert.equal(restarted.local[STORED_KEY], "");
  assertNoPublicSettingsSecret(restarted);
});

test("settings cleanup retry does not reimport a changed session over the persisted migration", async () => {
  const h = await fixture({ session: { [STORED_KEY]: "migrated-fixture" }, hooks: { localSet(value) { if (value.settings) throw Error("cleanup failed"); } } });
  assert.equal((await h.get()).ok, false);
  assert.equal(h.local[STORED_KEY], "migrated-fixture");
  h.session[STORED_KEY] = "later-old-session-fixture";
  delete h.hooks.localSet;
  assert.equal((await h.get()).settings.aiApiKey, "migrated-fixture");
  assertNoPublicSettingsSecret(h);
});

test("dedicated credentials never enter runtime snapshots or content settings", async () => {
  const h = await fixture();
  const result = await h.get();
  await h.save({ aiApiKey: "private-fixture-key" });
  await h.send({ type: "STOP_RUN" });
  assert.equal(JSON.stringify(h.local.xinhuoAutoRunStateV1).includes("private-fixture-key"), false);
  assert.equal(own(h.context.toContentSettings(result.settings), "aiApiKey"), false);
  assertNoPublicSettingsSecret(h);
});

for (const page of ["popup/popup", "debug/debug"]) test(`${page} keeps the API Key input password-masked with persistence guidance`, () => {
  const html = fs.readFileSync(path.join(__dirname, `../src/${page}.html`), "utf8");
  const input = html.match(/<input\b[^>]*\bid="aiApiKey"[^>]*>/);
  assert.ok(input, "the credential field remains available");
  assert.match(input[0], /\btype="password"/);
  assert.match(input[0], /\bautocomplete="off"/);
  assert.match(html, /重启浏览器或重载扩展后仍保留/);
  assert.doesNotMatch(html, /重载、更新、停用扩展后需重新填写/);
});

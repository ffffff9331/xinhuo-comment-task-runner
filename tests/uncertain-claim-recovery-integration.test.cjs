"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const STATE_KEY = "xinhuoAutoRunStateV1";
const ORIGIN = "https://xinhuo123.com";
const TASK_PATH = "/tasks/recovery-fixture";
const TARGET = "https://x.com/fixture/status/1234567890123456789";
const OTHER_TARGET = "https://x.com/other/status/1234567890123456790";
const OLD_RUN = "interrupted-claim-run";
const INSPECT = "XINHUO_INSPECT_CURRENT_TASK";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const version = JSON.parse(read("manifest.json")).version;

// A tiny DOM models only browser boundaries. Both complete production scripts
// and both real message listeners execute without extracting or replacing any
// recovery, parser, persistence, START, or STOP function.
class Node {
  constructor(tag, text = "", attributes = {}, children = []) {
    this.tagName = tag.toUpperCase(); this.text = text; this.attributes = attributes;
    this.children = []; this.parentElement = null; this.isConnected = true;
    this.disabled = Boolean(attributes.disabled); this.hidden = Boolean(attributes.hidden);
    for (const child of children) this.append(child);
  }
  append(child) { child.parentElement = this; this.children.push(child); }
  get innerText() { return [this.text, ...this.children.map(child => child.innerText)].filter(Boolean).join("\n"); }
  get textContent() { return this.innerText; }
  get href() { return this.attributes.href || ""; }
  get className() { return this.attributes.class || ""; }
  getAttribute(name) { return name in this.attributes ? String(this.attributes[name]) : null; }
  getBoundingClientRect() { return { width: this.hidden ? 0 : 400, height: this.hidden ? 0 : 40 }; }
  matches(selector) {
    return selector.split(",").some(part => {
      const rule = part.trim(); if (rule === "*") return true;
      const tag = rule.match(/^[A-Za-z][\w-]*/)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const outsideAttributes = rule.replace(/\[[^\]]*\]/g, "");
      for (const match of outsideAttributes.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(match[1])) return false;
      for (const match of rule.matchAll(/\[([\w-]+)(?:(\*=|=)["']?([^\]"']*)["']?)?\]/g)) {
        const value = this.getAttribute(match[1]);
        if (value === null || (match[2] === "=" && value !== match[3]) || (match[2] === "*=" && !value.includes(match[3]))) return false;
      }
      return Boolean(tag || rule.startsWith(".") || rule.startsWith("["));
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  scrollIntoView() {}
  click() { throw new Error("Inspection must never click a DOM control"); }
}

function contentPage(kind = "unclaimed", options = {}) {
  const controls = [], statuses = [];
  const button = text => { const node = new Node("button", text); controls.push(node); return node; };
  if (kind === "unclaimed") button("接取评论任务");
  if (kind === "claimed") { button("提交并使用 X API 核验"); button("放弃订单"); }
  if (kind === "pending") statuses.push("待复核");
  if (kind === "completed") statuses.push("该任务已完成");
  if (kind === "expired") statuses.push("订单已过期");
  if (kind === "rejected") statuses.push("核验失败");
  if (kind === "loading") statuses.push("加载中");
  const panel = new Node("aside", "", { class: "reward-panel" }, [
    new Node("h2", "本单任务"), ...statuses.map(text => new Node("p", text, { class: "message" })), ...controls,
  ]);
  const main = new Node("main", "评论任务 0.2 KX", {}, [
    new Node("a", "目标推文", { href: options.tweetUrl || TARGET }), panel,
  ]);
  const body = new Node("body", "", {}, [main]);
  const html = new Node("html", "", {}, [body]);
  const location = { origin: ORIGIN, pathname: options.path || TASK_PATH,
    href: ORIGIN + (options.path || TASK_PATH) };
  const listeners = new Set();
  const context = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout,
    HTMLElement: Node, Element: Node, location, window: { addEventListener() {} },
    document: { readyState: "complete", body, documentElement: html,
      querySelector: selector => html.querySelector(selector), querySelectorAll: selector => html.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node.hidden ? "none" : "block", visibility: "visible", opacity: "1" }),
    fetch: async () => { throw Error("Network forbidden in recovery integration tests"); },
    chrome: { runtime: { id: "fixture", getURL: value => `chrome-extension://fixture/${value}`,
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) },
      sendMessage: async () => { throw Error("Read-only inspection must not dispatch background actions"); } } },
  });
  vm.runInContext(read("src/content/xinhuo.js"), context, { filename: "xinhuo.js" });
  const send = message => new Promise(resolve => {
    const listener = [...listeners][0];
    const handled = listener(message, {}, resolve);
    if (!handled) resolve({ ok: false, unhandled: true });
  });
  return { context, panel, body, location, send };
}

async function worker(t, options = {}) {
  const session = {};
  const page = contentPage(options.kind, options.page);
  const callbacks = [], sent = [], mutations = [], writes = [], hooks = {}, alarms = [];
  const stored = { settings: { settingsVersion: 5, aiApiUrl: "https://api.vayne.cc.cd/v1/responses",
    aiApiKey: "fixture-only-key", replyMode: "post", autoSubmitXinhuo: true, runWindowEnabled: false } };
  if (options.stored) Object.assign(stored, clone(options.stored));
  const tab = { id: 11, windowId: 1, active: true, status: "complete", url: page.location.href };
  const tabs = new Map([[tab.id, tab]]);
  const event = { addListener() {} };
  const scans = [], scanned = deferred();
  let backgroundListener;
  const chrome = {
    runtime: { id: "fixture", getURL: value => `chrome-extension://fixture/${value}`,
      getManifest: () => ({ version }), onInstalled: event,
      onMessage: { addListener: fn => { backgroundListener = fn; } } },
    storage: { local: {
      async setAccessLevel() {}, async get(keys) {
        await hooks.read?.(keys);
        return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, clone(stored[key])]));
      },
      async set(values, callback) {
        const captured = clone(values); writes.push(captured);
        try { await hooks.save?.(captured); Object.assign(stored, captured); callback?.(); }
        catch (error) { if (callback) { chrome.runtime.lastError = { message: error.message }; callback(); delete chrome.runtime.lastError; } else throw error; }
      },
    }, session: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(session, key)).map(key => [key, clone(session[key])])); },
      async set(values) { Object.assign(session, clone(values)); }
    } },
    alarms: { onAlarm: event, async create(name) { alarms.push({ type: "create", name }); },
      async clear(name) { alarms.push({ type: "clear", name }); } },
    windows: { async get(id) { return { id }; }, async update(id) { return { id }; } },
    tabs: { onRemoved: event, onCreated: event, onUpdated: event,
      async get(id) { if (!tabs.has(id)) throw Error("No tab"); await hooks.get?.(id); return clone(tabs.get(id)); },
      async query(query) { return [...tabs.values()].filter(value =>
        (!Number.isInteger(query.windowId) || value.windowId === query.windowId)
        && (!query.active || value.active)
        && (!query.url || value.url.startsWith(ORIGIN))).map(clone); },
      async update(id, properties) {
        mutations.push({ type: "update", id, ...clone(properties) }); Object.assign(tabs.get(id), properties);
        if (properties.url) { page.location.href = properties.url; page.location.pathname = new URL(properties.url).pathname; }
        return clone(tabs.get(id));
      },
      async create(properties) { mutations.push({ type: "create", ...clone(properties) }); throw Error("Unexpected tab creation"); },
      async reload(id) {
        const target = tabs.get(id);
        assert.equal(target?.windowId, 1, "fresh inspection must remain in the saved window");
        assert.equal(target?.url, ORIGIN + TASK_PATH, "only the exact bound order may be refreshed");
        assert.ok(sent.some(message => message.id === id && message.type === "CANCEL_XINHUO_RUN"), "old page work must stop before refresh");
        mutations.push({ type: "reload", id });
      },
      async sendMessage(id, message) {
        sent.push({ id, ...clone(message) });
        if (message.type === "XINHUO_SELECT_AND_CLAIM") {
          const pending = deferred(); scans.push(pending); scanned.resolve({ scan: true });
          return hooks.scan ? hooks.scan(message) : pending.promise;
        }
        if (message.type === INSPECT) {
          const receipt = await page.send(message);
          return hooks.inspect ? hooks.inspect(receipt, message) : receipt;
        }
        if (message.type === "CANCEL_XINHUO_RUN") {
          await hooks.cancel?.(message);
          return page.send(message);
        }
        if (message.type === "CHECK_XINHUO_CONTENT") return page.send(message);
        if (message.type === "DEBUG_XINHUO_CLAIM_CURRENT_TASK") {
          const receipt = await page.send(message);
          return hooks.claimReceipt ? hooks.claimReceipt(receipt, message) : receipt;
        }
        throw Error(`Unexpected page action ${message.type}`);
      },
    },
    scripting: { async executeScript() { throw Error("Healthy current fixture must not be reinjected"); } },
  };
  const context = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout, chrome,
    importScripts() {}, fetch: async (...args) => {
      if (hooks.fetch) return hooks.fetch(...args);
      throw Error("Network forbidden in recovery integration tests");
    } });
  for (const file of ["src/reply-engine.js", "src/background.js"]) vm.runInContext(read(file), context, { filename: file });
  await vm.runInContext("runtimeStateReady", context);
  const oldTask = { platform: "xinhuo", taskKey: TASK_PATH, detailPath: TASK_PATH, tweetUrl: TARGET, claimed: false };
  const intent = { type: options.type || "XINHUO_CLAIM", runId: OLD_RUN, tabId: 11, taskKey: TASK_PATH };
  if (intent.type === "XINHUO_CLAIM") intent.protocol = 1;
  Object.assign(intent, options.intent);
  context.seed = { running: false, mode: "idle", stage: "action_result_unknown", runId: OLD_RUN,
    windowId: 1, xinhuoTabId: 11, currentTask: { ...oldTask, ...options.task }, uncertainAction: intent,
    ...options.runtime };
  if (!options.restore) {
    vm.runInContext("runtimeState = { ...createInitialState(), ...seed }", context);
    stored[STATE_KEY] = clone(vm.runInContext("runtimeState", context));
  }
  const state = () => vm.runInContext("runtimeState", context);
  const send = (message, sender = { id: "fixture", url: "chrome-extension://fixture/src/debug/debug.html" }) => new Promise(resolve => {
    backgroundListener(message, sender, resolve);
  });
  page.context.chrome.runtime.sendMessage = message => send(message, {
    id: "fixture", url: page.location.href, frameId: 0, tab: clone(tab)
  });
  const start = () => { const pending = send({ type: "START_RUN", clientWindowId: 1 }); callbacks.push(pending); return pending; };
  t.after(async () => {
    state().running = false;
    await page.send({ type: "CANCEL_XINHUO_RUN" });
    for (const scan of scans) scan.resolve({ ok: false, cancelled: true });
    await Promise.all(callbacks);
  });
  return { context, page, hooks, stored, state, sent, mutations, writes, scans, start, send, alarms,
    flush: async () => { await vm.runInContext("runtimeStateWriteTail", context); await new Promise(resolve => setImmediate(resolve)); },
    untilScan: () => Promise.race([start(), scanned.promise]),
    scanSignal: scanned.promise, oldIntent: state().uncertainAction,
  };
}

function assertPreserved(w) {
  assert.equal(w.state().running, false);
  assert.equal(w.state().uncertainAction, w.oldIntent);
  assert.equal(w.state().currentTask.taskKey, TASK_PATH);
  assert.equal(w.state().currentTask.tweetUrl, TARGET);
  assert.equal(w.scans.length, 0);
  assert.ok(w.mutations.every(mutation => mutation.type === "reload"), "inspection cannot navigate or create a tab");
  assert.ok(w.mutations.length <= 1, "fresh inspection may refresh only the exact saved order once");
}

for (const type of ["XINHUO_SELECT_AND_CLAIM", "DEBUG_XINHUO_CLAIM_CURRENT_TASK", "XINHUO_CLAIM"]) {
  for (const kind of ["unclaimed", "completed", "expired"]) test(`${type}: START releases only the bound ${kind} order before scanning`, async t => {
    const w = await worker(t, { type, kind });
    const result = await w.untilScan();
    assert.equal(result.scan, true, result.error);
    assert.equal(w.state().uncertainAction, undefined);
    assert.equal(w.state().currentTask, null);
    assert.equal(w.sent.filter(message => message.type === INSPECT).length, 1);
    assert.equal(w.scans.length, 1);
    assert.equal(w.mutations.filter(mutation => mutation.type === "reload").length, 1, "terminal clearance must use a fresh bound detail");
    assert.ok(w.writes.some(write => write[STATE_KEY]?.runId === OLD_RUN && !write[STATE_KEY].uncertainAction), "clearance must be durable before a new run");
  });
  for (const kind of ["claimed", "pending", "loading", "rejected"]) test(`${type}: START preserves ${kind} order and sends no new action`, async t => {
    const w = await worker(t, { type, kind });
    const result = await w.start();
    assert.equal(result.ok, false);
    const reads = w.sent.filter(message => message.type === INSPECT).length;
    if (kind === "loading") assert.ok(reads > 1 && reads <= 20, "persistent loading must be rechecked with a bounded limit");
    else assert.equal(reads, 1, "active, pending, or ambiguous orders must not be repeatedly inspected");
    assertPreserved(w);
  });
}

for (const variant of ["wrong tweet", "wrong path", "wrong window", "missing tweet", "nonclaim action"]) test(`unsafe ${variant} never clears the old intent`, async t => {
  const options = { kind: "unclaimed" };
  if (variant === "wrong tweet") options.page = { tweetUrl: OTHER_TARGET };
  if (variant === "wrong path") options.page = { path: "/tasks/another-order" };
  if (variant === "missing tweet") options.task = { tweetUrl: "" };
  if (variant === "nonclaim action") options.type = "RUN_X_REPLY";
  const w = await worker(t, options);
  if (variant === "wrong window") w.state().windowId = 2;
  const result = await w.start();
  assert.equal(result.ok, false);
  assert.equal(w.state().uncertainAction, w.oldIntent);
  assert.equal(w.scans.length, 0);
  if (variant === "wrong tweet") assert.ok(w.mutations.every(mutation => mutation.type === "reload") && w.mutations.length <= 1);
  else assert.equal(w.mutations.length, 0);
});

test("a cancelled content run can still supply a read-only terminal receipt", async t => {
  const w = await worker(t, { kind: "completed" });
  await w.page.send({ type: "CANCEL_XINHUO_RUN", runId: OLD_RUN });
  const result = await w.untilScan();
  assert.equal(result.scan, true, result.error);
  assert.equal(w.scans.length, 1);
});

test("concurrent START clicks perform one inspection and at most one new scan", async t => {
  const w = await worker(t, { kind: "unclaimed" });
  const entered = deferred(), release = deferred();
  w.hooks.inspect = async receipt => { entered.resolve(); await release.promise; return receipt; };
  const first = w.start();
  const event = await Promise.race([entered.promise.then(() => "inspection"), first.then(() => "returned")]);
  assert.equal(event, "inspection");
  const duplicate = await w.start();
  assert.equal(duplicate.ok, false);
  assert.equal(w.sent.filter(message => message.type === INSPECT).length, 1);
  release.resolve();
  assert.equal((await Promise.race([first, w.scanSignal])).scan, true);
  assert.equal(w.scans.length, 1);
});

test("STOP during inspection wins over its delayed completed receipt", async t => {
  const w = await worker(t, { kind: "completed" });
  const entered = deferred(), release = deferred();
  w.hooks.inspect = async receipt => { entered.resolve(); await release.promise; return receipt; };
  const first = w.start();
  assert.equal(await Promise.race([entered.promise.then(() => "inspection"), first.then(() => "returned")]), "inspection");
  const stop = await w.send({ type: "STOP_RUN" });
  assert.equal(stop.ok, true);
  const stoppedId = w.state().runId;
  release.resolve();
  assert.equal((await first).ok, false);
  assert.equal(w.state().runId, stoppedId);
  assert.equal(w.state().running, false);
  // User contract changed: an explicit STOP discards old run/order data.
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.state().currentTask, null);
  await w.flush();
  assert.equal(w.stored[STATE_KEY].uncertainAction, undefined);
  assert.equal(w.stored[STATE_KEY].currentTask, null);
  assert.equal(w.scans.length, 0);
  assert.equal(w.mutations.length, 1);
  assert.equal(w.mutations[0].type, "reload");
});

test("a late old receipt cannot clear a replacement run's intent or persisted state", async t => {
  const w = await worker(t, { kind: "completed" });
  const entered = deferred(), release = deferred();
  w.hooks.inspect = async receipt => { entered.resolve(); await release.promise; return receipt; };
  const first = w.start();
  assert.equal(await Promise.race([entered.promise.then(() => "inspection"), first.then(() => "returned")]), "inspection");
  w.context.replacement = { ...clone(w.state()), runId: "replacement-run", stage: "replacement-protected",
    uncertainAction: { type: "RUN_X_REPLY", runId: "replacement-run", tabId: 21, taskKey: "/tasks/replacement" },
    currentTask: { taskKey: "/tasks/replacement", detailPath: "/tasks/replacement", tweetUrl: OTHER_TARGET, claimed: true } };
  vm.runInContext("runtimeState = replacement", w.context);
  await w.context.persistRuntimeState(true);
  release.resolve();
  assert.equal((await first).ok, false);
  assert.equal(w.state().runId, "replacement-run");
  assert.equal(w.state().uncertainAction.type, "RUN_X_REPLY");
  assert.equal(w.stored[STATE_KEY].uncertainAction.taskKey, "/tasks/replacement");
  assert.equal(w.scans.length, 0);
});

test("failed durable clearance retains the original unknown order and performs no scan", async t => {
  const w = await worker(t, { kind: "unclaimed" });
  let rejected = false;
  w.hooks.save = async values => {
    const state = values[STATE_KEY];
    if (state?.runId === OLD_RUN && !state.uncertainAction && !rejected) {
      rejected = true; throw Error("fixture storage failure");
    }
  };
  const result = await w.start();
  assert.equal(rejected, true, "must attempt durable clearance before release");
  assert.equal(result.ok, false);
  assertPreserved(w);
  assert.equal(w.stored[STATE_KEY].uncertainAction.runId, OLD_RUN);
});

test("STOP during durable clearance persists the reset after the late old save", async t => {
  const w = await worker(t, { kind: "unclaimed" });
  const entered = deferred(), release = deferred();
  let blocked = false;
  w.hooks.save = async values => {
    const state = values[STATE_KEY];
    if (state?.runId === OLD_RUN && !state.uncertainAction && !blocked) {
      blocked = true; entered.resolve(); await release.promise;
    }
  };
  const first = w.start();
  assert.equal(await Promise.race([entered.promise.then(() => "saving"), first.then(() => "returned")]), "saving");
  const stopping = w.send({ type: "STOP_RUN" });
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await stopping;
  assert.equal((await first).ok, false);
  assert.equal(w.state().running, false);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.state().currentTask, null);
  assert.equal(w.stored[STATE_KEY].runId, w.state().runId);
  assert.equal(w.stored[STATE_KEY].uncertainAction, undefined);
  assert.equal(w.stored[STATE_KEY].currentTask, null);
  assert.equal(w.scans.length, 0);
});

function missingOriginalTab(w, properties = {}) {
  const fallback = { id: 22, windowId: 1, active: true, status: "complete", url: ORIGIN + TASK_PATH, ...properties };
  const tabs = w.context.chrome.tabs;
  tabs.get = async id => { if (id === 11) throw Error("No tab with id: 11"); if (id !== fallback.id) throw Error("No tab"); return clone(fallback); };
  tabs.query = async query => (!Number.isInteger(query.windowId) || query.windowId === fallback.windowId) ? [clone(fallback)] : [];
  tabs.update = async (id, changes) => {
    assert.equal(id, fallback.id);
    w.mutations.push({ type: "update", id, ...clone(changes) });
    Object.assign(fallback, changes);
    if (changes.url) { w.page.location.href = changes.url; w.page.location.pathname = new URL(changes.url).pathname; }
    return clone(fallback);
  };
  tabs.reload = async id => {
    assert.equal(id, fallback.id);
    assert.equal(fallback.windowId, 1);
    assert.equal(fallback.url, ORIGIN + TASK_PATH);
    assert.ok(w.sent.some(message => message.id === id && message.type === "CANCEL_XINHUO_RUN"));
    w.mutations.push({ type: "reload", id });
  };
  return fallback;
}

for (const from of ["same detail", "marketplace"]) test(`a closed original tab can be inspected through the saved window's ${from}`, async t => {
  const w = await worker(t, { kind: "unclaimed" });
  const fallback = missingOriginalTab(w, { url: ORIGIN + (from === "marketplace" ? "/tasks" : TASK_PATH) });
  const result = await w.untilScan();
  assert.equal(result.scan, true, result.error);
  const inspected = w.sent.filter(message => message.type === INSPECT);
  assert.equal(inspected.length, 1);
  assert.equal(inspected[0].id, fallback.id);
  assert.equal(inspected[0].task.taskKey, TASK_PATH);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.scans.length, 1);
  assert.equal(w.mutations.some(mutation => mutation.type === "create"), false);
  assert.equal(w.mutations.filter(mutation => mutation.type === "reload").length, from === "same detail" ? 1 : 0);
});

for (const unsafe of ["missing saved window", "other window", "other detail", "foreign origin"]) test(`closed-tab recovery refuses ${unsafe}`, async t => {
  const w = await worker(t, { kind: "unclaimed" });
  const properties = {};
  if (unsafe === "missing saved window") w.state().windowId = null;
  if (unsafe === "other window") properties.windowId = 2;
  if (unsafe === "other detail") properties.url = ORIGIN + "/tasks/other-order";
  if (unsafe === "foreign origin") properties.url = "https://example.org/tasks";
  missingOriginalTab(w, properties);
  assert.equal((await w.start()).ok, false);
  assertPreserved(w);
});

test("a complete SPA document with a not-yet-mounted panel is rechecked until its bound terminal result loads", async t => {
  const w = await worker(t, { kind: "completed" });
  const main = w.page.panel.parentElement;
  main.children = main.children.filter(node => node !== w.page.panel);
  let reads = 0;
  w.hooks.inspect = receipt => {
    reads += 1;
    if (reads === 1) {
      assert.equal(receipt.inspectionState, "unknown");
      assert.equal(receipt.inspectionLoading, true, "real content must mark hydration separately from terminal ambiguity");
      main.append(w.page.panel);
    }
    return receipt;
  };
  assert.equal((await w.untilScan()).scan, true);
  assert.equal(reads, 2);
  assert.equal(w.scans.length, 1);
  assert.equal(w.state().uncertainAction, undefined);
});

test("an old intent snapshot for order A cannot clear an already claimed current order B", async t => {
  const current = { taskKey: "/tasks/new-order", detailPath: "/tasks/new-order", tweetUrl: OTHER_TARGET, claimed: true };
  const w = await worker(t, { kind: "completed", task: current,
    intent: { task: { taskKey: TASK_PATH, detailPath: TASK_PATH, tweetUrl: TARGET, claimed: false } } });
  const result = await w.untilScan();
  assert.equal(result.ok, false);
  assert.equal(w.state().currentTask.taskKey, current.taskKey);
  assert.equal(w.state().currentTask.tweetUrl, current.tweetUrl);
  assert.equal(w.state().currentTask.claimed, true);
  assert.equal(w.state().uncertainAction, w.oldIntent);
  assert.equal(w.scans.length, 0);
  assert.equal(w.mutations.length, 0);
});

test("an intent snapshot cannot hide a conflicting current claimedDetailPath", async t => {
  const w = await worker(t, { kind: "completed", task: { claimedDetailPath: "/tasks/another-claimed-order", claimed: true },
    intent: { task: { taskKey: TASK_PATH, detailPath: TASK_PATH, tweetUrl: TARGET, claimed: false } } });
  const result = await w.untilScan();
  assert.equal(result.ok, false);
  assert.equal(w.state().currentTask.claimedDetailPath, "/tasks/another-claimed-order");
  assert.equal(w.state().currentTask.claimed, true);
  assert.equal(w.state().uncertainAction, w.oldIntent);
  assert.equal(w.scans.length, 0);
  assert.equal(w.mutations.length, 0);
});

test("STOP still cancels the bound old page when its durable save fails and reports that failure", async t => {
  const w = await worker(t, { kind: "claimed" });
  let rejected = false;
  w.hooks.save = async values => {
    const state = values[STATE_KEY];
    if (!rejected && state?.runId !== OLD_RUN) {
      rejected = true;
      throw Error("fixture STOP storage failure");
    }
  };
  const result = await w.send({ type: "STOP_RUN" });
  assert.equal(rejected, true);
  assert.equal(result.ok, false, "STOP must report a failed durable save instead of claiming full success");
  assert.match(result.error, /storage failure/);
  const cancels = w.sent.filter(message => message.type === "CANCEL_XINHUO_RUN");
  assert.equal(cancels.length, 1, "storage rejection must not skip page cancellation");
  assert.equal(cancels[0].id, 11);
  assert.equal(cancels[0].runId, OLD_RUN);
  assert.equal(w.state().running, false);
  assert.notEqual(w.state().runId, OLD_RUN);
  assert.equal(w.state().uncertainAction, undefined, "failed persistence cannot re-arm the stopped in-memory order");
  assert.equal(w.state().currentTask, null);
  assert.equal(w.stored[STATE_KEY].uncertainAction.runId, OLD_RUN);
  assert.equal(w.scans.length, 0);
  assert.equal(w.mutations.length, 0);
});

// Manual STOP intentionally differs from an automatic uncertain-result pause.
// The user explicitly requested deletion of all old run data before the next
// START, while retaining settings and completed reply history. These assertions
// replace only the prior manual-STOP preservation contract.
function assertRunReset(state) {
  assert.equal(state.running, false);
  assert.equal(state.mode, "idle");
  assert.equal(state.stage, "stopped");
  assert.notEqual(state.runId, OLD_RUN);
  assert.equal(state.uncertainAction, undefined);
  assert.equal(state.currentTask, null);
  assert.equal(state.lastXResult, null);
  assert.equal(state.completionEvidence, null);
  assert.equal(state.pendingXOpen, null);
  assert.equal(state.pendingXSubmission, null);
  assert.equal(state.xinhuoTabId, null);
  assert.equal(state.xTabId, null);
  assert.equal(state.xTabWindowId, null);
  assert.equal(state.scheduledResumeAt, 0);
  assert.equal(state.marketplaceNoClaimSince, 0);
  assert.equal(state.attemptedTasks.length, 0);
  assert.equal(state.completed, 0);
  assert.equal(state.failed, 0);
  assert.equal(state.attempts, 0);
  assert.equal(state.logs.some(log => /old-run-marker/.test(log.text)), false);
}

test("manual STOP durably clears old runtime/order/dedupe data and preserves settings and completed history", async t => {
  const w = await worker(t, { kind: "claimed", runtime: {
    running: true, mode: "auto", completed: 4, failed: 3, attempts: 7,
    lastXResult: { replyText: "old-run-marker" },
    completionEvidence: { taskKey: TASK_PATH, runId: OLD_RUN },
    pendingXOpen: { candidates: [{ id: 99 }] }, pendingXSubmission: { tabId: 99 },
    attemptedTasks: [{ key: TASK_PATH, expiresAt: Date.now() + 60000 }],
    scheduledResumeAt: Date.now() + 60000, marketplaceNoClaimSince: Date.now() - 60000,
    logs: [{ at: new Date().toISOString(), text: "old-run-marker" }]
  } });
  const settings = clone(w.stored.settings);
  const completedHistory = [{ id: "completed-before-stop", taskKey: "/tasks/completed", replyText: "completed history" }];
  w.stored.xinhuoReplyHistoryRecords = clone(completedHistory);
  const result = await w.send({ type: "STOP_RUN" });
  assert.equal(result.ok, true, result.error);
  await w.flush();
  assertRunReset(w.state());
  assertRunReset(w.stored[STATE_KEY]);
  assert.deepEqual(w.stored.settings, settings);
  assert.deepEqual(w.stored.xinhuoReplyHistoryRecords, completedHistory);
  assert.equal(w.sent.filter(message => message.type === "CANCEL_XINHUO_RUN").length, 1);
  assert.equal(w.sent.some(message => message.type === INSPECT || message.type === "XINHUO_SELECT_AND_CLAIM"), false);
  assert.equal(w.alarms.at(-1).type, "clear");
  assert.equal(w.mutations.length, 0);
});

test("explicit START after manual STOP scans a clean marketplace without inspecting the old unknown order", async t => {
  const w = await worker(t, { kind: "claimed" });
  assert.equal((await w.send({ type: "STOP_RUN" })).ok, true);
  await w.flush();
  const stopRunId = w.state().runId;
  const result = await w.untilScan();
  assert.equal(result.scan, true, result.error);
  assert.notEqual(w.state().runId, stopRunId);
  assert.equal(w.state().running, true);
  assert.equal(w.state().currentTask, null);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.sent.filter(message => message.type === INSPECT).length, 0);
  assert.equal(w.mutations.some(mutation => mutation.type === "reload"), false);
  assert.ok(w.mutations.some(mutation => mutation.url === ORIGIN + "/tasks"));
  const scan = w.sent.find(message => message.type === "XINHUO_SELECT_AND_CLAIM");
  assert.equal(scan.task, null);
  assert.deepEqual(scan.attemptedTaskKeys, []);
  assert.deepEqual(scan.attemptedTaskRecords, []);
});

test("STOP during the real content claim-intent handshake prevents the click and discards the late saved intent", async t => {
  const w = await worker(t, { kind: "unclaimed", runtime: { running: true, mode: "debug", uncertainAction: undefined } });
  const entered = deferred(), release = deferred();
  let held = false, clicks = 0;
  w.page.panel.querySelector("button").click = () => { clicks += 1; };
  w.hooks.save = async values => {
    if (!held && values[STATE_KEY]?.uncertainAction?.runId === OLD_RUN) {
      held = true; entered.resolve(); await release.promise;
    }
  };
  const operation = w.context.sendToTab(11, { type: "DEBUG_XINHUO_CLAIM_CURRENT_TASK", runId: OLD_RUN,
    task: w.state().currentTask, settings: {} });
  assert.equal(await Promise.race([entered.promise.then(() => "saving-intent"), operation.then(() => "returned")]), "saving-intent");
  const stopping = w.send({ type: "STOP_RUN" });
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  assert.equal((await stopping).ok, true);
  assert.equal((await operation).ok, false);
  await w.flush();
  assert.equal(clicks, 0);
  assertRunReset(w.state());
  assertRunReset(w.stored[STATE_KEY]);
  assert.equal(w.scans.length, 0);
  assert.equal(w.mutations.length, 0);
});

test("a late real content claimed receipt cannot revive order state or navigate after STOP", async t => {
  const w = await worker(t, { kind: "claimed", runtime: { running: true, mode: "debug", uncertainAction: undefined } });
  const entered = deferred(), release = deferred();
  w.hooks.claimReceipt = async receipt => {
    assert.equal(receipt.ok, true);
    assert.equal(receipt.task.claimed, true);
    entered.resolve(); await release.promise; return receipt;
  };
  const operation = w.context.sendToTab(11, { type: "DEBUG_XINHUO_CLAIM_CURRENT_TASK", runId: OLD_RUN,
    task: w.state().currentTask, settings: {} });
  assert.equal(await Promise.race([entered.promise.then(() => "claimed-receipt"), operation.then(() => "returned")]), "claimed-receipt");
  assert.equal((await w.send({ type: "STOP_RUN" })).ok, true);
  await w.flush();
  const stopped = clone(w.state()), persisted = clone(w.stored[STATE_KEY]);
  release.resolve();
  assert.equal((await operation).cancelled, true);
  await w.flush();
  assert.deepEqual(clone(w.state()), stopped);
  assert.deepEqual(w.stored[STATE_KEY], persisted);
  assertRunReset(w.state());
  assert.equal(w.mutations.length, 0);
});

test("a late AI transport receipt after STOP cannot append logs, diagnostics, or completed reply history", async t => {
  const w = await worker(t, { runtime: { running: true, mode: "auto", uncertainAction: undefined } });
  const entered = deferred(), release = deferred();
  const completedHistory = [{ id: "existing-completed-history", replyText: "keep" }];
  w.stored.xinhuoReplyHistoryRecords = clone(completedHistory);
  let requests = 0, signal;
  w.hooks.fetch = async (url, request) => {
    if (url.startsWith("chrome-extension://")) return { ok: true, text: async () => "" };
    requests += 1; signal = request.signal; entered.resolve();
    await release.promise;
    return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: "细节讲得很清楚读完收获不少" }) };
  };
  const operation = w.send({ type: "GENERATE_AI_REPLY", runId: OLD_RUN,
    tweet: { url: TARGET, text: "测试推文正文" }, task: w.state().currentTask },
  { id: "fixture", url: TARGET, tab: { id: 99, windowId: 1 }, frameId: 0 });
  assert.equal(await Promise.race([entered.promise.then(() => "ai-request"), operation.then(() => "returned")]), "ai-request");
  assert.equal((await w.send({ type: "STOP_RUN" })).ok, true);
  await w.flush();
  const stopped = clone(w.state()), persisted = clone(w.stored[STATE_KEY]);
  assert.equal(signal.aborted, true);
  release.resolve();
  assert.equal((await operation).ok, false);
  await w.flush();
  assert.equal(requests, 1, "stopped AI work must not retry");
  assert.deepEqual(clone(w.state()), stopped, "the outer message rejection handler must not log into the stopped run");
  assert.deepEqual(w.stored[STATE_KEY], persisted);
  assert.deepEqual(w.stored.xinhuoReplyHistoryRecords, completedHistory);
  assert.equal(w.stored.xinhuoReplyDiagnosticHistoryRecords?.length || 0, 0);
});

test("STOP invalidates both the running manual command and commands already queued behind it", async t => {
  const w = await worker(t, { runtime: { running: true, mode: "debug", uncertainAction: undefined } });
  const entered = deferred(), release = deferred();
  let held = false;
  w.hooks.get = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
  const first = w.send({ type: "DEBUG_XINHUO_CLAIM_OPEN_X", clientWindowId: 1 });
  assert.equal(await Promise.race([entered.promise.then(() => "tab-lookup"), first.then(() => "returned")]), "tab-lookup");
  const queued = w.send({ type: "DEBUG_XINHUO_OPEN_TASKS", clientWindowId: 1 });
  assert.equal((await w.send({ type: "STOP_RUN" })).ok, true);
  await w.flush();
  const stopped = clone(w.state()), sentCount = w.sent.length, mutationCount = w.mutations.length;
  release.resolve();
  const results = await Promise.all([first, queued]);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, false, "a command queued before STOP must require a new user click");
  await w.flush();
  assert.deepEqual(clone(w.state()), stopped);
  assert.equal(w.sent.length, sentCount);
  assert.equal(w.mutations.length, mutationCount);
  assertRunReset(w.state());
});

test("stopped content messages with old or missing run IDs cannot recreate old logs or claim authorization", async t => {
  const w = await worker(t);
  assert.equal((await w.send({ type: "STOP_RUN" })).ok, true);
  await w.flush();
  const stopped = clone(w.state()), persisted = clone(w.stored[STATE_KEY]);
  for (const runId of [OLD_RUN, undefined]) {
    await w.page.context.chrome.runtime.sendMessage({ type: "CONTENT_LOG", runId, text: "old-run-marker late log" });
    const claim = await w.page.context.chrome.runtime.sendMessage({ type: "XINHUO_CLAIM_INTENT", runId,
      task: { taskKey: TASK_PATH, detailPath: TASK_PATH, tweetUrl: TARGET } });
    assert.equal(claim.ok, false);
  }
  await w.flush();
  assert.deepEqual(clone(w.state()), stopped);
  assert.deepEqual(w.stored[STATE_KEY], persisted);
  assert.equal(w.scans.length, 0);
});

test("the real content scanner accepts the new run after STOP and its next STOP cancels the scan without late logs", async t => {
  const w = await worker(t, { kind: "claimed" });
  assert.equal((await w.send({ type: "STOP_RUN" })).ok, true);
  const scanned = deferred();
  const routeContentMessage = w.page.context.chrome.runtime.sendMessage;
  w.page.context.chrome.runtime.sendMessage = message => {
    const response = routeContentMessage(message);
    if (message.type === "CONTENT_LOG" && /任务广场已检查/.test(message.text)) {
      void response.then(() => scanned.resolve());
    }
    return response;
  };
  w.hooks.scan = message => {
    // A navigation to the marketplace replaces the former detail's DOM.
    const main = w.page.body.querySelector("main");
    main.children = [];
    main.text = "当前等级 E 普通进行中 0 待复核 0 验证中 0 共 0 个任务";
    return w.page.send(message);
  };
  const operation = w.start();
  assert.equal(await Promise.race([scanned.promise.then(() => "real-scan"), operation.then(() => "returned")]), "real-scan");
  assert.equal(w.sent.filter(message => message.type === INSPECT).length, 0);
  assert.equal(w.scans.length, 1);
  assert.equal(w.state().currentTask, null);
  assert.equal((await w.send({ type: "STOP_RUN" })).ok, true);
  await w.flush();
  const stopped = clone(w.state());
  assert.equal((await operation).ok, false);
  await w.flush();
  assertRunReset(w.state());
  assert.deepEqual(clone(w.state()), stopped);
});

test("a fresh worker restores a durable manual STOP without recovering old orders and waits for an explicit START", async t => {
  const original = await worker(t, { kind: "claimed" });
  const history = [{ id: "finished-before-restart", replyText: "keep" }];
  original.stored.xinhuoReplyHistoryRecords = clone(history);
  assert.equal((await original.send({ type: "STOP_RUN" })).ok, true);
  await original.flush();
  const restored = await worker(t, { kind: "claimed", restore: true, stored: original.stored });
  await restored.context.handleXinhuoKeepaliveTick();
  await restored.flush();
  assertRunReset(restored.state());
  assert.equal(restored.scans.length, 0);
  assert.equal(restored.sent.length, 0);
  assert.equal(restored.mutations.length, 0);
  assert.equal(restored.alarms.some(alarm => alarm.type === "create"), false);
  assert.deepEqual(restored.stored.xinhuoReplyHistoryRecords, history);
  assert.deepEqual(restored.stored.settings, original.stored.settings);
  assert.equal((await restored.untilScan()).scan, true);
  assert.equal(restored.sent.filter(message => message.type === INSPECT).length, 0);
});

test("concurrent STOP requests share page-reset completion so a late old reset cannot reach a newly started scan", async t => {
  const w = await worker(t, { runtime: { running: true, mode: "auto", uncertainAction: undefined } });
  const entered = deferred(), release = deferred();
  let first = true, secondReturned = false;
  w.hooks.cancel = async message => {
    if (first && message.reset) { first = false; entered.resolve(); await release.promise; }
  };
  const firstStop = w.send({ type: "STOP_RUN" });
  await entered.promise;
  const secondStop = w.send({ type: "STOP_RUN" }).then(result => { secondReturned = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  const returnedBeforePageReset = secondReturned;
  const earlyStart = w.start();
  const beforeReset = await Promise.race([earlyStart, w.scanSignal]);
  const prematureScans = w.scans.length;
  release.resolve();
  const stopped = await Promise.all([firstStop, secondStop]);
  assert.equal(stopped.every(result => result.ok), true);
  assert.equal(returnedBeforePageReset, false, "the second STOP must not advertise completion before the first reset is delivered");
  assert.equal(prematureScans, 0, "START remains blocked for the whole outstanding reset barrier");
  assert.equal(beforeReset.ok, false);
  assert.equal(w.sent.filter(message => message.type === "CANCEL_XINHUO_RUN").length, 1);
  assertRunReset(w.state());
  assert.equal((await w.untilScan()).scan, true, "a user START after both stops finish must still work");
});

test("manual STOP during an automatic stop durably upgrades its barrier before any automatic restart", async t => {
  const w = await worker(t, { runtime: { running: true, mode: "auto", uncertainAction: undefined } });
  const entered = deferred(), release = deferred();
  let first = true, manualReturned = false;
  w.hooks.cancel = async message => {
    if (first && message.reset) { first = false; entered.resolve(); await release.promise; }
  };
  const automaticStop = w.context.stopXinhuoRun({ manual: false });
  await entered.promise;
  const manualStop = w.send({ type: "STOP_RUN" }).then(result => { manualReturned = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  const returnedBeforePageReset = manualReturned;
  release.resolve();
  const [, result] = await Promise.all([automaticStop, manualStop]);
  assert.equal(result.ok, true);
  await w.flush();
  assert.equal(returnedBeforePageReset, false, "manual STOP must await the existing page-reset barrier");
  assertRunReset(w.state());
  assert.equal(w.state().manuallyStopped, true);
  assert.equal(w.stored[STATE_KEY].manuallyStopped, true);
  const resumed = await w.context.startXinhuoRun(1, { automatic: true });
  assert.equal(resumed.ok, false);
  assert.equal(w.scans.length, 0);
  assert.equal(w.sent.filter(message => message.type === "CANCEL_XINHUO_RUN").length, 1);
  assert.equal((await w.untilScan()).scan, true, "a later explicit user START remains available");
});

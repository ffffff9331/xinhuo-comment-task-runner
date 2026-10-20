"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/xinhuo.js"), "utf8");
const DETAIL = "/tasks/c82df57c-f8b3-4547-b8fc-1ff5e2dc87c7";
const TWEET = "https://x.com/example/status/2111837370354167816";
const ALIAS = "https://x.com/i/status/2111837370354167816";
const OTHER_TWEET = "https://x.com/example/status/2111837370354167817";

// A local semantic DOM, not a browser session. The complete production
// listener/inspection code runs with inert DOM nodes and a blocked network.
class Element {
  constructor(tag, text = "", attrs = {}) {
    this.tagName = tag.toUpperCase(); this.text = text; this.attrs = attrs;
    this.children = []; this.parentElement = null; this.hidden = false;
    this.disabled = false; this.style = { display: "block", visibility: "visible", opacity: "1" };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  get innerText() { return [this.text, ...this.children.filter(node => !node.hidden).map(node => node.innerText)].filter(Boolean).join("\n"); }
  get textContent() { return [this.text, ...this.children.map(node => node.textContent)].filter(Boolean).join("\n"); }
  get href() { return this.attrs.href || ""; }
  get className() { return this.attrs.class || ""; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  getBoundingClientRect() { return { width: this.hidden ? 0 : 160, height: this.hidden ? 0 : 24 }; }
  contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
  matches(selector) {
    return selector.split(",").some(part => {
      const text = part.trim();
      if (text === "*") return true;
      const tag = text.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const className = text.replace(/\[[^\]]+\]/g, "").match(/\.([\w-]+)/)?.[1];
      if (className && !this.className.split(/\s+/).includes(className)) return false;
      for (const match of text.matchAll(/\[([\w-]+)(?:(\*?=)["']([^"']*)["'])?\]/g)) {
        const value = this.getAttribute(match[1]);
        if (value === null || (match[2] === "=" && value !== match[3]) || (match[2] === "*=" && !value.includes(match[3]))) return false;
      }
      return Boolean(tag || className || text.startsWith("["));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); } };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function page(options = {}) {
  let listener;
  const calls = { clicks: 0, scrolls: 0, messages: [], navigations: 0, fetches: 0 };
  const node = (tag, text = "", attrs = {}) => {
    const element = new Element(tag, text, attrs);
    element.click = () => { calls.clicks++; };
    element.scrollIntoView = () => { calls.scrolls++; };
    return element;
  };
  const body = node("body"), main = node("main"), panel = node("aside", "", { class: "reward-panel" });
  panel.append(node("h2", "本单任务"));
  const status = node("div", options.status || "", { role: "status" });
  panel.append(status);
  if (options.panelText) panel.append(node("p", options.panelText));
  const buttons = [];
  for (const label of options.buttons || []) { const button = node("button", label); buttons.push(button); panel.append(button); }
  const anchors = (options.tweetUrls || [TWEET]).map(href => node("a", "查看目标推文", { href }));
  main.append(...anchors);
  if (!options.noPanel) main.append(panel);
  body.append(main);
  for (const label of options.outsideButtons || []) body.append(node("button", label));
  if (options.outsideText) body.append(node("div", options.outsideText));
  const document = { body, readyState: options.readyState || "complete",
    querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  const current = new URL(`https://xinhuo123.com${options.pathname || DETAIL}`);
  const location = { pathname: current.pathname, search: current.search, hostname: current.hostname, origin: current.origin,
    get href() { return current.href; }, set href(value) { calls.navigations++; current.href = value; } };
  const runtime = { id: "inspection-fixture", getURL: value => `chrome-extension://inspection-fixture/${value}`,
    onMessage: { addListener(fn) { listener = fn; }, hasListener(fn) { return listener === fn; }, removeListener() {} },
    async sendMessage(message) { calls.messages.push(message); return { ok: true }; } };
  const c = vm.createContext({ console, URL, Date, location, document, chrome: { runtime },
    getComputedStyle: element => element.style,
    fetch: async () => { calls.fetches++; throw Error("Network forbidden in inspection tests"); },
  });
  const end = source.lastIndexOf("})();");
  const adapter = `globalThis.testApi = { getRun: () => activeRunId, setRun: value => { activeRunId = value; },
    setClaimInFlight: value => { claimOperation = value ? { runId: activeRunId } : null; } };`;
  vm.runInContext(source.slice(0, end) + adapter + source.slice(end), c);
  const task = { taskKey: DETAIL, detailPath: DETAIL, tweetUrl: TWEET };
  const send = (message = {}) => new Promise(resolve => listener({ type: "XINHUO_INSPECT_CURRENT_TASK", task, ...message }, {}, resolve));
  return { send, task, calls, c, document, body, main, panel, status, buttons, anchors, node };
}

function assertReadOnly(p) {
  assert.equal(p.calls.clicks, 0); assert.equal(p.calls.scrolls, 0); assert.equal(p.calls.navigations, 0);
  assert.equal(p.calls.fetches, 0); assert.deepEqual(p.calls.messages, []);
}

function assertUnknown(result) {
  assert.equal(result.ok, false);
  assert.equal(result.inspectionState, "unknown");
  assert.notEqual(result.claimed, false, "absence or ambiguity cannot release an unknown order");
}

test("a visible enabled claim control in the exact loaded order is proven unclaimed without clicking", async () => {
  const p = page({ buttons: ["接取评论任务"] });
  p.c.testApi.setRun("active-run");
  const result = await p.send();
  assert.equal(result.ok, true);
  assert.equal(result.inspectionState, "unclaimed");
  assert.equal(result.claimed, false);
  assert.equal(result.task.claimed, false);
  assert.equal(result.task.taskKey, DETAIL);
  assert.equal(result.task.detailPath, DETAIL);
  assert.equal(result.task.tweetUrl, TWEET);
  assert.equal(p.c.testApi.getRun(), "active-run");
  assertReadOnly(p);
});

for (const status of ["奖励已到账", "任务核验已通过，奖励已结算", "该任务已完成"]) {
  test(`exact visible order completion is terminal: ${status}`, async () => {
    const p = page({ status });
    const result = await p.send();
    assert.equal(result.ok, true);
    assert.equal(result.inspectionState, "completed");
    assert.equal(result.task.officialState.final, true);
    assert.equal(result.task.officialState.success, true);
    assertReadOnly(p);
  });
}

for (const status of ["订单已取消", "任务已过期", "任务已超时取消，名额已释放"]) {
  test(`explicit cancelled or released order is terminal: ${status}`, async () => {
    const p = page({ status });
    const result = await p.send();
    assert.equal(result.ok, true);
    assert.equal(result.inspectionState, "failed");
    assert.equal(result.claimed, false);
    assert.equal(result.task.officialState.final, true);
    assert.equal(result.task.officialState.success, false);
    assertReadOnly(p);
  });
}

for (const options of [
  { buttons: ["提交并使用 X API 核验"] },
  { buttons: ["放弃订单"] },
  { status: "任务已提交，等待系统按计划核验" },
  { status: "自动核验未能确认，现已转人工复核" },
  { status: "已提交，等待平台核验；未能确认将转人工复核" },
]) {
  test(`active or pending order remains protected: ${JSON.stringify(options)}`, async () => {
    const p = page(options);
    const result = await p.send();
    assert.equal(result.ok, true);
    assert.equal(result.inspectionState, "claimed");
    assert.equal(result.claimed, true);
    assert.equal(result.task.claimed, true);
    assertReadOnly(p);
  });
}

for (const options of [
  { panelText: "E0席位 审核通过后奖励 0 KX", outsideText: "普通进行中 0 待复核 0 验证中 0" },
  { noPanel: true },
  { panelText: "正在加载订单", buttons: ["接取评论任务"] },
  { readyState: "loading", buttons: ["接取评论任务"] },
  { status: "核验失败" },
  { status: "任务未通过" },
  { outsideText: "奖励已到账 普通进行中 0", outsideButtons: ["接取评论任务"] },
  { panelText: "审核通过后奖励已到账，请按要求完成任务" },
]) {
  test(`inconclusive or unhydrated panel remains unknown: ${JSON.stringify(options)}`, async () => {
    const p = page(options);
    assertUnknown(await p.send());
    assertReadOnly(p);
  });
}

for (const condition of ["hidden panel", "CSS hidden panel", "busy panel", "busy child", "disabled claim", "aria disabled claim", "hidden claim", "hidden completion", "two panels", "inflight claim", "contradicting controls"]) {
  test(`${condition} cannot release an uncertain order`, async () => {
    const p = page({ buttons: ["接取评论任务"] });
    if (condition === "hidden panel") p.panel.hidden = true;
    if (condition === "CSS hidden panel") p.panel.style.visibility = "hidden";
    if (condition === "busy panel") p.panel.attrs["aria-busy"] = "true";
    if (condition === "busy child") p.panel.append(p.node("div", "", { "aria-busy": "true" }));
    if (condition === "disabled claim") p.buttons[0].disabled = true;
    if (condition === "aria disabled claim") p.buttons[0].attrs["aria-disabled"] = "true";
    if (condition === "hidden claim") p.buttons[0].hidden = true;
    if (condition === "hidden completion") { p.buttons[0].hidden = true; p.status.text = "奖励已到账"; p.status.hidden = true; }
    if (condition === "two panels") p.main.append(p.node("aside", "奖励已到账", { class: "reward-panel" }));
    if (condition === "inflight claim") p.c.testApi.setClaimInFlight(true);
    if (condition === "contradicting controls") p.panel.append(p.node("button", "放弃订单"));
    assertUnknown(await p.send());
    assertReadOnly(p);
  });
}

for (const task of [
  {}, { detailPath: DETAIL }, { tweetUrl: TWEET },
  { taskKey: DETAIL, detailPath: "/tasks/another", tweetUrl: TWEET },
  { taskKey: "/tasks/another", detailPath: DETAIL, tweetUrl: TWEET },
  { taskKey: DETAIL, detailPath: DETAIL, tweetUrl: OTHER_TWEET },
  { taskKey: DETAIL, detailPath: DETAIL, tweetUrl: "https://x.com.evil.example/example/status/2111837370354167816" },
  { taskKey: DETAIL, detailPath: DETAIL, tweetUrl: TWEET + "abc" },
  { taskKey: DETAIL, detailPath: DETAIL, tweetUrl: "https://someone@x.com/example/status/2111837370354167816" },
]) {
  test(`missing or mismatching expected identity is inconclusive: ${JSON.stringify(task)}`, async () => {
    const p = page({ buttons: ["接取评论任务"] });
    assertUnknown(await p.send({ task }));
    assertReadOnly(p);
  });
}

for (const options of [
  { pathname: "/tasks" }, { pathname: DETAIL + "-other" },
  { tweetUrls: [] }, { tweetUrls: [OTHER_TWEET] }, { tweetUrls: [TWEET, OTHER_TWEET] },
  { tweetUrls: [TWEET.replace("https:", "http:")] },
  { tweetUrls: [TWEET.replace("x.com", "x.com.evil.example")] },
]) {
  test(`the visible page must match the complete expected identity: ${JSON.stringify(options)}`, async () => {
    const p = page({ ...options, buttons: ["接取评论任务"] });
    assertUnknown(await p.send());
    assertReadOnly(p);
  });
}

test("same numeric tweet identity accepts X/Twitter author aliases without relaxing the order path", async () => {
  const p = page({ tweetUrls: [ALIAS, TWEET.replace("x.com", "twitter.com")], buttons: ["接取评论任务"] });
  const result = await p.send();
  assert.equal(result.inspectionState, "unclaimed");
  assert.equal(result.task.tweetUrl, TWEET, "the caller's bound navigation URL remains stable");
  assertReadOnly(p);
});

test("a reward-panel completion label cannot override a separate visible pending state", async () => {
  const p = page({ status: "奖励已到账" });
  p.panel.append(p.node("div", "待复核", { role: "status" }));
  assertUnknown(await p.send());
  assertReadOnly(p);
});

test("inspection remains read-only after STOP even when the request includes the cancelled run ID", async () => {
  const p = page({ buttons: ["接取评论任务"] });
  p.c.testApi.setRun("stopped-run");
  await p.send({ type: "CANCEL_XINHUO_RUN", runId: "stopped-run" });
  const stoppedRun = p.c.testApi.getRun();
  const result = await p.send({ runId: "stopped-run" });
  assert.equal(result.inspectionState, "unclaimed");
  assert.equal(p.c.testApi.getRun(), stoppedRun);
  const blockedAction = await p.send({ type: "DEBUG_XINHUO_CLAIM_CURRENT_TASK", runId: "stopped-run" });
  assert.equal(blockedAction.cancelled, true);
  assertReadOnly(p);
});

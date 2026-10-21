"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ID = "2111837370354167816";
const ALIAS = `https://x.com/i/status/${ID}`;
const AUTHOR = `https://x.com/fixture/status/${ID}`;
const OTHER = "https://x.com/fixture/status/2111837370354167817";
const source = fs.readFileSync(path.join(__dirname, "../src/content/x.js"), "utf8");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function page(actual = AUTHOR, onAction = () => ({ ok: true })) {
  let listener;
  const fixture = { location: { href: actual }, actions: [] };
  const c = vm.createContext({ console, URL, Date, location: fixture.location,
    document: { querySelector() { return null; } },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    fetch: async () => { throw Error("Network forbidden"); },
    fixtureAction: async () => { fixture.actions.push(1); return onAction(fixture); }
  });
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + `
    function runReply() { return fixtureAction(); }
    function completeTaskWidgetLifecycle() { return fixtureAction(); }
  ` + source.slice(end), c);
  return { fixture, send: (patch = {}) => new Promise(resolve => listener({ type: "RUN_X_REPLY",
    platform: "xinhuo", runId: "identity-run", task: { taskKey: "/tasks/a", tweetUrl: ALIAS }, settings: {}, ...patch }, {}, resolve)) };
}

for (const type of ["RUN_X_REPLY", "COMPLETE_X_TASK_WIDGET", "CLICK_X_TASK_VERIFY"]) {
  for (const actual of [AUTHOR, AUTHOR.replace("x.com", "twitter.com"), `${AUTHOR}/photo/1?s=20`]) {
    test(`${type} accepts the same exact status ID at ${actual}`, async () => {
      const p = page(actual);
      assert.equal((await p.send({ type })).ok, true);
      assert.equal(p.fixture.actions.length, 1);
    });
  }
}
for (const actual of [OTHER, `${AUTHOR}evil`, AUTHOR.replace("x.com", "x.com.evil.test"),
  `https://evil.test/?next=${AUTHOR}`, AUTHOR.replace("x.com", "user@x.com"),
  AUTHOR.replace("x.com", "x.com:444"), AUTHOR.replace("https:", "http:"), `${AUTHOR}/unrelated`]) {
  for (const side of ["page", "task"]) test(`rejects invalid or different identity in ${side}: ${actual}`, async () => {
    const p = page(side === "page" ? actual : AUTHOR);
    assert.equal((await p.send(side === "task" ? { task: { taskKey: "/tasks/a", tweetUrl: actual } } : {})).ok, false);
    assert.equal(p.fixture.actions.length, 0);
  });
}
for (const taskKey of ["/tasks/a", ""]) test(`completed step is not replayed under another handle, taskKey=${taskKey}`, async () => {
  const p = page(ALIAS);
  assert.equal((await p.send({ task: { taskKey, tweetUrl: ALIAS } })).ok, true);
  p.fixture.location.href = AUTHOR;
  assert.equal((await p.send({ task: { taskKey, tweetUrl: AUTHOR } })).ok, true);
  assert.equal(p.fixture.actions.length, 1);
});
test("same-ID redirect during a pending operation shares one action and completes normally", async () => {
  const gate = deferred(), entered = deferred();
  const p = page(ALIAS, () => { entered.resolve(); return gate.promise; });
  const first = p.send(); await entered.promise;
  p.fixture.location.href = AUTHOR;
  const second = p.send({ task: { taskKey: "/tasks/a", tweetUrl: AUTHOR } });
  gate.resolve({ ok: true });
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(p.fixture.actions.length, 1);
});
test("STOP still wins when a running action redirects to the same post", async () => {
  const gate = deferred(), entered = deferred();
  const p = page(ALIAS, () => { entered.resolve(); return gate.promise; });
  const pending = p.send(); await entered.promise;
  await p.send({ type: "CANCEL_X_RUN", reset: true });
  p.fixture.location.href = AUTHOR; gate.resolve({ ok: true });
  assert.equal((await pending).ok, false);
  assert.equal((await p.send({ task: { taskKey: "/tasks/a", tweetUrl: AUTHOR } })).cancelled, true);
  assert.equal(p.fixture.actions.length, 1);
});

async function worker() {
  const file = fs.readFileSync(path.join(__dirname, "session-api-key.test.cjs"), "utf8");
  const prefix = file.slice(0, file.indexOf('test("legacy key'));
  const fixture = new Function("require", "__dirname", prefix + "\nreturn fixture;")(require, __dirname);
  const w = await fixture();
  Object.assign(w.state(), { running: true, mode: "auto", runId: "identity-run", windowId: 1,
    xinhuoTabId: 11, xTabId: 21, currentTask: { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: ALIAS, claimed: true } });
  w.context.chrome.tabs.get = async id => ({ id, windowId: 1, url: AUTHOR, openerTabId: 11 });
  return w;
}
test("background adopts a bound author redirect without creating another tab", async () => {
  const w = await worker();
  assert.equal((await w.context.getSiteOpenedTargetXTab(w.state().currentTask, 11)).id, 21);
  assert.equal(w.actions.some(([name]) => name === "navigation"), false);
  assert.equal(w.state().currentTask.tweetUrl, ALIAS);
});
test("site-created author tab is matched by ID and retains opener/creation guards", async () => {
  const w = await worker(); w.context.beginXinhuoXOpenWatch({ id: 11, windowId: 1 });
  w.state().pendingXOpen.claimStartedAt = Date.now() - 1;
  w.context.recordPotentialXinhuoOpenedXTab({ id: 22, windowId: 1, openerTabId: 11, url: AUTHOR }, true);
  assert.equal(w.context.consumeXinhuoOpenedXTab(ALIAS).id, 22);
});
test("completion evidence accepts aliases while retaining task, run and status-ID boundaries", async () => {
  const w = await worker();
  const evidence = { runId: "identity-run", taskKey: "/tasks/a", tweetUrl: AUTHOR };
  for (const change of [{ tweetUrl: OTHER }, { taskKey: "/tasks/b" }, { runId: "old" }])
    assert.equal(w.context.latchXinhuoCompletion({ ...evidence, ...change }, "identity-run"), false);
  assert.equal(w.context.latchXinhuoCompletion(evidence, "identity-run"), true);
  assert.equal(w.context.hasLatchedXinhuoCompletion("identity-run"), true);
});
test("reply history and attempted-task dedupe recognize old stored handle URLs", async () => {
  const w = await worker();
  w.local.xinhuoReplyHistoryRecords = [{ id: "prior", tweetUrl: AUTHOR, replyText: "already sent", taskKey: "/tasks/old" }];
  assert.equal((await w.context.queryTweetReplyHistory({ url: ALIAS }, {})).replied, true);
  assert.equal((await w.context.queryTweetReplyHistory({ url: OTHER }, {})).replied, false);
  w.state().attemptedTasks = [{ key: AUTHOR, expiresAt: Date.now() + 60000 }];
  assert.equal(w.context.getAttemptedTaskRecords()[0].key, ALIAS);
  w.context.releaseXinhuoAttemptedTask({ tweetUrl: AUTHOR });
  assert.equal(w.state().attemptedTasks.length, 0);
});
test("bound tab rejects another post and another window even when the post ID matches", async () => {
  for (const tab of [{ url: OTHER, windowId: 1 }, { url: AUTHOR, windowId: 2 }]) {
    const w = await worker(); w.context.chrome.tabs.get = async id => ({ id, ...tab });
    assert.equal(await w.context.getBoundMatchingXinhuoXTab(ALIAS), null);
  }
});

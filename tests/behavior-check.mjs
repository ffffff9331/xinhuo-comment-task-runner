import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const platform = manifest.name.includes("Lighthouse") ? "lighthouse" : "xinhuo";
const background = read("src/background.js");
const page = read(`src/content/${platform}.js`);
const xPage = read("src/content/x.js");
const engine = read("src/reply-engine.js");
const debugPanel = read("src/debug/debug.js");
let passed = 0;
const test = async (name, action) => {
  await action();
  passed += 1;
  console.log(`PASS ${name}`);
};

// Extract actual production declarations, not a reimplementation of their logic.
function declaration(source, name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing function: ${name}`);
  const start = match.index;
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = start + match[0].length;
  const end = next.exec(source)?.index ?? source.lastIndexOf("})();");
  return source.slice(start, end > start ? end : source.length);
}
function contextFor(source, names, globals = {}) {
  const context = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout,
    normalize: (s) => String(s).replace(/\s+/g, " ").trim(),
    normalizeText: (s) => String(s).replace(/\s+/g, " ").trim(),
    startTaskWidgetAssist() {}, ...globals });
  for (const name of names) vm.runInContext(declaration(source, name), context);
  return context;
}

await test("stopped and stale messages are never sent, cancellation still reaches page", async () => {
  let sends = 0;
  const context = contextFor(background, ["sendToTab"], {
    runtimeState: { running: false, runId: "current" },
    chrome: { tabs: { async sendMessage() { sends += 1; return { ok: true }; } } },
    async ensureLighthouseAlertBridge() {}
  });
  const stopped = await context.sendToTab(1, { type: "RUN_X_REPLY", runId: "current" });
  assert.equal(stopped.cancelled, true);
  context.runtimeState.running = true;
  const stale = await context.sendToTab(1, { type: "RUN_X_REPLY", runId: "old" });
  assert.equal(stale.cancelled, true);
  assert.equal(sends, 0);
  await context.sendToTab(1, { type: "CANCEL_X_RUN", runId: "old" });
  assert.equal(sends, 1);
});

if (platform === "lighthouse") {
  await test("completion DOM rejects instructions and chooses result panel over page ancestor", () => {
    const make = (text, labels, width = 400, height = 300) => ({
      innerText: text,
      querySelectorAll: () => labels.map((innerText) => ({ innerText })),
      getBoundingClientRect: () => ({ width, height }),
      contains: () => false
    });
    const panel = make("验证成功 · 已通过 奖励已到账 +0.1 LUX", ["验证成功 · 已通过", "奖励已到账"]);
    const instruction = make("任务验证通过后发放 0.1 LUX", ["任务验证通过后发放"]);
    const ancestor = make(panel.innerText, ["奖励已到账"], 1000, 800);
    ancestor.contains = (node) => node === panel;
    const context = contextFor(page, ["findOfficialCompletionRoots"], {
      document: { querySelectorAll: () => [ancestor, instruction, panel] },
      isVisible: () => true
    });
    const roots = context.findOfficialCompletionRoots();
    assert.equal(roots.length, 1);
    assert.equal(roots[0], panel);
  });
  await test("rapid duplicate start is rejected before first asynchronous wait", async () => {
    let releaseSettings;
    const settings = new Promise((resolve) => { releaseSettings = resolve; });
    const context = contextFor(background, ["startAutoRun"], {
      runtimeState: { running: false },
      createInitialState: () => ({}),
      setRuntimeWindow() {}, createRunId: () => "run",
      sanitizeAutoRunStartOptions: () => ({}),
      setStage() {}, log() {}, getSettings: () => settings
    });
    const first = context.startAutoRun({});
    const second = await context.startAutoRun({});
    assert.equal(second.ok, false);
    assert.equal(context.runtimeState.running, true);
    releaseSettings({ replyMode: "fill" });
    await first;
  });
}

function xHarness() {
  let listener;
  let count = 0;
  let resolveAction;
  const action = new Promise((resolve) => { resolveAction = resolve; });
  const context = vm.createContext({
    console, URL, location: { href: "https://x.com/test/status/123" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    startTaskWidgetAssist() {},
    runAction() { count += 1; return action; }
  });
  const prefix = xPage.slice(0, xPage.indexOf("  async function runReply("));
  vm.runInContext(`${prefix}
    ${declaration(xPage, "normalizeTweetUrl")}
    ${declaration(xPage, "assertActiveRun")}
    function runReply() { return runAction(); }
    function completeTaskWidgetLifecycle() { return runAction(); }
    function runTaskWidgetClaim() { return runAction(); }
  })();`, context);
  const payload = { platform, type: "RUN_X_REPLY", runId: "run-1",
    task: { taskKey: "task-1", detailPath: "/tasks/task-1", tweetUrl: "https://x.com/test/status/123" }, settings: {} };
  return {
    context, payload, count: () => count, finish: () => resolveAction({ ok: true }),
    send: (patch = {}) => new Promise((resolve) => listener({ ...payload, ...patch }, {}, resolve))
  };
}

await test("concurrent platform claim messages share one claim operation", async () => {
  let listener;
  let count = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const context = vm.createContext({
    console, URL, window: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    isCurrentInstance: () => true,
    action() { count += 1; return pending; }
  });
  const end = platform === "lighthouse"
    ? page.indexOf("  function isCurrentInstance(")
    : page.indexOf("  async function selectAndClaim(");
  vm.runInContext(`${page.slice(0, end)}
    function runCommentTask() { return action(); }
    function selectAndClaim() { return action(); }
  })();`, context);
  const type = platform === "lighthouse" ? "START_LIGHTHOUSE_COMMENT_TASK" : "XINHUO_SELECT_AND_CLAIM";
  const send = (runId) => new Promise((resolve) => listener({ type, runId, settings: {} }, {}, resolve));
  const first = send("run-1");
  const second = send("run-1");
  const other = await send("run-2");
  assert.equal(other.conflict, true);
  assert.equal(count, 1);
  finish({ ok: true });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(count, 1);
});

await test("same task concurrent/replayed reply executes exactly once", async () => {
  const h = xHarness();
  const a = h.send();
  const b = h.send();
  await Promise.resolve();
  assert.equal(h.count(), 1);
  h.finish();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  assert.equal((await h.send()).ok, true);
  assert.equal(h.count(), 1);
});
await test("wrong platform and wrong tweet perform zero actions", async () => {
  const h = xHarness();
  assert.equal((await h.send({ platform: platform === "xinhuo" ? "lighthouse" : "xinhuo" })).ok, false);
  assert.equal((await h.send({ task: { tweetUrl: "https://x.com/test/status/999" } })).ok, false);
  assert.equal(h.count(), 0);
});
await test("different task cannot overwrite the active operation", async () => {
  const h = xHarness();
  const first = h.send();
  assert.equal((await h.send({ runId: "run-2" })).conflict, true);
  h.finish();
  assert.equal((await first).ok, true);
  assert.equal(h.count(), 1);
});
await test("cancelled in-flight result is not reported as success", async () => {
  const h = xHarness();
  const first = h.send();
  await Promise.resolve();
  await h.send({ type: "CANCEL_X_RUN" });
  h.finish();
  assert.equal((await first).ok, false);
  assert.equal((await h.send()).cancelled, true);
});
await test("navigation during a step invalidates its result", async () => {
  const h = xHarness();
  const first = h.send();
  await Promise.resolve();
  h.context.location.href = "https://x.com/test/status/999";
  h.finish();
  assert.equal((await first).ok, false);
});
await test("submit aliases share the same single execution", async () => {
  const h = xHarness();
  const a = h.send({ type: "CLICK_X_TASK_VERIFY" });
  const b = h.send({ type: "COMPLETE_X_TASK_WIDGET" });
  h.finish();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  assert.equal(h.count(), 1);
});

await test("AI cancellation aborts fetch without a retry", async () => {
  let calls = 0;
  const c = contextFor(engine, ["callAIProvider", "callAIWithSolaRetry", "createReplyDiagnostic", "clipReplyDiagnosticText", "countReplyChineseChars", "describeReplyFailureReason"], {
    MAX_AI_NORMAL_ATTEMPTS: 6,
    MIN_REPLY_CHINESE_CHARS: 5,
    AI_PROVIDER_CONFIG: { deepseek: { endpoint: "https://invalid.test", model: "test" } },
    normalizeCustomAIEndpoint: () => "",
    fetch: (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  });
  const controller = new AbortController();
  const pending = c.callAIWithSolaRetry("deepseek", "test-key", "", "text", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /任务已停止/);
  assert.equal(calls, 1);
});
await test("AI generation uses a 120s timeout with one controlled timeout retry", () => {
  assert.match(engine, /const DEFAULT_AI_TIMEOUT_MS = 120000/);
  assert.match(engine, /const MAX_AI_NORMAL_ATTEMPTS = 6/);
  assert.match(engine, /const MAX_AI_TIMEOUT_ATTEMPTS = 2/);
  assert.match(background, /const XINHUO_AI_TIMEOUT_MS = 120000/);
  assert.match(background, /timeout: XINHUO_AI_TIMEOUT_MS/);
  assert.doesNotMatch(engine, /pickUserFallbackReply\(tweetContent/);
  assert.match(background, /taskTitle:/);
});
await test("AI provider failure performs exactly five retries", async () => {
  let calls = 0;
  const c = contextFor(engine, ["callAIProvider", "callAIWithSolaRetry", "isAIRequestTimeoutError", "createReplyDiagnostic", "clipReplyDiagnosticText", "countReplyChineseChars", "describeReplyFailureReason"], {
    MAX_AI_NORMAL_ATTEMPTS: 6,
    MIN_REPLY_CHINESE_CHARS: 5,
    AI_PROVIDER_CONFIG: { deepseek: { endpoint: "https://invalid.test", model: "test" } },
    normalizeCustomAIEndpoint: () => "",
    delay: async () => {},
    fetch: async () => {
      calls += 1;
      throw new Error("network down");
    }
  });
  const result = await c.callAIWithSolaRetry("deepseek", "test-key", "prompt", "tweet", {});
  assert.equal(calls, 6);
  assert.equal(result.diagnostics.length, 6);
  assert.ok(result.diagnostics.every((item) => item.reason === "api_error"));
});
await test("AI timeout records two diagnostics and stops after one controlled retry", async () => {
  let calls = 0;
  const c = contextFor(engine, ["callAIWithSolaRetry", "isAIRequestTimeoutError", "createReplyDiagnostic", "clipReplyDiagnosticText", "countReplyChineseChars", "describeReplyFailureReason"], {
    MAX_AI_NORMAL_ATTEMPTS: 6,
    MAX_AI_TIMEOUT_ATTEMPTS: 2,
    MIN_REPLY_CHINESE_CHARS: 5,
    callAIProvider: async () => {
      calls += 1;
      throw new Error("AI 请求超时：120000ms");
    },
    delay: async () => {}
  });
  const result = await c.callAIWithSolaRetry("openai", "test-key", "prompt", "tweet", {});
  assert.equal(calls, 2);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every((item) => item.reason === "timeout"));
  assert.ok(result.diagnostics.every((item) => /AI请求超时/.test(item.reasonText)));
});
await test("AI invalid output keeps diagnostics when the next retry succeeds", async () => {
  let calls = 0;
  const c = contextFor(engine, ["callAIWithSolaRetry", "retryAIReplyAfterValidation"], {
    MAX_AI_NORMAL_ATTEMPTS: 6,
    callAIProvider: async () => {
      calls += 1;
      return calls === 1 ? "too-short" : "valid-reply";
    },
    createReplyDiagnostic: (_stage, _raw, _normalized, validation) => ({
      ok: Boolean(validation.ok),
      reason: validation.reason || ""
    }),
    normalizeBlacklistCandidateText: (text) => text,
    validateFinalReplyText: (text) => text === "too-short"
      ? { ok: false, reason: "length", blacklistWords: [] }
      : { ok: true, reason: "", blacklistWords: [] },
    getValidationRetryWords: () => ["reply length"],
    enhanceSystemPromptWithBlacklist: (prompt) => prompt,
    buildBlacklistCandidatePrompt: (prompt) => prompt,
    delay: async () => {}
  });
  const result = await c.callAIWithSolaRetry("deepseek", "test-key", "prompt", "tweet", {});
  assert.equal(calls, 2);
  assert.equal(result.replyText, "valid-reply");
  assert.equal(Array.from(result.diagnostics, (item) => item.reason).join("|"), "length|");
});
await test("prompt-declared reply length overrides the default cap while task minimum still applies", () => {
  const c = contextFor(engine, ["normalizeReplyMinChineseChars", "getPromptReplyLengthRange", "getReplyLengthRange", "isUsableReplyText", "validateFinalReplyText", "normalizeBlacklistCandidateText", "countReplyChineseChars"], {
    MIN_REPLY_CHINESE_CHARS: 5,
    MAX_REPLY_CHINESE_CHARS: 20,
    checkBlacklistedWords: () => ({ hasBlacklisted: false, words: [] }),
    detectReplyTextDegeneration: () => ({ blocked: false, reasonCode: "" })
  });
  const prompt = "回复10到20个汉字为主";
  const range = c.getReplyLengthRange(prompt, { minChineseChars: 12 });
  assert.equal(range.min, 12);
  assert.equal(range.max, 20);
  assert.equal(c.validateFinalReplyText("一二三四五六七八九十一二三四五六七八", prompt, { minChineseChars: 10 }).ok, true);
  assert.equal(c.validateFinalReplyText("一二三四五六七八九十一", prompt, { minChineseChars: 12 }).reason, "length");
  assert.equal(c.validateFinalReplyText("一二三四五六七八九十一二三四五六七八九十一", prompt, { minChineseChars: 10 }).reason, "length");
});
await test("reply history diagnostics retain distinct AI and X failure categories", () => {
  const c = contextFor(background, ["buildReplyFailureRecord"], {
    runtimeState: { currentTask: {} },
    getXinhuoTaskIdentity: () => "task-1",
    normalizeXinhuoTaskPath: () => "/tasks/task-1",
    normalizeTweetUrl: () => "https://x.com/test/status/1"
  });
  const timeout = c.buildReplyFailureRecord("ai_timeout", "AI请求超时", { taskKey: "task-1" });
  const invalid = c.buildReplyFailureRecord("ai_invalid_output", "中文长度不合规", { taskKey: "task-1" });
  const xSend = c.buildReplyFailureRecord("x_send_failed", "找不到回复框", { taskKey: "task-1" });
  assert.equal(timeout.failureLabel, "AI 请求超时");
  assert.equal(invalid.failureLabel, "AI 输出不合规");
  assert.equal(xSend.failureLabel, "X 页面填入/发送失败");
});
await test("AI failure type is preserved through the X reply boundary", () => {
  assert.match(engine, /error\.failureType = getAIReplyGenerationFailureType\(diagnostics\)/);
  assert.match(xPage, /failureType: error\.failureType \|\| ""/);
  assert.match(xPage, /error\.failureType = aiResponse\?\.failureType \|\| ""/);
  assert.match(background, /if \(!isAIReplyFailureType\(reply\?\.failureType\)\)/);
});
await test("reply diagnostics persist separately and never become reply-dedupe history", async () => {
  const storage = {};
  const c = contextFor(background, ["getReplyDiagnosticRecords", "recordReplyDiagnosticHistory", "normalizeXinhuoReplyDiagnosticRecord"], {
    REPLY_DIAGNOSTIC_HISTORY_KEY: "diagnostics",
    MAX_REPLY_HISTORY_RECORDS: 200,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries(keys.map((key) => [key, storage[key]]));
          },
          async set(values) {
            Object.assign(storage, values);
          }
        }
      }
    },
    getXinhuoTaskIdentity: (record) => record.taskKey || "",
    normalizeXinhuoTaskPath: (value) => value || "",
    normalizeTweetUrl: (value) => value || ""
  });
  await c.recordReplyDiagnosticHistory({
    id: "timeout-1",
    createdAt: "2026-09-15T10:26:43.000Z",
    failureType: "ai_timeout",
    failureLabel: "AI 请求超时",
    failureMessage: "AI请求超时：120000ms",
    taskKey: "task-1"
  });
  const diagnostics = await c.getReplyDiagnosticRecords();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "diagnostic");
  assert.equal(diagnostics[0].failureType, "ai_timeout");
  assert.equal(storage.xinhuoReplyHistoryRecords, undefined);
});
await test("AI timeout has an explicit duration diagnostic", async () => {
  const c = contextFor(engine, ["callAIProvider"], {
    AI_PROVIDER_CONFIG: { deepseek: { endpoint: "https://invalid.test", model: "test" } },
    normalizeCustomAIEndpoint: () => "",
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
  });
  await assert.rejects(c.callAIProvider("deepseek", "test-key", "", "", { timeout: 5 }), /超时：5ms/);
});

if (platform === "xinhuo") {
  await test("verification polling backs off to 60s after two minutes", async () => {
    let now = 1000000;
    const delays = [];
    let calls = 0;
    const c = contextFor(background, ["waitForXinhuoFinalVerification"], {
      Date: { now: () => now },
      runtimeState: { currentTask: null },
      XINHUO_VERIFICATION_POLL_MS: 15000,
      isActiveRun: () => true,
      log() {},
      latchXinhuoCompletion: () => true,
      buildXinhuoCompletionEvidence: () => ({}),
      toContentSettings: (s) => s,
      delay: async (ms) => { delays.push(ms); now += ms; },
      waitForTabComplete: async () => true,
      chrome: { tabs: { reload: async () => {} } },
      sendToTab: async () => {
        calls += 1;
        return calls >= 9 ? { ok: true, final: true, message: "done" } : { ok: true, final: false };
      }
    });
    const result = await c.waitForXinhuoFinalVerification(1, "r", {});
    assert.equal(result.final, true);
    assert.equal(delays.length, 9);
    assert.ok(delays.slice(0, 8).every((ms) => ms === 15000), `first eight intervals: ${delays.join(",")}`);
    assert.equal(delays[8], 60000);
  });
  await test("completed xinhuo orders leave the dedupe table, others stay", () => {
    const c = contextFor(background, ["releaseXinhuoAttemptedTask", "getXinhuoTaskDedupeKeys", "getXinhuoTaskIdentity", "normalizeXinhuoTaskPath", "normalizeTweetUrl"], {
      runtimeState: { attemptedTasks: [
        { key: "/tasks/a", expiresAt: Date.now() + 60000 },
        { key: "/tasks/b", expiresAt: Date.now() + 60000 }
      ] },
      XINHUO_TASKS_URL: "https://xinhuo123.com/tasks"
    });
    c.releaseXinhuoAttemptedTask({ taskKey: "https://xinhuo123.com/tasks/a", tweetUrl: "https://x.com/a/status/1" });
    assert.deepEqual([...c.runtimeState.attemptedTasks].map((item) => item.key), ["/tasks/b"]);
  });
  await test("keepalive tick holds the alarm for an active run and clears it once idle", async () => {
    let cleared = 0;
    let platformPokes = 0;
    const context = contextFor(background, ["handleXinhuoKeepaliveTick", "tryResumeXinhuoAfterInterruption", "clearXinhuoKeepalive"], {
      XINHUO_KEEPALIVE_ALARM: "xinhuoAutoRunKeepaliveV1",
      runtimeStateReady: Promise.resolve(),
      runtimeState: { running: true, mode: "auto" },
      chrome: {
        alarms: { async clear() { cleared += 1; return true; } },
        runtime: { async getPlatformInfo() { platformPokes += 1; return {}; } }
      }
    });
    await context.handleXinhuoKeepaliveTick();
    assert.equal(cleared, 0);
    assert.ok(platformPokes >= 1);
    context.runtimeState.running = false;
    context.runtimeState.mode = "idle";
    context.runtimeState.stage = "finished";
    await context.handleXinhuoKeepaliveTick();
    assert.equal(cleared, 1);
  });
  await test("keepalive remains armed while an interrupted claimed Xinhuo order awaits an official state", async () => {
    let cleared = 0;
    const context = contextFor(background, ["handleXinhuoKeepaliveTick"], {
      runtimeStateReady: Promise.resolve(),
      runtimeState: { running: false, mode: "idle", stage: "claimed_task_recovery_blocked" },
      tryResumeXinhuoAfterInterruption: async () => false,
      clearXinhuoKeepalive: async () => { cleared += 1; }
    });
    await context.handleXinhuoKeepaliveTick();
    assert.equal(cleared, 0);
  });
  await test("worker restart resumes an interrupted xinhuo run without a claimed order", async () => {
    let scans = 0;
    const cancelled = [];
    const context = contextFor(background, ["tryResumeXinhuoAfterInterruption"], {
      runtimeState: {
        running: false,
        mode: "idle",
        stage: "interrupted_not_resumed",
        runId: "old-run",
        xinhuoTabId: 11,
        xTabId: 22,
        currentTask: { taskKey: "/tasks/a", claimed: false },
        completionEvidence: null
      },
      log() {},
      setStage() {},
      createRunId: () => "resumed-run",
      describeXinhuoTaskForLog: () => "0.100KX · @a · t",
      chrome: { tabs: { async sendMessage(tabId, message) { cancelled.push({ tabId, type: message.type, runId: message.runId }); return { ok: true }; } } },
      async runNextXinhuoTask(reason) {
        scans += 1;
        assert.equal(reason, "resume_after_service_worker_restart");
        assert.equal(context.runtimeState.running, true);
        assert.equal(context.runtimeState.mode, "auto");
        assert.equal(context.runtimeState.runId, "resumed-run");
      }
    });
    assert.equal(await context.tryResumeXinhuoAfterInterruption(), true);
    assert.equal(scans, 1);
    assert.deepEqual(cancelled, [{ tabId: 11, type: "CANCEL_XINHUO_RUN", runId: "old-run" }]);
    assert.equal(context.runtimeState.xTabId, null);
  });
  await test("worker restart never resumes on top of a claimed unfinished xinhuo order", async () => {
    let scans = 0;
    const context = contextFor(background, ["tryResumeXinhuoAfterInterruption"], {
      runtimeState: {
        running: false,
        mode: "idle",
        stage: "interrupted_not_resumed",
        runId: "old-run",
        currentTask: { taskKey: "/tasks/a", claimed: true },
        completionEvidence: null
      },
      log() {}, setStage() {}, createRunId: () => "resumed-run",
      describeXinhuoTaskForLog: () => "0.100KX · @a · t",
      chrome: { tabs: { async sendMessage() { throw new Error("must not cancel"); } } },
      async runNextXinhuoTask() { scans += 1; }
    });
    assert.equal(await context.tryResumeXinhuoAfterInterruption(), false);
    assert.equal(scans, 0);
    assert.equal(context.runtimeState.running, false);
  });
  await test("selection status explains why nothing is claimable", () => {
    const c = contextFor(page, ["buildSelectionStatus", "formatDuration"], {});
    const tasks = [
      { taskKey: "/tasks/dedup", ready: true, cooldownMs: 0 },
      { taskKey: "/tasks/blocked", ready: false, cooldownMs: 0 },
      { taskKey: "/tasks/cool", ready: false, cooldownMs: 90000 }
    ];
    const withCooling = c.buildSelectionStatus(tasks, new Set(["/tasks/dedup"]), 0);
    assert.match(withCooling, /仍在冷却：1分30秒/);
    assert.match(withCooling, /去重 1 笔/);
    assert.match(withCooling, /状态暂不可接 1 笔/);
    const noCooling = c.buildSelectionStatus(tasks.slice(0, 2), new Set(), 0.5);
    assert.match(noCooling, /暂无可立即接取/);
    assert.match(noCooling, /低于 0\.5 KX 已过滤/);
  });
  await test("seat-race release plans return to plaza until the final minute", () => {
    const c = contextFor(page, ["getDetailSeatReleasePlan", "getActiveAttemptedTaskKeys", "isClaimWindowCandidate"]);
    const before = Date.now();
    const raced = c.getDetailSeatReleasePlan(239000);
    assert.equal(raced.returnToMarketplace, true);
    assert.equal(raced.retryAfterMs, 179000);
    assert.ok(raced.retryAt >= before + 178900);
    assert.equal(c.getDetailSeatReleasePlan(60000).returnToMarketplace, false);
    assert.equal(c.isClaimWindowCandidate({ ready: false, cooldownMs: 60000, anchor: { getAttribute: () => "false" } }), true);
    assert.equal(c.isClaimWindowCandidate({ ready: false, cooldownMs: 60001, anchor: { getAttribute: () => "false" } }), false);
  });
  await test("expired plaza retry records become eligible without restarting the scan", () => {
    const c = contextFor(page, ["getActiveAttemptedTaskKeys"]);
    const now = Date.now();
    assert.deepEqual([...c.getActiveAttemptedTaskKeys([
      { key: "/tasks/expired", expiresAt: now - 1 },
      { key: "/tasks/future", expiresAt: now + 1000 }
    ])], ["/tasks/future"]);
  });
  await test("dedupe registration logs each task exactly once with its identity", () => {
    const logs = [];
    const c = contextFor(background, [
      "markAttemptedTask", "formatXinhuoRetryDelay", "describeXinhuoTaskForLog", "getXinhuoTaskDedupeKeys",
      "getXinhuoTaskIdentity", "normalizeXinhuoTaskPath", "normalizeTweetUrl"
    ], {
      runtimeState: { attemptedTasks: [] },
      ATTEMPT_DEDUPE_MS: 180000,
      XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      log(level, text) { logs.push(text); }
    });
    const task = { taskKey: "https://xinhuo123.com/tasks/abc", tweetUrl: "https://x.com/a/status/1", bounty: 0.2, handle: "@a", candidateTitle: "标题" };
    c.markAttemptedTask(task);
    c.markAttemptedTask(task);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /已登记去重 3 分钟：0\.200KX · @a · 标题/);
    assert.deepEqual([...c.runtimeState.attemptedTasks].map((item) => item.key), ["/tasks/abc", "https://x.com/a/status/1"]);
  });
  await test("seat-race retry expires at the next detail-entry window", () => {
    const logs = [];
    const c = contextFor(background, [
      "markAttemptedTask", "formatXinhuoRetryDelay", "describeXinhuoTaskForLog", "getXinhuoTaskDedupeKeys",
      "getXinhuoTaskIdentity", "normalizeXinhuoTaskPath", "normalizeTweetUrl"
    ], {
      runtimeState: { attemptedTasks: [] }, ATTEMPT_DEDUPE_MS: 180000,
      XINHUO_TASKS_URL: "https://xinhuo123.com/tasks", log(_level, text) { logs.push(text); }
    });
    const retryAt = Date.now() + 179000;
    c.markAttemptedTask({ taskKey: "/tasks/seat-race", retryAt });
    assert.ok(c.runtimeState.attemptedTasks.every((item) => item.expiresAt >= retryAt - 5));
    assert.match(logs[0], /2分59秒 后重新检测（下次放号前 1 分钟）/);
  });
  await test("Xinhuo workflow queue runs every remaining step in order", async () => {
    const commands = [];
    const buttons = ["A", "B", "C"].map((command) => ({
      dataset: { command },
      querySelector: () => ({ textContent: command })
    }));
    const c = contextFor(debugPanel, ["runStepQueue"], {
      commandQueueRunning: false,
      stepButtons: buttons,
      async saveSettings() { return true; },
      setStepButtonsDisabled() {}, setButtonRunning() {}, showCommandStatus() {},
      async sendCommandAndWaitForStage(command) { commands.push(command); return { ok: true }; },
      async loadState() {}
    });
    await c.runStepQueue(1);
    assert.deepEqual(commands, ["B", "C"]);
  });
  await test("Xinhuo workflow queue stops at the first failed step", async () => {
    const commands = [];
    const statuses = [];
    const buttons = ["A", "B", "C"].map((command) => ({
      dataset: { command },
      querySelector: () => ({ textContent: command })
    }));
    const c = contextFor(debugPanel, ["runStepQueue"], {
      commandQueueRunning: false,
      stepButtons: buttons,
      async saveSettings() { return true; },
      setStepButtonsDisabled() {}, setButtonRunning() {},
      showCommandStatus(text, kind) { statuses.push({ text, kind }); },
      async sendCommandAndWaitForStage(command) {
        commands.push(command);
        return command === "B" ? { ok: false, error: "B failed" } : { ok: true };
      },
      async loadState() {}
    });
    await c.runStepQueue(0);
    assert.deepEqual(commands, ["A", "B"]);
    assert.deepEqual(statuses.at(-1), { text: "B failed", kind: "error" });
  });
  await test("Xinhuo workflow queue accepts the final step as a boundary", async () => {
    const commands = [];
    const buttons = ["A", "B", "C"].map((command) => ({
      dataset: { command },
      querySelector: () => ({ textContent: command })
    }));
    const c = contextFor(debugPanel, ["runStepQueue"], {
      commandQueueRunning: false,
      stepButtons: buttons,
      async saveSettings() { return true; },
      setStepButtonsDisabled() {}, setButtonRunning() {}, showCommandStatus() {},
      async sendCommandAndWaitForStage(command) { commands.push(command); return { ok: true }; },
      async loadState() {}
    });
    await c.runStepQueue(2);
    assert.deepEqual(commands, ["C"]);
  });
  await test("wrong-window Xinhuo debug command is rejected before takeover", async () => {
    let prepareCount = 0;
    let dispatchCount = 0;
    const state = { running: true, mode: "auto", windowId: 1, runId: "auto-run" };
    const c = contextFor(background, ["runManualDebugCommand"], {
      runtimeState: state,
      lockRuntimeWindowForCommand: () => ({ ok: false, error: "wrong window" }),
      async prepareDebugRunForCommand() { prepareCount += 1; },
      async debugRunXinhuoXReply() { dispatchCount += 1; return { ok: true }; }
    });
    const result = await c.runManualDebugCommand({ type: "DEBUG_XINHUO_RUN_X_REPLY" }, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error, "wrong window");
    assert.equal(prepareCount, 0);
    assert.equal(dispatchCount, 0);
    assert.equal(state.mode, "auto");
  });
  await test("concurrent Xinhuo manual debug commands are serialized", async () => {
    let active = 0;
    let maxActive = 0;
    const starts = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const c = contextFor(background, ["enqueueManualDebugCommand"], {
      manualDebugCommandTail: Promise.resolve(),
      async runManualDebugCommand(message) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push(message.type);
        if (message.type === "DEBUG_XINHUO_OPEN_TASKS") await firstGate;
        active -= 1;
        return { ok: true };
      }
    });
    const first = c.enqueueManualDebugCommand({ type: "DEBUG_XINHUO_OPEN_TASKS" }, 1);
    const second = c.enqueueManualDebugCommand({ type: "DEBUG_XINHUO_RUN_X_REPLY" }, 1);
    await Promise.resolve();
    assert.deepEqual(starts, ["DEBUG_XINHUO_OPEN_TASKS"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(starts, ["DEBUG_XINHUO_OPEN_TASKS", "DEBUG_XINHUO_RUN_X_REPLY"]);
    assert.equal(maxActive, 1);
  });
  await test("Xinhuo debug open step opens a detail without claiming it", async () => {
    const location = { pathname: "/tasks", href: "https://xinhuo123.com/tasks" };
    let claimCalls = 0;
    const candidate = {
      taskKey: "/tasks/a", href: "https://xinhuo123.com/tasks/a", ready: true,
      attempted: false, bounty: 0.1,
      anchor: { click() { location.pathname = "/tasks/a"; } }
    };
    const c = contextFor(page, ["openFirstReadyTask", "normalizeAttemptedTaskRecords", "getActiveAttemptedTaskKeys", "isClaimWindowCandidate"], {
      location,
      activeRunId: "r",
      async ensureTasksPage() {}, assertActive() {},
      collectCandidates: () => [candidate], meetsMinimumBounty: () => true,
      hasAlreadyClaimed: () => false, findClaimButton: () => ({}),
      async waitFor(predicate) { assert.equal(predicate(), true); },
      buildOpenedTask: () => ({ taskKey: "/tasks/a", detailPath: "/tasks/a", claimed: false }),
      async claimCurrentDetail() { claimCalls += 1; }, report() {}, wait: async () => {}
    });
    const result = await c.openFirstReadyTask({ cooldownPollMs: 500 }, []);
    assert.equal(result.ok, true);
    assert.equal(result.task.claimed, false);
    assert.equal(claimCalls, 0);
  });
  await test("Xinhuo debug claim step claims only the already opened current detail", async () => {
    let receivedCandidate = null;
    const c = contextFor(page, ["claimCurrentTask"], {
      activeRunId: "r", location: { pathname: "/tasks/a" },
      assertActive() {}, assertCurrentClaimedTask() {}, hasAlreadyClaimed: () => false,
      normalize: (value) => String(value || ""), document: { body: { innerText: "评论 0.1 KX" } },
      parseBounty: () => 0.1,
      async claimCurrentDetail(candidate) {
        receivedCandidate = candidate;
        return { ok: true, task: { ...candidate, claimed: true, tweetUrl: "https://x.com/a/status/1" } };
      }
    });
    const result = await c.claimCurrentTask({}, { taskKey: "/tasks/a", taskType: "评论", candidateTitle: "A" });
    assert.equal(result.ok, true);
    assert.equal(receivedCandidate.taskKey, "/tasks/a");
    assert.equal(result.task.claimed, true);
  });
  await test("already-claimed Xinhuo debug step returns a flat task result", async () => {
    const claimedTask = { taskKey: "/tasks/a", detailPath: "/tasks/a", claimed: true, tweetUrl: "https://x.com/a/status/1" };
    const c = contextFor(page, ["claimCurrentTask"], {
      activeRunId: "r", assertActive() {}, assertCurrentClaimedTask() {},
      hasAlreadyClaimed: () => true,
      getManuallyClaimedTask: () => ({ ok: true, task: claimedTask })
    });
    const result = await c.claimCurrentTask({}, claimedTask);
    assert.equal(result.ok, true);
    assert.equal(result.task, claimedTask);
    assert.equal(result.task.task, undefined);
  });
  await test("Xinhuo workflow step one starts a fresh debug run", async () => {
    const state = {
      running: true, mode: "debug", runId: "old", currentTask: { taskKey: "/tasks/old" },
      xinhuoTabId: 1, xTabId: 2, xTabWindowId: 9, completionEvidence: { taskKey: "/tasks/old" }
    };
    const cancellations = [];
    const c = contextFor(background, ["debugOpenXinhuoTasks"], {
      runtimeState: state, createRunId: () => "fresh",
      async sendToTab(tabId, message) { cancellations.push([tabId, message.type, message.runId]); return { ok: true }; },
      clearXinhuoXOpenWatch() {}, clearXinhuoXSubmission() {},
      ensureXinhuoMarketplaceTab: async () => ({ id: 1 }),
      chrome: { tabs: { update: async () => ({}) } }, waitForTabComplete: async () => {},
      setStage(stage) { state.stage = stage; }, log() {}, XINHUO_TASKS_URL: "https://xinhuo123.com/tasks"
    });
    const result = await c.debugOpenXinhuoTasks();
    assert.equal(result.ok, true);
    assert.equal(state.runId, "fresh");
    assert.equal(state.currentTask, null);
    assert.deepEqual(cancellations, [
      [1, "CANCEL_XINHUO_RUN", "old"],
      [2, "CANCEL_X_RUN", "old"]
    ]);
  });
  await test("rapid duplicate Xinhuo start is rejected before settings resolve", async () => {
    let releaseSettings;
    const settings = new Promise((resolve) => { releaseSettings = resolve; });
    const state = { running: false, currentTask: null };
    const c = contextFor(background, ["startXinhuoRun", "ensureXinhuoKeepalive"], {
      runtimeState: state,
      getRecoverableInterruptedTask: () => null,
      createInitialState: () => ({ running: false, currentTask: null }),
      createRunId: () => "run",
      getSettings: () => settings,
      getScheduleState: () => ({ inWindow: true }),
      setStage() {}, log() {}, findRecoverableClaimedXinhuoTask: async () => null,
      runNextXinhuoTask: async () => ({ ok: true })
    });
    const first = c.startXinhuoRun(1);
    const second = await c.startXinhuoRun(1);
    assert.equal(second.ok, false);
    assert.equal(c.runtimeState.running, true);
    releaseSettings({ replyMode: "fill", autoSubmitXinhuo: true, aiApiKey: "key" });
    assert.equal((await first).ok, false);
  });
  await test("manual Xinhuo start preserves a still-claimed interrupted order instead of scanning a new task", async () => {
    const savedTask = { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1", claimed: true };
    let scans = 0;
    let keepaliveClears = 0;
    const c = contextFor(background, ["startXinhuoRun"], {
      runtimeState: { running: false, mode: "idle", stage: "claimed_task_recovery_blocked", currentTask: savedTask },
      getRecoverableInterruptedTask: () => savedTask,
      createInitialState: () => ({ running: false, mode: "idle", currentTask: null, completed: 0, failed: 0 }),
      createRunId: () => "manual-run",
      getSettings: async () => ({ replyMode: "post", autoSubmitXinhuo: true, aiApiKey: "key" }),
      getScheduleState: () => ({ inWindow: true }),
      ensureXinhuoKeepalive: async () => {},
      clearXinhuoKeepalive: async () => { keepaliveClears += 1; },
      inspectInterruptedXinhuoOrder: async () => ({ kind: "claimed", tab: { id: 8 }, task: savedTask, message: "待复核" }),
      setStage() {}, log() {},
      runNextXinhuoTask: async () => { scans += 1; return { ok: true }; }
    });
    const result = await c.startXinhuoRun(1);
    assert.equal(result.ok, false);
    assert.equal(scans, 0);
    assert.equal(c.runtimeState.currentTask.taskKey, "/tasks/a");
    assert.equal(c.runtimeState.running, false);
    assert.equal(keepaliveClears, 1);
  });
  await test("concurrent marketplace initialization shares one tab lookup", async () => {
    let lookups = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const c = contextFor(background, ["ensureXinhuoMarketplaceTab", "ensureXinhuoMarketplaceTabOnce"], {
      xinhuoMarketplaceTabPromise: null,
      getOrCreateXinhuoTab: async () => { lookups += 1; return pending; },
      isXinhuoUrl: (url) => String(url || "").startsWith("https://xinhuo123.com/"),
      log() {}, delay: async () => {}
    });
    const first = c.ensureXinhuoMarketplaceTab();
    const second = c.ensureXinhuoMarketplaceTab();
    await Promise.resolve();
    release({ id: 7, url: "https://xinhuo123.com/tasks" });
    assert.equal((await first).id, 7);
    assert.equal((await second).id, 7);
    assert.equal(lookups, 1);
  });
  await test("duplicate marketplace tabs are reduced to one in the runtime window", async () => {
    const tabs = [
      { id: 1, windowId: 9, url: "https://xinhuo123.com/tasks" },
      { id: 2, windowId: 9, url: "https://xinhuo123.com/tasks?tab=2" },
      { id: 3, windowId: 9, url: "https://xinhuo123.com/tasks" },
      { id: 4, windowId: 9, url: "https://xinhuo123.com/tasks/claimed" },
      { id: 5, windowId: 10, url: "https://xinhuo123.com/tasks" }
    ];
    const removed = [];
    let queryInfo;
    const c = contextFor(background, ["getOrCreateXinhuoTab"], {
      runtimeState: { xinhuoTabId: null, windowId: 9 },
      chrome: {
        tabs: {
          query: async (query) => { queryInfo = query; return tabs; },
          remove: async (tabId) => { removed.push(tabId); },
          create: async () => ({ id: 6, windowId: 9, url: "https://xinhuo123.com/tasks" })
        }
      },
      isXinhuoUrl: (url) => /^https:\/\/xinhuo123\.com\//.test(String(url || "")),
      isXinhuoMarketplaceUrl: (url) => /^https:\/\/xinhuo123\.com\/tasks(?:[?#]|$)/.test(String(url || "")),
      XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      log() {}
    });
    const result = await c.getOrCreateXinhuoTab();
    assert.equal(result.id, 1);
    assert.equal(queryInfo.windowId, 9);
    assert.deepEqual(removed, [2, 3]);
  });
  await test("remembered marketplace tab remains the keeper while duplicates are removed", async () => {
    const tabs = [
      { id: 1, windowId: 9, url: "https://xinhuo123.com/tasks" },
      { id: 2, windowId: 9, url: "https://xinhuo123.com/tasks?tab=2" },
      { id: 3, windowId: 10, url: "https://xinhuo123.com/tasks" }
    ];
    const removed = [];
    let queryInfo;
    const c = contextFor(background, ["getOrCreateXinhuoTab"], {
      runtimeState: { xinhuoTabId: 1, windowId: 9 },
      chrome: {
        tabs: {
          get: async (tabId) => tabs.find((tab) => tab.id === tabId),
          query: async (query) => { queryInfo = query; return tabs; },
          remove: async (tabId) => { removed.push(tabId); }
        }
      },
      isXinhuoUrl: (url) => /^https:\/\/xinhuo123\.com\//.test(String(url || "")),
      isXinhuoMarketplaceUrl: (url) => /^https:\/\/xinhuo123\.com\/tasks(?:[?#]|$)/.test(String(url || "")),
      log() {}
    });
    const result = await c.getOrCreateXinhuoTab();
    assert.equal(result.id, 1);
    assert.equal(queryInfo.windowId, 9);
    assert.deepEqual(removed, [2]);
  });
  await test("settings migration updates only the old default prompt and adds manual model", () => {
    const defaults = {
      settingsVersion: 5, taskPlatform: "xinhuo", actionDelayMs: 1200, claimTimeoutMs: 60000,
      cooldownPollMs: 500, xinhuoMinTaskBounty: 0, maxTasksPerRun: 9999, maxTaskAttempts: 9999,
      replyMode: "post", replyProvider: "native", autoSubmitXinhuo: true, aiProvider: "deepseek",
      aiModel: "", aiApiUrl: "", aiApiKey: "", aiSystemPrompt: "new prompt",
      runWindowEnabled: false, runWindowStart: "11:00", runWindowEnd: "01:00"
    };
    const c = contextFor(background, ["migrateSettings", "normalizeSettings"], {
      DEFAULT_SETTINGS: defaults,
      XINHUO_DEFAULT_AI_SYSTEM_PROMPT: "new prompt",
      XINHUO_PREVIOUS_DEFAULT_AI_SYSTEM_PROMPT: "previous default prompt",
      normalizeClock: (value, fallback) => /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : fallback
    });
    const migrated = c.normalizeSettings({ settingsVersion: 1, aiProvider: "gpt-5.6-terra", aiSystemPrompt: "你是普通中文用户，帮我写一条推文回复。像路过随手回一句。" });
    assert.equal(migrated.settingsVersion, 5);
    assert.equal(migrated.aiProvider, "openai");
    assert.equal(migrated.aiModel, "gpt-5.6-terra");
    assert.equal(migrated.aiSystemPrompt, "new prompt");
    const custom = c.normalizeSettings({ settingsVersion: 1, aiSystemPrompt: "只写我自己的风格" });
    assert.equal(custom.aiSystemPrompt, "只写我自己的风格");
    const upgraded = c.normalizeSettings({ settingsVersion: 4, aiSystemPrompt: "previous default prompt" });
    assert.equal(upgraded.aiSystemPrompt, "new prompt");
    const preservedCustomRange = c.normalizeSettings({ settingsVersion: 4, aiSystemPrompt: "保留我的 10 到 15 字自定义规则" });
    assert.equal(preservedCustomRange.aiSystemPrompt, "保留我的 10 到 15 字自定义规则");
    const preserved = c.normalizeSettings({
      settingsVersion: 3,
      aiProvider: "gpt-5-nano",
      aiModel: "custom-model",
      aiApiUrl: "https://relay.example/v1/responses",
      aiApiKey: "secret"
    });
    assert.equal(preserved.aiProvider, "openai");
    assert.equal(preserved.aiModel, "custom-model");
    assert.equal(preserved.aiApiUrl, "https://relay.example/v1/responses");
    assert.equal(preserved.aiApiKey, "secret");
  });
  await test("removing the provider control does not reroute an existing provider API key", () => {
    const defaults = {
      settingsVersion: 4, taskPlatform: "xinhuo", actionDelayMs: 1200, claimTimeoutMs: 60000,
      cooldownPollMs: 500, xinhuoMinTaskBounty: 0, maxTasksPerRun: 9999, maxTaskAttempts: 9999,
      replyMode: "post", replyProvider: "native", autoSubmitXinhuo: true, aiProvider: "openai",
      aiModel: "gpt-5.6-terra", aiApiUrl: "", aiApiKey: "", aiSystemPrompt: "new prompt",
      runWindowEnabled: false, runWindowStart: "11:00", runWindowEnd: "01:00"
    };
    const c = contextFor(background, ["migrateSettings", "normalizeSettings"], {
      DEFAULT_SETTINGS: defaults,
      XINHUO_DEFAULT_AI_SYSTEM_PROMPT: "new prompt",
      XINHUO_PREVIOUS_DEFAULT_AI_SYSTEM_PROMPT: "previous default prompt",
      normalizeClock: (value, fallback) => /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : fallback
    });
    const normalized = c.normalizeSettings({
      settingsVersion: 3,
      aiProvider: "deepseek",
      aiModel: "deepseek-chat",
      aiApiUrl: "https://api.deepseek.com/chat/completions",
      aiApiKey: "deepseek-key"
    });
    assert.equal(normalized.aiProvider, "deepseek");
    assert.equal(normalized.aiApiUrl, "https://api.deepseek.com/chat/completions");
    assert.equal(normalized.aiApiKey, "deepseek-key");
  });
  await test("manual AI model overrides the provider default in requests", async () => {
    let requestBody = null;
    const c = contextFor(engine, ["callAIProvider"], {
      AI_PROVIDER_CONFIG: { openai: { endpoint: "https://example.test/v1/responses", model: "default-model" } },
      normalizeCustomAIEndpoint: () => "",
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {};
      },
      readJsonResponse: async () => ({ output_text: "收到" })
    });
    const reply = await c.callAIProvider("openai", "key", "prompt", "tweet", { model: "manual-model", timeout: 1000 });
    assert.equal(reply, "收到");
    assert.equal(requestBody.model, "manual-model");
  });
  await test("whitespace-only AI model falls back to the configured default", () => {
    const defaults = {
      settingsVersion: 4, taskPlatform: "xinhuo", actionDelayMs: 1200, claimTimeoutMs: 60000,
      cooldownPollMs: 500, xinhuoMinTaskBounty: 0, maxTasksPerRun: 9999, maxTaskAttempts: 9999,
      replyMode: "post", replyProvider: "native", autoSubmitXinhuo: true, aiProvider: "openai",
      aiModel: "gpt-5.6-terra", aiApiUrl: "", aiApiKey: "", aiSystemPrompt: "new prompt",
      runWindowEnabled: false, runWindowStart: "11:00", runWindowEnd: "01:00"
    };
    const c = contextFor(background, ["migrateSettings", "normalizeSettings"], {
      DEFAULT_SETTINGS: defaults,
      XINHUO_DEFAULT_AI_SYSTEM_PROMPT: "new prompt",
      XINHUO_PREVIOUS_DEFAULT_AI_SYSTEM_PROMPT: "previous default prompt",
      normalizeClock: (value, fallback) => /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : fallback
    });
    const normalized = c.normalizeSettings({ settingsVersion: 4, aiProvider: "openai", aiModel: "   " });
    assert.equal(normalized.aiModel, "gpt-5.6-terra");
  });
  await test("a new Xinhuo task never inherits the previous task tweet URL", () => {
    const c = contextFor(background, ["mergeXinhuoTask", "getXinhuoTaskIdentity", "normalizeXinhuoTaskPath", "normalizeTweetUrl"], {
      XINHUO_TASKS_URL: "https://xinhuo123.com/tasks"
    });
    const oldTask = { taskKey: "/tasks/old", detailPath: "/tasks/old", tweetUrl: "https://x.com/old/status/1" };
    assert.equal(c.mergeXinhuoTask(oldTask, { taskKey: "/tasks/new", detailPath: "/tasks/new" }).tweetUrl, "");
    assert.equal(c.mergeXinhuoTask(oldTask, { taskKey: "/tasks/old" }).tweetUrl, "https://x.com/old/status/1");
  });
  await test("interrupted order recovery requires the saved path and tweet URL to both match", async () => {
    const saved = { stage: "interrupted_not_resumed", currentTask: {
      claimed: true, taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1"
    } };
    let returnedTweetUrl = "https://x.com/wrong/status/2";
    const c = contextFor(background, ["getRecoverableInterruptedTask", "findRecoverableClaimedXinhuoTask", "mergeXinhuoTask", "getXinhuoTaskIdentity", "normalizeXinhuoTaskPath", "normalizeTweetUrl"], {
      XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      runtimeState: { running: true, mode: "auto", runId: "r", windowId: 1, currentTask: null },
      chrome: { tabs: { query: async () => [{ id: 8, windowId: 1, url: "https://xinhuo123.com/tasks/a" }] } },
      sendToTab: async () => ({ ok: true, task: { claimed: true, taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: returnedTweetUrl } })
    });
    const candidate = c.getRecoverableInterruptedTask(saved);
    assert.ok(candidate);
    assert.equal(await c.findRecoverableClaimedXinhuoTask(candidate), null);
    returnedTweetUrl = candidate.tweetUrl;
    const recovered = await c.findRecoverableClaimedXinhuoTask(candidate);
    assert.equal(recovered.tab.id, 8);
    assert.equal(recovered.task.taskKey, "/tasks/a");
  });
  await test("matching official evidence counts a Xinhuo task exactly once", async () => {
    const state = { running: true, runId: "r", completed: 0, failed: 0,
      currentTask: { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1" } };
    let scans = 0;
    const c = contextFor(background, ["finishXinhuoOfficialResult", "clearCompletedXinhuoTaskState", "latchXinhuoCompletion", "hasLatchedXinhuoCompletion", "buildXinhuoCompletionEvidence", "getXinhuoTaskIdentity", "normalizeXinhuoTaskPath", "normalizeTweetUrl"], {
      runtimeState: state, XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      touchRunState() {}, clearXinhuoXSubmission() {}, setStage() {}, log() {}, delay: async () => {},
      releaseXinhuoAttemptedTask() {},
      stopWithFailure: async (message) => ({ ok: false, message }), waitForTabComplete: async () => {},
      runNextXinhuoTask: async () => { scans += 1; return { ok: true }; },
      chrome: { tabs: { update: async () => ({}) } }
    });
    const final = { ok: true, final: true, state: "confirmed", success: true,
      evidence: { platform: "xinhuo", runId: "r", taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1" } };
    await Promise.all([
      c.finishXinhuoOfficialResult({ id: 1 }, "r", { actionDelayMs: 0 }, final),
      c.finishXinhuoOfficialResult({ id: 1 }, "r", { actionDelayMs: 0 }, final)
    ]);
    assert.equal(state.completed, 1);
    assert.equal(scans, 1);
  });
  await test("concurrent Xinhuo fallback opens only one exact X tab", async () => {
    let creates = 0;
    let releaseCreate;
    const created = new Promise((resolve) => { releaseCreate = resolve; });
    const state = { running: true, mode: "auto", runId: "r", windowId: 9, xTabId: null,
      currentTask: { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1" } };
    const c = contextFor(background, ["openXinhuoFallbackXTab"], {
      runtimeState: state, directXinhuoXOpen: null,
      normalizeTweetUrl: (s) => String(s || ""), getXinhuoTaskIdentity: (task) => task?.taskKey || "",
      getBoundMatchingXinhuoXTab: async () => null, consumeXinhuoOpenedXTab: () => null,
      findTargetXTab: async () => null, isActiveRun: () => true, clearXinhuoXOpenWatch() {},
      mergeXinhuoTask: (current, next, extra) => ({ ...current, ...next, ...extra }),
      focusXinhuoXTab: async () => {}, log() {},
      chrome: { tabs: { create: async () => { creates += 1; return created; } } }
    });
    const first = c.openXinhuoFallbackXTab(state.currentTask, 1, "r");
    const second = c.openXinhuoFallbackXTab(state.currentTask, 1, "r");
    await Promise.resolve();
    releaseCreate({ id: 2, windowId: 9, url: state.currentTask.tweetUrl });
    assert.equal((await first).id, 2);
    assert.equal((await second).id, 2);
    assert.equal(creates, 1);
  });
  await test("official completion wins when the X widget times out after a real submission attempt", async () => {
    const state = { runId: "r", running: true, completed: 0, attempts: 0 };
    const sent = [];
    const navigations = [];
    const task = { taskKey: "/tasks/a", detailPath: "/tasks/a", claimed: true, tweetUrl: "https://x.com/a/status/1" };
    const c = contextFor(background, ["runNextXinhuoTask", "waitForXinhuoFinalVerification"], {
      runtimeState: state, XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      XINHUO_X_HYDRATION_MS: 0, XINHUO_FOREGROUND_MS: 0, XINHUO_VERIFICATION_POLL_MS: 0,
      isActiveRun: (id) => state.running && state.runId === id,
      getSettings: async () => ({ aiApiKey: "test", maxTasksPerRun: 1, maxTaskAttempts: 10, actionDelayMs: 0 }),
      isLimitReached: (count, max) => count >= max,
      finishRun: () => { state.running = false; return { ok: true }; },
      ensureXinhuoMarketplaceTab: async () => ({ id: 1, url: "https://xinhuo123.com/tasks" }),
      assertXinhuoTab() {}, isXinhuoMarketplaceUrl: () => true,
      waitForTabComplete: async () => {}, setStage() {}, log() {}, delay: async () => {},
      beginXinhuoXOpenWatch() {}, getAttemptedTaskRecords: () => [], getAttemptedTaskKeys: () => [], markAttemptedTask() {},
      getSiteOpenedTargetXTab: async () => ({ id: 2 }), focusXinhuoXTab: async () => {},
      maintainXinhuoXForeground: async () => {},
      recordReplyHistory: async () => {}, beginXinhuoXSubmission() {}, clearXinhuoXSubmission() {},
      mergeXinhuoTask: (current, next) => ({ ...(current || {}), ...(next || {}) }),
      latchXinhuoCompletion: () => true,
      buildXinhuoCompletionEvidence: () => ({ runId: "r", taskKey: "/tasks/a", tweetUrl: task.tweetUrl }),
      finishXinhuoOfficialResult: async (tab, _runId, settings, confirmation) => {
        assert.equal(confirmation.final, true);
        state.completed += 1;
        state.currentTask = null;
        await c.chrome.tabs.update(tab.id, { url: "https://xinhuo123.com/tasks", active: true });
        return c.finishRun("done");
      },
      toContentSettings: (s) => s,
      chrome: { tabs: { update: async (id, props) => { navigations.push({ id, ...props }); }, reload: async () => {} } },
      sendToTab: async (id, message) => {
        sent.push(message.type);
        if (message.type === "XINHUO_SELECT_AND_CLAIM") return { ok: true, task };
        if (message.type === "RUN_X_REPLY") return { ok: true };
        if (message.type === "COMPLETE_X_TASK_WIDGET") return { ok: false, submissionAttempted: true, message: "组件观察超时" };
        if (message.type === "XINHUO_WAIT_FOR_SUBMISSION_RESULT") return { ok: true, final: true };
        throw new Error(`Unexpected command ${message.type}`);
      }
    });
    assert.equal((await c.runNextXinhuoTask("test")).ok, true);
    assert.equal(state.completed, 1);
    assert.equal(state.currentTask, null);
    assert.equal(sent.filter((s) => s === "COMPLETE_X_TASK_WIDGET").length, 1);
    assert.equal(sent.filter((s) => s === "XINHUO_CONFIRM_AND_WAIT_VERIFICATION").length, 0);
    assert.equal(sent.filter((s) => s === "XINHUO_WAIT_FOR_SUBMISSION_RESULT").length, 1);
    assert.equal(navigations.at(-1).url, "https://xinhuo123.com/tasks");
    assert.ok(navigations.every((n) => !n.url || n.url.startsWith("https://xinhuo123.com/")));
  });
  await test("unattempted X widget submission uses one current-order verification fallback", async () => {
    const state = { runId: "r", running: true, completed: 0, attempts: 0 };
    const sent = [];
    const task = { taskKey: "/tasks/a", detailPath: "/tasks/a", claimed: true, tweetUrl: "https://x.com/a/status/1" };
    const c = contextFor(background, ["runNextXinhuoTask"], {
      runtimeState: state, XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      XINHUO_X_HYDRATION_MS: 0, XINHUO_FOREGROUND_MS: 0, XINHUO_VERIFICATION_POLL_MS: 0,
      isActiveRun: (id) => state.running && state.runId === id,
      getSettings: async () => ({ aiApiKey: "test", maxTasksPerRun: 1, maxTaskAttempts: 10, actionDelayMs: 0 }),
      isLimitReached: (count, max) => count >= max,
      finishRun: () => { state.running = false; return { ok: true }; },
      ensureXinhuoMarketplaceTab: async () => ({ id: 1, url: "https://xinhuo123.com/tasks" }),
      assertXinhuoTab() {}, isXinhuoMarketplaceUrl: () => true,
      waitForTabComplete: async () => {}, setStage() {}, log() {}, delay: async () => {},
      beginXinhuoXOpenWatch() {}, getAttemptedTaskRecords: () => [], getAttemptedTaskKeys: () => [], markAttemptedTask() {},
      getSiteOpenedTargetXTab: async () => ({ id: 2 }), focusXinhuoXTab: async () => {},
      maintainXinhuoXForeground: async () => {},
      recordReplyHistory: async () => {}, beginXinhuoXSubmission() {}, clearXinhuoXSubmission() {},
      mergeXinhuoTask: (current, next) => ({ ...(current || {}), ...(next || {}) }),
      latchXinhuoCompletion: () => true,
      buildXinhuoCompletionEvidence: () => ({ runId: "r", taskKey: "/tasks/a", tweetUrl: task.tweetUrl }),
      waitForXinhuoFinalVerification: async (_tabId, _runId, _settings, initial) => initial,
      finishXinhuoOfficialResult: async () => { state.completed += 1; state.currentTask = null; return { ok: true }; },
      toContentSettings: (settings) => settings,
      chrome: { tabs: { update: async () => {}, reload: async () => {} } },
      sendToTab: async (_id, message) => {
        sent.push(message.type);
        if (message.type === "XINHUO_SELECT_AND_CLAIM") return { ok: true, task };
        if (message.type === "RUN_X_REPLY") return { ok: true };
        if (message.type === "COMPLETE_X_TASK_WIDGET") return { ok: false, message: "未检测到薪火 X 任务组件" };
        if (message.type === "XINHUO_CONFIRM_AND_WAIT_VERIFICATION") return { ok: true, final: true, success: true, state: "confirmed" };
        throw new Error(`Unexpected command ${message.type}`);
      }
    });
    assert.equal((await c.runNextXinhuoTask("test")).ok, true);
    assert.equal(state.completed, 1);
    assert.equal(sent.filter((type) => type === "XINHUO_CONFIRM_AND_WAIT_VERIFICATION").length, 1);
    assert.equal(sent.includes("XINHUO_WAIT_FOR_SUBMISSION_RESULT"), false);
  });
  await test("foreground keeper repeatedly focuses the task X tab until stopped", async () => {
    let focuses = 0;
    const control = { stopped: false };
    const c = contextFor(background, ["maintainXinhuoXForeground"], {
      XINHUO_FOREGROUND_REFOCUS_MS: 1000,
      runtimeState: { pendingXSubmission: null },
      isActiveRun: () => true,
      focusXinhuoXTab: async (tabId) => {
        assert.equal(tabId, 2);
        focuses += 1;
        if (focuses === 3) control.stopped = true;
      },
      delay: async () => {},
      log() {}
    });
    await c.maintainXinhuoXForeground(2, "r", control);
    assert.equal(focuses, 3);
  });
  await test("real candidate parser filters quota, tier and cooldown cards", () => {
    const make = (id, text, label = "", disabled = "false", absolute = false) => ({
      innerText: text, href: `https://xinhuo123.com/tasks/${id}`,
      getAttribute: (name) => name === "href" ? (absolute ? `https://xinhuo123.com/tasks/${id}` : `/tasks/${id}`) : (name === "aria-label" ? label : disabled),
      closest: () => null
    });
    const nodes = [
      make("a", "评论 可立即接取 0.1 KX"),
      make("b", "评论 可立即接取 0.1 KX", "额度不足"),
      make("c", "评论 可立即接取 当前等级无席位 0.1 KX"),
      make("d", "评论 等待 43 秒 0.1 KX", "", "true"),
      make("e", "评论 可立即接取 0.2 KX", "", "false", true)
    ];
    const c = contextFor(page, ["collectCandidates", "findMarketplaceTaskAnchors", "normalizeMarketplaceTaskHref", "isCandidateBlocked", "parseBounty", "parseCooldownMs"], {
      location: { href: "https://xinhuo123.com/tasks", origin: "https://xinhuo123.com" },
      document: { querySelectorAll: () => nodes }
    });
    const tasks = c.collectCandidates();
    assert.deepEqual(Array.from(tasks.filter((t) => t.ready), (t) => t.taskKey), ["/tasks/a", "/tasks/e"]);
    assert.equal(tasks.find((t) => t.taskKey === "/tasks/d").cooldownMs, 43000);
  });
  await test("missing Xinhuo widget never invokes a Lighthouse button", async () => {
    let time = 0;
    let foreignClicks = 0;
    const c = contextFor(xPage, ["completeTaskWidgetLifecycle"], {
      activeRunId: "r", assertActiveRun() {}, Date: { now: () => time },
      wait: async () => { time += 30000; },
      findXinhuoTaskWidget: () => null,
      findDocumentVerifyActionButton: () => { foreignClicks += 1; return {}; }
    });
    assert.equal((await c.completeTaskWidgetLifecycle({})).ok, false);
    assert.equal(foreignClicks, 0);
  });
  await test("Xinhuo click without acknowledgement is not clicked again", async () => {
    let clicks = 0;
    const c = contextFor(xPage, ["completeTaskWidgetLifecycle"], {
      activeRunId: "r", assertActiveRun() {}, findXinhuoTaskWidget: () => ({}),
      findXinhuoSubmitButton: () => ({}), getNodeActionText: () => "提交任务",
      activateXinhuoSubmitButton: async () => { clicks += 1; },
      waitForXinhuoTaskWidgetSubmission: async () => ""
    });
    const result = await c.completeTaskWidgetLifecycle({});
    assert.equal(result.submissionAttempted, true);
    assert.equal(result.submitted, false);
    assert.equal(clicks, 1);
  });
  await test("detached widget and disabled submit are not submission evidence", () => {
    const c = contextFor(xPage, ["getXinhuoSubmissionState"], {
      isVisible: () => true,
      getXinhuoTaskWidgetControls: () => [{ text: "提交任务" }],
      getNodeActionText: (node) => node.text,
      isButtonDisabled: () => true
    });
    assert.equal(c.getXinhuoSubmissionState({ isConnected: false }), "");
    assert.equal(c.getXinhuoSubmissionState({ isConnected: true, innerText: "前台停留不足" }), "");
    assert.ok(c.getXinhuoSubmissionState({ isConnected: true, innerText: "已提交任务" }));
  });
  await test("official order labels accepted, instructions/other outcomes rejected", () => {
    const c = contextFor(page, ["getSubmissionState"]);
    for (const label of ["已到账奖励", "任务核验已通过，奖励已结算。", "奖励已到账"]) {
      assert.equal(c.getSubmissionState(label).final, true);
    }
    for (const label of ["核验成功后奖励到账，当前任务尚未提交", "审核通过后奖励", "任务已完成处理，请查看审核结果。"]) {
      assert.equal(c.getSubmissionState(label), null);
    }
    assert.equal(c.getSubmissionState("自动核验未能确认，现已转人工复核。").final, false);
    const failed = c.getSubmissionState("核验失败");
    assert.equal(failed.final, true);
    assert.equal(failed.success, false);
  });
  await test("quota/tier block wins over generic ready wording", () => {
    const c = contextFor(page, ["isCandidateBlocked"]);
    assert.equal(c.isCandidateBlocked("可立即接取 当前等级无席位"), true);
    assert.equal(c.isCandidateBlocked("可立即接取 额度不足"), true);
    assert.equal(c.isCandidateBlocked("可立即接取 评论"), false);
  });
  await test("only reward panel status nodes are inspected", () => {
    const c = contextFor(page, ["getCurrentTaskDetailText"], {
      location: { pathname: "/tasks/a" },
      document: {
        body: { innerText: "奖励已到账" },
        querySelector: (selector) => {
          assert.equal(selector, "aside.reward-panel, [data-task-reward-panel], [data-reward-panel]");
          return null;
        }
      }
    });
    assert.equal(c.getCurrentTaskDetailText(), "");
  });
  await test("generic visible status text inside the current reward panel is accepted", () => {
    const statusNode = { innerText: "奖励已到账", getBoundingClientRect: () => ({ width: 80, height: 20 }) };
    const panel = { querySelectorAll: () => [statusNode] };
    const c = contextFor(page, ["getCurrentTaskDetailText", "getSubmissionState"], {
      location: { pathname: "/tasks/a" },
      document: { querySelector: () => panel }
    });
    assert.equal(c.getSubmissionState(c.getCurrentTaskDetailText()).kind, "confirmed");
  });
  await test("X submission fallback is gated to an unattempted widget submit and stale claims can be released", () => {
    const flow = declaration(background, "runNextXinhuoTask");
    const release = declaration(background, "releaseXinhuoOrderIfNoLongerClaimed");
    assert.match(flow, /const shouldUseDetailVerificationFallback = !submit\?\.ok/);
    assert.match(flow, /!submit\?\.submissionAttempted/);
    assert.match(flow, /type: shouldUseDetailVerificationFallback\s*\? "XINHUO_CONFIRM_AND_WAIT_VERIFICATION"/);
    assert.match(flow, /"XINHUO_WAIT_FOR_SUBMISSION_RESULT"/);
    assert.match(release, /type: "XINHUO_INSPECT_CURRENT_TASK"/);
    assert.match(release, /inspection\?\.claimed !== false/);
    assert.match(release, /clearCompletedXinhuoTaskState\(\)/);
    assert.match(release, /recoverXinhuoRun\(/);
  });
  await test("released Xinhuo order clears stale state and resumes scanning, retained order stays untouched", async () => {
    let inspection = { ok: true, claimed: false };
    let cleared = 0;
    let recovered = 0;
    const state = { currentTask: { taskKey: "/tasks/a", claimed: true } };
    const c = contextFor(background, ["releaseXinhuoOrderIfNoLongerClaimed"], {
      runtimeState: state,
      sendToTab: async () => inspection,
      clearCompletedXinhuoTaskState: () => { cleared += 1; state.currentTask = null; },
      log() {},
      recoverXinhuoRun: async (message, stage) => {
        recovered += 1;
        return { ok: true, message, stage };
      }
    });
    const released = await c.releaseXinhuoOrderIfNoLongerClaimed({ id: 7 }, "r");
    assert.equal(released.ok, true);
    assert.equal(released.stage, "released_claimed_task");
    assert.equal(cleared, 1);
    assert.equal(recovered, 1);
    inspection = { ok: true, claimed: true };
    state.currentTask = { taskKey: "/tasks/a", claimed: true };
    assert.equal(await c.releaseXinhuoOrderIfNoLongerClaimed({ id: 7 }, "r"), null);
    assert.equal(cleared, 1);
    assert.equal(recovered, 1);
  });
  await test("interrupted Xinhuo order inspection distinguishes released, final, and still-claimed orders", async () => {
    let inspection = { ok: false, claimed: false, message: "订单已释放" };
    const task = { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1", claimed: true };
    const c = contextFor(background, ["inspectInterruptedXinhuoOrder"], {
      runtimeState: { runId: "r" },
      XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      normalizeXinhuoTaskPath: (value) => String(value || ""),
      normalizeTweetUrl: (value) => String(value || ""),
      getOrCreateXinhuoTab: async () => ({ id: 3, url: "https://xinhuo123.com/tasks/a" }),
      assertXinhuoTab() {},
      chrome: { tabs: { update: async () => ({ id: 3, url: "https://xinhuo123.com/tasks/a" }) } },
      waitForTabComplete: async () => {},
      sendToTab: async () => inspection,
      mergeXinhuoTask: (...items) => Object.assign({}, ...items)
    });
    assert.equal((await c.inspectInterruptedXinhuoOrder(task)).kind, "released");
    inspection = { ok: true, claimed: true, task: { ...task, officialState: { kind: "confirmed", final: true, success: true, message: "奖励已到账" } } };
    assert.equal((await c.inspectInterruptedXinhuoOrder(task)).kind, "completed");
    inspection = { ok: true, claimed: true, task: { ...task, officialState: { kind: "pending", final: false, message: "待复核" } } };
    assert.equal((await c.inspectInterruptedXinhuoOrder(task)).kind, "claimed");
  });
  await test("worker restart releases stale or completed Xinhuo orders, but never scans past an active order", async () => {
    let inspection = { kind: "released", message: "订单已释放" };
    let scans = 0;
    let released = 0;
    const state = {
      running: false, mode: "idle", stage: "interrupted_not_resumed", runId: "old",
      completed: 2, failed: 0, xinhuoTabId: null, xTabId: 9, xTabWindowId: 1,
      currentTask: { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1", claimed: true }
    };
    const c = contextFor(background, ["tryResumeXinhuoAfterInterruption"], {
      runtimeState: state,
      inspectInterruptedXinhuoOrder: async () => inspection,
      releaseXinhuoAttemptedTask: () => { released += 1; },
      clearCompletedXinhuoTaskState: () => { state.currentTask = null; state.xTabId = null; state.xTabWindowId = null; },
      clearXinhuoXOpenWatch() {}, clearXinhuoXSubmission() {}, describeXinhuoTaskForLog: () => "/tasks/a", log() {},
      createRunId: () => "new", setStage: (stage) => { state.stage = stage; },
      runNextXinhuoTask: async () => { scans += 1; return { ok: true }; }
    });
    assert.equal(await c.tryResumeXinhuoAfterInterruption(), true);
    assert.equal(scans, 1);
    assert.equal(state.currentTask, null);
    assert.equal(released, 0);
    inspection = { kind: "completed", message: "奖励已到账", task: { ...state.currentTask, completionCounted: false } };
    state.running = false;
    state.mode = "idle";
    state.stage = "interrupted_not_resumed";
    state.currentTask = { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1", claimed: true };
    assert.equal(await c.tryResumeXinhuoAfterInterruption(), true);
    assert.equal(state.completed, 3);
    assert.equal(released, 1);
    inspection = { kind: "claimed", message: "待复核", tab: { id: 6 }, task: { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1", claimed: true } };
    state.running = false;
    state.mode = "idle";
    state.stage = "interrupted_not_resumed";
    state.currentTask = { taskKey: "/tasks/a", detailPath: "/tasks/a", tweetUrl: "https://x.com/a/status/1", claimed: true };
    assert.equal(await c.tryResumeXinhuoAfterInterruption(), false);
    assert.equal(scans, 2);
    assert.equal(state.currentTask.claimed, true);
  });
  await test("Xinhuo AI rule log states the effective default or custom length range", () => {
    const c = contextFor(background, ["describeXinhuoReplyRule"], {
      XINHUO_DEFAULT_AI_SYSTEM_PROMPT: "默认提示词",
      getReplyLengthRange: (prompt) => prompt === "默认提示词" ? { min: 10, max: 20 } : { min: 12, max: 18 }
    });
    assert.match(c.describeXinhuoReplyRule({ aiSystemPrompt: "默认提示词" }, 10), /默认 Prompt · 中文 10-20 字 · 任务最低 10 字/);
    assert.match(c.describeXinhuoReplyRule({ aiSystemPrompt: "自定义 12到18" }, 12), /自定义 Prompt · 中文 12-18 字 · 任务最低 12 字/);
  });
} else {
  await test("missing cooldown is unknown, not zero; 10/19/50 second values stay ordered", () => {
    const c = contextFor(page, ["parseCooldownFromCard", "parseCooldownMs", "hasCooldownState", "parseDurationMs"], {
      COOLDOWN_MARKERS: ["冷却", "等待", "后可"], isVisible: () => true, isOwnedByTaskCard: () => true
    });
    const card = { querySelectorAll: () => [] };
    assert.equal(c.parseCooldownFromCard(card, "冷却中，正在加载").remainingMs, Infinity);
    const values = ["冷却中 50s", "冷却中 10s", "冷却中 19s"].map((s) => c.parseCooldownFromCard(card, s).remainingMs).sort((a, b) => a - b);
    assert.deepEqual(values, [10000, 19000, 50000]);
  });
  await test("automatic run blocks debug mutations, but not state reads", async () => {
    const state = { running: true, mode: "auto", runId: "r" };
    const c = contextFor(background, ["handleMessage"], {
      runtimeState: state, runtimeStateReady: Promise.resolve(),
      getMessageWindowId: () => 1, isWindowScopedCommand: () => false, getSettings: async () => ({})
    });
    assert.equal((await c.handleMessage({ type: "DEBUG_RUN_X_REPLY" }, {})).ok, false);
    assert.equal((await c.handleMessage({ type: "START_RUN" }, {})).ok, false);
    assert.equal((await c.handleMessage({ type: "GET_STATE" }, {})).ok, true);
    assert.equal((await c.handleMessage({ type: "X_REPLY_RESULT" }, {})).ignored, true);
  });
  await test("completion count and next scan remain exactly once with overlapping callbacks", async () => {
    const state = { runId: "r", mode: "auto", running: true, completed: 0, currentTask: { taskKey: "a" }, lighthouseTabId: 1 };
    let scans = 0;
    const c = contextFor(background, ["handleLighthouseDone"], {
      runtimeState: state, hasLatchedLighthouseCompletion: () => true,
      getSettings: async () => ({ maxTasksPerRun: 10, actionDelayMs: 0 }),
      isLimitReached: (count, max) => count >= max, log() {},
      closeLighthouseDetailToCampaigns: async () => true, delay: async () => {},
      startNextAutoTask: async () => { scans += 1; return { ok: true }; }
    });
    await Promise.all([c.handleLighthouseDone({ ok: true }), c.handleLighthouseDone({ ok: true })]);
    assert.equal(state.completed, 1);
    assert.equal(scans, 1);
    assert.equal(state.currentTask, null);
  });
  await test("only matching run and task can latch completion", () => {
    const state = { running: true, runId: "r", currentTask: { taskKey: "a", tweetUrl: "https://x.com/a/status/1" } };
    const c = contextFor(background, ["latchLighthouseCompletion", "hasLatchedLighthouseCompletion"], {
      runtimeState: state, normalizeTweetUrl: (s) => s
    });
    const e = { runId: "r", taskKey: "a", tweetUrl: state.currentTask.tweetUrl };
    assert.equal(c.latchLighthouseCompletion({ ...e, taskKey: "b" }, "r"), false);
    assert.equal(c.latchLighthouseCompletion({ ...e, runId: "old" }, "r"), false);
    assert.equal(c.latchLighthouseCompletion(e, "r"), true);
    assert.equal(c.hasLatchedLighthouseCompletion("r"), true);
    state.currentTask = { taskKey: "b" };
    assert.equal(c.hasLatchedLighthouseCompletion("r"), false);
  });
  await test("latched completion returns to marketplace without rereading vanished modal", async () => {
    let closed = 0;
    const c = contextFor(background, ["waitForLighthouseTaskCompletionAndReturn"], {
      runtimeState: { running: true, runId: "r", completionEvidence: { taskKey: "a" } },
      getOrCreateLighthouseTab: async () => ({ id: 1 }),
      LIGHTHOUSE_CAMPAIGNS_URL: "https://app.lhdao.top/campaigns",
      rememberLighthouseTabById: async () => {}, hasLatchedLighthouseCompletion: () => true,
      closeLighthouseDetailToCampaigns: async () => { closed += 1; return true; },
      sendToTab: () => { throw new Error("Should not reread modal"); }
    });
    assert.equal((await c.waitForLighthouseTaskCompletionAndReturn("r", {})).ok, true);
    assert.equal(closed, 1);
  });
  await test("completion watch rejects pre-existing evidence and keeps newly observed evidence", () => {
    const old = { innerText: "old result", querySelectorAll: () => [] };
    const fresh = { innerText: "new result", querySelectorAll: () => [] };
    let roots = [old];
    const c = contextFor(page, ["beginCompletionWatch", "checkOfficialCompletion"], {
      completionContext: null, normalizeTweetUrl: (s) => s,
      findTaskDetailRoot: () => null,
      findOfficialCompletionRoots: () => roots
    });
    const message = { runId: "r", task: { taskKey: "a", tweetUrl: "https://x.com/a/status/1" } };
    c.beginCompletionWatch(message);
    assert.equal(c.checkOfficialCompletion(message).completed, false);
    roots = [old, fresh];
    assert.equal(c.checkOfficialCompletion(message).completed, true);
    roots = [];
    assert.equal(c.checkOfficialCompletion(message).completed, true);
    assert.equal(c.checkOfficialCompletion({ ...message, task: { taskKey: "b" } }).completed, false);
  });
  await test("completion counter is idempotent for an already counted task", async () => {
    const state = { runId: "r", mode: "auto", running: true, completed: 1, currentTask: { completionCounted: true } };
    const c = contextFor(background, ["handleLighthouseDone"], {
      runtimeState: state, hasLatchedLighthouseCompletion: () => true
    });
    assert.equal((await c.handleLighthouseDone({ ok: true })).duplicate, true);
    assert.equal(state.completed, 1);
  });
  await test("tier restriction is blocked even when another status label says ready", () => {
    const monitor = read("src/content/lighthouse-monitor.js");
    const c = contextFor(monitor, ["parseStatusFromCard"], {
      getVisibleTextBlocks: () => [], BLOCKED_MARKERS: ["档位不符", "需灯塔严选资格"],
      COOLING_MARKERS: ["冷却"], READY_MARKERS: ["查看详情"]
    });
    assert.equal(c.parseStatusFromCard({ innerText: "查看详情 档位不符" }).isBlocked, true);
    assert.equal(c.parseStatusFromCard({ innerText: "无法识别的状态" }).isReady, false);
  });
}
console.log(`${platform}: ${passed} behavioral checks passed.`);

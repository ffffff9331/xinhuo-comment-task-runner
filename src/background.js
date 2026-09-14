importScripts("reply-engine.js");

const XINHUO_TASKS_URL = "https://xinhuo123.com/tasks";
const XINHUO_FOREGROUND_MS = 12000;
const XINHUO_FOREGROUND_REFOCUS_MS = 1000;
const XINHUO_SITE_X_OPEN_WAIT_MS = 5000;
const XINHUO_X_HYDRATION_MS = 2500;
const XINHUO_VERIFICATION_POLL_MS = 15000;
const DEBUG_PAGE_URL = chrome.runtime.getURL("src/debug/debug.html");
const RUN_STATE_KEY = "xinhuoAutoRunStateV1";
// Same MV3 reality as the Lighthouse runner: the worker dies after ~30s
// without extension API traffic during long plaza waits. A 30s alarm keeps
// it alive and, if it died anyway, resumes a safe auto run on the next tick.
const XINHUO_KEEPALIVE_ALARM = "xinhuoAutoRunKeepaliveV1";
const XINHUO_MARKETPLACE_IDLE_REFRESH_MS = 5 * 60 * 1000;
const REPLY_HISTORY_KEY = "xinhuoReplyHistoryRecords";
const MAX_REPLY_HISTORY_RECORDS = 200;
const ATTEMPT_DEDUPE_MS = 3 * 60 * 1000;
const XINHUO_DEFAULT_AI_SYSTEM_PROMPT = "根据原推文写一句自然的中文回复。像真实用户刷到后随手留下的感受，简短、有一点具体反应，不必完整表达观点。10到15个汉字为主，可保留必要的英文词。避免宣传腔、总结腔、夸张吹捧、复述原文和模板化感叹。只输出回复。";

const DEFAULT_SETTINGS = {
  settingsVersion: 4,
  taskPlatform: "xinhuo",
  actionDelayMs: 1200,
  claimTimeoutMs: 60000,
  cooldownPollMs: 500,
  xinhuoMinTaskBounty: 0,
  maxTasksPerRun: 9999,
  maxTaskAttempts: 9999,
  replyMode: "post",
  replyProvider: "native",
  readingSimulationMs: 4000,
  autoSubmitXinhuo: true,
  aiProvider: "openai",
  aiModel: "gpt-5.6-terra",
  aiApiUrl: "",
  aiApiKey: "",
  aiSystemPrompt: XINHUO_DEFAULT_AI_SYSTEM_PROMPT,
  runWindowEnabled: false,
  runWindowStart: "11:00",
  runWindowEnd: "01:00"
};

let sequence = 0;
let runtimeState = createInitialState();
const runtimeStateReady = restoreRuntimeState();
const activeAIRequests = new Set();
let directXinhuoXOpen = null;
let xinhuoMarketplaceTabPromise = null;
let manualDebugCommandTail = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["settings"]);
  const settings = normalizeSettings(stored.settings || {});
  if (JSON.stringify(stored.settings || {}) !== JSON.stringify(settings)) {
    await chrome.storage.local.set({ settings });
  }
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== XINHUO_KEEPALIVE_ALARM) return;
  void handleXinhuoKeepaliveTick();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === runtimeState.xTabId) {
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
    if (runtimeState.pendingXSubmission?.tabId === tabId) {
      runtimeState.pendingXSubmission.tabClosed = true;
      log("info", "X 任务页已在提交后关闭，继续等待薪火订单结果");
    } else {
      log("warn", "目标 X 标签页已关闭");
    }
  }
  if (tabId === runtimeState.xinhuoTabId) runtimeState.xinhuoTabId = null;
});

chrome.tabs.onCreated.addListener((tab) => {
  recordPotentialXinhuoOpenedXTab(tab, true);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && tab.status !== "complete") return;
  recordPotentialXinhuoOpenedXTab(tab || { id: tabId, url: changeInfo.url });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      log("error", error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error), state: runtimeState });
    });
  return true;
});

async function handleMessage(message, sender) {
  await runtimeStateReady;
  const type = message?.type;
  const messageWindowId = getMessageWindowId(message, sender);
  if (isManualDebugCommand(type)) {
    return enqueueManualDebugCommand(message, messageWindowId);
  }
  switch (type) {
    case "GET_STATE":
      return { ok: true, state: runtimeState, settings: await getSettings() };
    case "SAVE_SETTINGS": {
      const currentSettings = await getSettings();
      const settings = normalizeSettings({
        ...(message.settings || {}),
        aiProvider: currentSettings.aiProvider
      });
      await chrome.storage.local.set({ settings });
      log("info", "薪火配置已保存");
      return { ok: true, state: runtimeState, settings };
    }
    case "START_RUN":
      return startXinhuoRun(message.clientWindowId ?? sender?.tab?.windowId ?? null);
    case "STOP_RUN":
      await stopXinhuoRun();
      return { ok: true, state: runtimeState };
    case "CONTENT_LOG":
      if (!message.runId || message.runId === runtimeState.runId) {
        log(message.level || "info", message.text || "", {
          source: "xinhuo",
          page: message.page || null
        });
      }
      return { ok: true };
    case "GENERATE_AI_REPLY":
      if (!message.runId || message.runId !== runtimeState.runId || !runtimeState.running) return { ok: false, error: "旧任务已停止，取消生成" };
      return generateReply(message.tweet, message.task, message.runId);
    case "GET_REPLY_RECORDS":
      return { ok: true, records: await getReplyHistoryRecords() };
    case "CLEAR_REPLY_RECORDS":
      await chrome.storage.local.set({ [REPLY_HISTORY_KEY]: [] });
      log("info", "已清空薪火回复记录");
      return { ok: true, records: [] };
    case "QUERY_TWEET_REPLY_HISTORY":
      return queryTweetReplyHistory(message.tweet, message.task);
    case "OPEN_DEBUG_PAGE":
      return openDebugPage(message.clientWindowId ?? sender?.tab?.windowId ?? null);
    default:
      return { ok: false, error: "未知消息" };
  }
}

function getMessageWindowId(message, sender) {
  const senderWindowId = sender?.tab?.windowId;
  if (Number.isInteger(senderWindowId)) return senderWindowId;
  const clientWindowId = Number(message?.clientWindowId);
  return Number.isInteger(clientWindowId) ? clientWindowId : null;
}

function isManualDebugCommand(type) {
  return [
    "DEBUG_XINHUO_OPEN_TASKS",
    "DEBUG_XINHUO_OPEN_FIRST_TASK",
    "DEBUG_XINHUO_CLAIM_OPEN_X",
    "DEBUG_XINHUO_RUN_X_REPLY",
    "DEBUG_XINHUO_COMPLETE_X_TASK",
    "DEBUG_XINHUO_WAIT_COMPLETION",
    "DEBUG_XINHUO_RETURN_TASKS"
  ].includes(type);
}

function enqueueManualDebugCommand(message, windowId) {
  const operation = manualDebugCommandTail.then(() => runManualDebugCommand(message, windowId));
  manualDebugCommandTail = operation.catch(() => {});
  return operation;
}

async function runManualDebugCommand(message, windowId) {
  const lockResult = lockRuntimeWindowForCommand(windowId, message.type);
  if (!lockResult.ok) return { ok: false, error: lockResult.error, state: runtimeState };
  await prepareDebugRunForCommand(windowId, message.type);

  switch (message.type) {
    case "DEBUG_XINHUO_OPEN_TASKS":
      return debugOpenXinhuoTasks();
    case "DEBUG_XINHUO_OPEN_FIRST_TASK":
      return debugOpenFirstXinhuoTask();
    case "DEBUG_XINHUO_CLAIM_OPEN_X":
      return debugClaimXinhuoTaskAndOpenX();
    case "DEBUG_XINHUO_RUN_X_REPLY":
      return debugRunXinhuoXReply();
    case "DEBUG_XINHUO_COMPLETE_X_TASK":
      return debugCompleteXinhuoXTask();
    case "DEBUG_XINHUO_WAIT_COMPLETION":
      return debugWaitXinhuoCompletionAndReturn();
    case "DEBUG_XINHUO_RETURN_TASKS":
      return debugReturnXinhuoTasks();
    default:
      return { ok: false, error: `未知薪火流程命令：${message.type}`, state: runtimeState };
  }
}

function lockRuntimeWindowForCommand(windowId, commandType) {
  if (!Number.isInteger(windowId)) {
    if (Number.isInteger(runtimeState.windowId)) return { ok: true };
    return { ok: false, error: `缺少窗口归属，拒绝执行 ${commandType}` };
  }
  if (Number.isInteger(runtimeState.windowId) && runtimeState.windowId !== windowId) {
    if (runtimeState.running) {
      return { ok: false, error: `当前薪火流程已锁定 Chrome 窗口 ${runtimeState.windowId}，拒绝接管窗口 ${windowId}` };
    }
    runtimeState.xinhuoTabId = null;
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
  }
  runtimeState.windowId = windowId;
  return { ok: true };
}

async function prepareDebugRunForCommand(windowId, commandType) {
  if (runtimeState.running && runtimeState.mode === "debug") {
    if (Number.isInteger(windowId)) runtimeState.windowId = windowId;
    return;
  }

  const previousMode = runtimeState.mode || "idle";
  if (runtimeState.running) {
    const previousRunId = runtimeState.runId;
    runtimeState.running = false;
    for (const controller of activeAIRequests) controller.abort(new Error("流程控制已接管"));
    clearXinhuoXOpenWatch();
    clearXinhuoXSubmission();
    await clearXinhuoKeepalive();
    const cancellations = [];
    if (runtimeState.xinhuoTabId) cancellations.push(sendToTab(runtimeState.xinhuoTabId, { type: "CANCEL_XINHUO_RUN", runId: previousRunId }));
    if (runtimeState.xTabId) cancellations.push(sendToTab(runtimeState.xTabId, { type: "CANCEL_X_RUN", runId: previousRunId }));
    await Promise.allSettled(cancellations);
  }
  runtimeState.running = true;
  runtimeState.mode = "debug";
  runtimeState.runId = createRunId();
  runtimeState.scheduledResumeAt = 0;
  if (Number.isInteger(windowId)) runtimeState.windowId = windowId;
  setStage("debug_takeover");
  log("info", `流程控制已接管 ${previousMode} 任务：${commandType}`);
}

function failDebugStep(result, fallback) {
  const message = result?.message || result?.error || fallback;
  runtimeState.failed += 1;
  setStage("debug_step_failed");
  log("error", message);
  return { ok: false, error: message, result, state: runtimeState };
}

async function debugOpenXinhuoTasks() {
  const previousRunId = runtimeState.runId;
  const cancellations = [];
  if (runtimeState.xinhuoTabId) cancellations.push(sendToTab(runtimeState.xinhuoTabId, { type: "CANCEL_XINHUO_RUN", runId: previousRunId }));
  if (runtimeState.xTabId) cancellations.push(sendToTab(runtimeState.xTabId, { type: "CANCEL_X_RUN", runId: previousRunId }));
  await Promise.allSettled(cancellations);
  runtimeState.runId = createRunId();
  clearXinhuoXOpenWatch();
  clearXinhuoXSubmission();
  runtimeState.currentTask = null;
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;
  runtimeState.lastXResult = null;
  runtimeState.completionEvidence = null;
  const tab = await ensureXinhuoMarketplaceTab();
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { url: XINHUO_TASKS_URL, active: true });
  await waitForTabComplete(tab.id);
  setStage("xinhuo_tasks_opened");
  log("info", "已打开薪火任务广场并开始检测任务");
  return { ok: true, state: runtimeState };
}

async function debugOpenFirstXinhuoTask() {
  const tab = await getOrCreateXinhuoTab();
  assertXinhuoTab(tab, "打开薪火任务详情前");
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { active: true });
  const settings = await getSettings();
  const result = await sendToTab(tab.id, {
    type: "DEBUG_XINHUO_OPEN_FIRST_TASK",
    runId: runtimeState.runId,
    settings: toContentSettings(settings),
    attemptedTaskKeys: getAttemptedTaskKeys()
  });
  if (!result?.ok || !result.task) return failDebugStep(result, "打开首个薪火可接任务失败");
  runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, result.task);
  setStage("xinhuo_task_detail_opened");
  log("info", result.message || "已打开首个薪火可接任务详情");
  return { ok: true, result, state: runtimeState };
}

async function debugClaimXinhuoTaskAndOpenX() {
  const tab = await getOrCreateXinhuoTab();
  assertXinhuoTab(tab, "接取薪火任务前");
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { active: true });
  beginXinhuoXOpenWatch(tab);
  const settings = await getSettings();
  const result = await sendToTab(tab.id, {
    type: "DEBUG_XINHUO_CLAIM_CURRENT_TASK",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  if (!result?.ok || !result.task) {
    clearXinhuoXOpenWatch();
    return failDebugStep(result, "薪火接单或风险确认失败");
  }
  runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, result.task);
  markAttemptedTask(runtimeState.currentTask);
  const xTab = await getSiteOpenedTargetXTab(runtimeState.currentTask, tab.id);
  if (!xTab) return failDebugStep(result, "薪火已接单，但未能打开当前任务的目标 X");
  await focusXinhuoXTab(xTab.id, xTab.windowId);
  await waitForTabComplete(xTab.id);
  setStage("xinhuo_x_opened");
  log("info", "薪火任务已接取并打开目标 X");
  return { ok: true, result, state: runtimeState };
}

async function debugRunXinhuoXReply() {
  const xTab = await resolveCurrentXinhuoXTab();
  const settings = await getSettings();
  await focusXinhuoXTab(xTab.id, xTab.windowId);
  await waitForTabComplete(xTab.id);
  await delay(Math.max(XINHUO_X_HYDRATION_MS, settings.actionDelayMs * 2));
  const result = await sendToTab(xTab.id, {
    type: "RUN_X_REPLY",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  if (!result?.ok) return failDebugStep(result, "薪火 X 回复步骤失败");
  runtimeState.lastXResult = result;
  await recordReplyHistory(result);
  setStage("xinhuo_x_replied");
  log("info", result.message || "薪火 X 回复已完成");
  return { ok: true, result, state: runtimeState };
}

async function debugCompleteXinhuoXTask() {
  const xTab = await resolveCurrentXinhuoXTab();
  const settings = await getSettings();
  const control = { stopped: false };
  const keeper = maintainXinhuoXForeground(xTab.id, runtimeState.runId, control);
  let result;
  try {
    await delay(XINHUO_FOREGROUND_MS);
    beginXinhuoXSubmission(xTab.id);
    result = await sendToTab(xTab.id, {
      type: "COMPLETE_X_TASK_WIDGET",
      runId: runtimeState.runId,
      task: runtimeState.currentTask,
      settings: toContentSettings(settings)
    });
  } finally {
    control.stopped = true;
    await keeper;
  }
  const closedAfterSubmission = runtimeState.pendingXSubmission?.tabClosed === true;
  if (!result?.ok && !closedAfterSubmission) return failDebugStep(result, "薪火 X 任务组件提交失败");
  setStage("xinhuo_x_task_submitted");
  log("info", closedAfterSubmission ? "X 任务页已关闭，继续核对薪火结果" : (result?.message || "薪火 X 任务已提交"));
  return { ok: true, result, state: runtimeState };
}

async function debugWaitXinhuoCompletionAndReturn() {
  const settings = await getSettings();
  const tab = await getCurrentXinhuoTaskTab();
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.tabs.reload(tab.id);
  await waitForTabComplete(tab.id);
  const initial = await sendToTab(tab.id, {
    type: "XINHUO_WAIT_FOR_SUBMISSION_RESULT",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  const finalResult = await waitForXinhuoFinalVerification(tab.id, runtimeState.runId, settings, initial);
  if (!finalResult?.ok || !finalResult.final) return failDebugStep(finalResult, "薪火尚未确认任务完成");
  if (!latchXinhuoCompletion(finalResult.evidence || buildXinhuoCompletionEvidence(finalResult, runtimeState.runId), runtimeState.runId)
      || !hasLatchedXinhuoCompletion(runtimeState.runId)) {
    return failDebugStep(finalResult, "薪火完成证据与当前任务不一致");
  }
  if (finalResult.success === false || finalResult.state === "failed") {
    runtimeState.failed += 1;
    await chrome.tabs.update(tab.id, { url: XINHUO_TASKS_URL, active: true });
    await waitForTabComplete(tab.id);
    setStage("xinhuo_tasks_returned");
    return { ok: false, error: finalResult.message || "薪火官方核验失败", result: finalResult, state: runtimeState };
  }
  if (!runtimeState.currentTask?.completionCounted) {
    runtimeState.currentTask = { ...runtimeState.currentTask, completionCounted: true };
    runtimeState.completed += 1;
  }
  await chrome.tabs.update(tab.id, { url: XINHUO_TASKS_URL, active: true });
  await waitForTabComplete(tab.id);
  clearCompletedXinhuoTaskState();
  clearXinhuoXSubmission();
  setStage("xinhuo_tasks_returned");
  log("info", finalResult.message || "薪火已确认完成并返回任务广场");
  return { ok: true, result: finalResult, state: runtimeState };
}

async function debugReturnXinhuoTasks() {
  const tab = await getOrCreateXinhuoTab();
  assertXinhuoTab(tab, "返回薪火任务广场前");
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { url: XINHUO_TASKS_URL, active: true });
  await waitForTabComplete(tab.id);
  setStage("xinhuo_tasks_returned");
  log("info", "已返回薪火任务广场");
  return { ok: true, state: runtimeState };
}

async function resolveCurrentXinhuoXTab() {
  const expected = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl);
  if (!expected) throw new Error("当前薪火任务缺少目标 X 链接，请先执行接单开 X");
  const bound = await getBoundMatchingXinhuoXTab(expected);
  if (bound) return bound;
  const query = { url: ["https://x.com/*", "https://twitter.com/*"] };
  if (Number.isInteger(runtimeState.windowId)) query.windowId = runtimeState.windowId;
  const matches = (await chrome.tabs.query(query)).filter((tab) => normalizeTweetUrl(tab.url) === expected);
  const tab = matches.find((candidate) => candidate.active) || matches[0];
  if (!tab) throw new Error("未找到与当前薪火任务精确匹配的 X 标签页");
  runtimeState.xTabId = tab.id;
  runtimeState.xTabWindowId = tab.windowId;
  return tab;
}

async function getCurrentXinhuoTaskTab() {
  const taskPath = normalizeXinhuoTaskPath(runtimeState.currentTask?.detailPath || runtimeState.currentTask?.taskKey);
  if (!taskPath) throw new Error("当前薪火任务缺少详情页身份");
  let tab = await getOrCreateXinhuoTab();
  assertXinhuoTab(tab, "核对薪火任务结果前");
  if (normalizeXinhuoTaskPath(tab.url) !== taskPath) {
    tab = await chrome.tabs.update(tab.id, { url: new URL(taskPath, XINHUO_TASKS_URL).href, active: true });
    await waitForTabComplete(tab.id);
  }
  runtimeState.xinhuoTabId = tab.id;
  return tab;
}

async function startXinhuoRun(windowId) {
  if (runtimeState.running) return { ok: false, error: "薪火自动任务正在运行", state: runtimeState };
  const recoverableTask = getRecoverableInterruptedTask(runtimeState);
  runtimeState = createInitialState();
  runtimeState.running = true;
  runtimeState.mode = "auto";
  runtimeState.runId = createRunId();
  runtimeState.windowId = Number.isInteger(windowId) ? windowId : null;
  const settings = await getSettings();
  const schedule = getScheduleState(settings);
  if (!schedule.inWindow) {
    await enterScheduleWait(schedule);
    return { ok: true, state: runtimeState };
  }
  if (settings.replyMode !== "post" || !settings.autoSubmitXinhuo) {
    runtimeState.running = false;
    setStage("blocked");
    log("error", "薪火全自动需要 X 回复模式=自动发送，并开启自动提交任务");
    return { ok: false, error: "请先开启自动发送和自动提交任务", state: runtimeState };
  }
  if (!settings.aiApiKey) {
    runtimeState.running = false;
    setStage("blocked");
    log("error", "AI API Key 为空，未接取任何薪火任务");
    return { ok: false, error: "请先在侧栏填写 AI API Key", state: runtimeState };
  }
  // Armed only once every preflight check has passed; a blocked start must
  // not leave a keepalive alarm ticking.
  await ensureXinhuoKeepalive();
  setStage("starting");
  log("info", "薪火自动接单已启动：只接当前等级可做的评论、点赞、评论+点赞任务");
  const recovered = await findRecoverableClaimedXinhuoTask(recoverableTask);
  if (recovered) {
    runtimeState.xinhuoTabId = recovered.tab.id;
    runtimeState.currentTask = recovered.task;
    setStage("resuming_claimed_task");
    log("warn", `检测到与中断记录完全匹配的薪火订单，继续处理：${recovered.task.detailPath}`);
    return runNextXinhuoTask("resume_interrupted_claim", {
      resumeTask: recovered.task,
      resumeTabId: recovered.tab.id
    });
  }
  return runNextXinhuoTask("start");
}

async function runNextXinhuoTask(reason, options = {}) {
  const runId = runtimeState.runId;
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return stopWithFailure("AI API Key 为空，已停止扫描，未接取任何薪火任务", "config_missing");
  }
  if (isLimitReached(runtimeState.completed, settings.maxTasksPerRun)) return finishRun("达到任务上限，运行结束");
  if (isLimitReached(runtimeState.attempts, settings.maxTaskAttempts)) return finishRun("达到接单尝试上限，运行结束");

  let xinhuoTab;
  let result;
  const resumingClaimedTask = Boolean(options.resumeTask && Number.isInteger(options.resumeTabId));
  if (resumingClaimedTask) {
    xinhuoTab = await chrome.tabs.get(options.resumeTabId);
    assertXinhuoTab(xinhuoTab, "恢复薪火已接订单前");
    runtimeState.xinhuoTabId = xinhuoTab.id;
    runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, options.resumeTask);
    beginXinhuoXOpenWatch(xinhuoTab);
    result = { ok: true, task: runtimeState.currentTask };
  } else {
    xinhuoTab = await ensureXinhuoMarketplaceTab();
    assertXinhuoTab(xinhuoTab, "扫描薪火任务前");
    runtimeState.xinhuoTabId = xinhuoTab.id;
    // A browser may already have an unrelated task-detail tab open. Starting
    // an automatic run must begin from the marketplace unless an interrupted
    // claimed order was matched by both its saved path and target tweet URL.
    const marketplaceReady = options.marketplaceReady && isXinhuoMarketplaceUrl(xinhuoTab.url);
    if (!marketplaceReady) {
      log("info", `正在打开薪火任务广场：tab=${xinhuoTab.id}`);
      await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
      await waitForTabComplete(xinhuoTab.id);
    }
    setStage("selecting_task");
    log("info", `检测薪火可接任务：${reason} · tab=${xinhuoTab.id} · ${XINHUO_TASKS_URL}`);
    // Xinhuo can open X before the task-page script returns its claim result.
    // Begin listening first so that fast site navigation is not missed.
    beginXinhuoXOpenWatch(xinhuoTab);
    result = await sendToTab(xinhuoTab.id, {
      type: "XINHUO_SELECT_AND_CLAIM",
      runId,
      settings: toContentSettings(settings),
      attemptedTaskKeys: getAttemptedTaskKeys()
    });
  }
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  if (!result?.ok || !result.task) {
    clearXinhuoXOpenWatch();
    if (result?.task?.claimed) runtimeState.currentTask = result.task;
    if (result?.retryable && result?.returnToMarketplace) {
      runtimeState.attempts += 1;
      if (result.task) markAttemptedTask(result.task);
      runtimeState.currentTask = null;
      runtimeState.xTabId = null;
      setStage("claim_not_acquired");
      log("warn", `${result.message || "薪火未接到任务"}，返回任务广场继续扫描下一单`);
      await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
      await waitForTabComplete(xinhuoTab.id);
      return runNextXinhuoTask("claim_not_acquired", { marketplaceReady: true });
    }
    return stopWithFailure(result?.message || "薪火接取任务失败，已停留在当前页面", "claim_failed");
  }

  if (!resumingClaimedTask) runtimeState.attempts += 1;
  runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, result.task);
  markAttemptedTask(result.task);
  if (resumingClaimedTask && result.task?.officialState) {
    setStage("waiting_verification_result");
    log("info", "恢复的薪火订单已存在官网提交状态，直接核对官方最终结果，不重复回复或提交");
    const initial = confirmationFromRecoveredTask(result.task, runId);
    const finalConfirmation = await waitForXinhuoFinalVerification(xinhuoTab.id, runId, settings, initial);
    return finishXinhuoOfficialResult(xinhuoTab, runId, settings, finalConfirmation);
  }
  // Xinhuo opens the target post itself after the task has been accepted and
  // its risk reminder confirmed. Reuse that tab first so we do not duplicate
  // the site's navigation; open a fallback only when the site did not do so.
  const xTab = await getSiteOpenedTargetXTab(result.task, xinhuoTab.id);
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  if (!xTab) return stopWithFailure("薪火任务已接取，但详情页没有有效的 X 推文链接", "x_open_failed");

  setStage("replying");
  await focusXinhuoXTab(xTab.id);
  await waitForTabComplete(xTab.id);
  log("info", "X 推文页已打开，等待页面加载和任务组件初始化");
  await delay(Math.max(XINHUO_X_HYDRATION_MS, settings.actionDelayMs * 2));
  const reply = await sendToTab(xTab.id, { type: "RUN_X_REPLY", runId, task: result.task, settings: toContentSettings(settings) });
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  if (!reply?.ok) return stopWithFailure(reply?.message || "X 回复失败，已保留当前页面", "reply_failed");
  runtimeState.lastXResult = reply;
  await recordReplyHistory(reply);

  setStage("foreground_wait");
  log("info", "X 回复完成，持续保持目标页在前台，等待官方组件累计有效停留时间");
  const foregroundControl = { stopped: false };
  const foregroundKeeper = maintainXinhuoXForeground(xTab.id, runId, foregroundControl);
  let submit = null;
  try {
    await delay(XINHUO_FOREGROUND_MS);
    if (!isActiveRun(runId)) return { ok: false, state: runtimeState };

    setStage("submitting_x_task");
    log("info", "正在 X 任务组件提交任务");
    beginXinhuoXSubmission(xTab.id);
    submit = await sendToTab(xTab.id, { type: "COMPLETE_X_TASK_WIDGET", runId, settings: toContentSettings(settings) });
  } finally {
    foregroundControl.stopped = true;
    await foregroundKeeper;
  }
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  const xClosedAfterSubmission = runtimeState.pendingXSubmission?.tabClosed === true;
  if (!submit?.ok && !xClosedAfterSubmission) {
    log("warn", `${submit?.message || "X 任务组件未确认提交"}；先回当前薪火订单读取官方结果，再决定是否失败`);
  } else {
    log("info", xClosedAfterSubmission
      ? "X 任务页已关闭，等待薪火确认是否提交成功"
      : (submit?.message || "已点击 X 任务组件的提交任务按钮，等待薪火确认"));
  }

  setStage("waiting_verification_result");
  log("info", "正在回到当前薪火订单详情，只读核对结果，不重复使用 X API 补验");
  await delay(Math.max(1500, settings.actionDelayMs));
  await chrome.tabs.reload(xinhuoTab.id);
  await waitForTabComplete(xinhuoTab.id);
  await chrome.tabs.update(xinhuoTab.id, { active: true });
  const confirmation = await sendToTab(xinhuoTab.id, {
    type: "XINHUO_WAIT_FOR_SUBMISSION_RESULT",
    runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  if (!submit?.ok && !xClosedAfterSubmission && !submit?.submissionAttempted && !confirmation?.ok) {
    return stopWithFailure(
      confirmation?.message || submit?.message || "X 组件和薪火官网均未确认任务提交，已保留当前订单",
      "submit_failed"
    );
  }
  const finalConfirmation = await waitForXinhuoFinalVerification(xinhuoTab.id, runId, settings, confirmation);
  return finishXinhuoOfficialResult(xinhuoTab, runId, settings, finalConfirmation);
}

async function waitForXinhuoFinalVerification(tabId, runId, settings, initial = null) {
  let latest = initial;
  let lastLogAt = 0;
  const startedAt = Date.now();
  const maxWaitMs = 30 * 60 * 1000;
  // 15s reloads are fine while the result is expected any moment; after two
  // minutes the wait is long-haul, so back off to once a minute.
  const pollIntervalMs = () => (Date.now() - startedAt >= 120000 ? 60000 : XINHUO_VERIFICATION_POLL_MS);
  while (isActiveRun(runId)) {
    if (!isActiveRun(runId)) return { ok: false, message: "薪火流程已停止" };
    if (latest?.ok && latest.final) {
      latchXinhuoCompletion(latest.evidence || buildXinhuoCompletionEvidence(latest, runId), runId);
      return latest;
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      log("error", "薪火官方核验等待超过 30 分钟仍未出终态，已停止扫描并保留订单，请人工核对官方结果");
      return { ok: false, message: "薪火官方核验等待超时（30 分钟），已保留订单停止扫描" };
    }
    const intervalMs = pollIntervalMs();
    if (Date.now() - lastLogAt >= intervalMs) {
      lastLogAt = Date.now();
      log("info", latest?.message
        ? `${latest.message}，保留当前订单，等待薪火官方最终核验`
        : "等待薪火官方最终核验，当前订单保持进行中");
    }
    await delay(intervalMs);
    if (!isActiveRun(runId)) return { ok: false, message: "薪火流程已停止" };
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    latest = await sendToTab(tabId, {
      type: "XINHUO_WAIT_FOR_SUBMISSION_RESULT",
      runId,
      task: runtimeState.currentTask,
      settings: toContentSettings(settings)
    });
    if (!latest?.ok) {
      log("warn", latest?.message || "薪火订单状态暂不可读，将继续低频复核");
    }
  }
  return {
    ok: false,
    message: latest?.message || "薪火流程已停止"
  };
}

async function finishXinhuoOfficialResult(xinhuoTab, runId, settings, finalConfirmation) {
  if (!finalConfirmation?.ok || !finalConfirmation.final) {
    return stopWithFailure(finalConfirmation?.message || "薪火订单仍未获得官方核验结果，已保留订单详情", "verification_pending");
  }
  if (!latchXinhuoCompletion(finalConfirmation.evidence || buildXinhuoCompletionEvidence(finalConfirmation, runId), runId)
      || !hasLatchedXinhuoCompletion(runId)) {
    return stopWithFailure("薪火返回了终态，但证据与当前订单身份不一致，已保留订单详情", "verification_identity_mismatch");
  }
  clearXinhuoXSubmission();
  if (finalConfirmation.success === false || finalConfirmation.state === "failed") {
    runtimeState.failed += 1;
    setStage("verification_failed");
    log("warn", finalConfirmation.message || "薪火官方确认本单核验失败，返回任务广场继续扫描");
    clearCompletedXinhuoTaskState();
    await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
    await waitForTabComplete(xinhuoTab.id);
    return runNextXinhuoTask("after_verification_failed", { marketplaceReady: true });
  }
  if (runtimeState.currentTask?.completionCounted) {
    return { ok: true, duplicate: true, state: runtimeState };
  }
  runtimeState.currentTask = { ...runtimeState.currentTask, completionCounted: true };
  runtimeState.completed += 1;
  // Completed orders are excluded by their own detail state; drop them from
  // the dedupe table so the next scan does not treat the plaza as stale.
  releaseXinhuoAttemptedTask(runtimeState.currentTask);
  setStage("submitted");
  log("info", finalConfirmation.message || "薪火已确认任务完成");
  await delay(Math.max(1000, settings.actionDelayMs));
  log("info", "本单已完成，正在返回薪火任务广场继续检测下一单");
  await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
  await waitForTabComplete(xinhuoTab.id);
  clearCompletedXinhuoTaskState();
  return runNextXinhuoTask("after_submit", { marketplaceReady: true });
}

function clearCompletedXinhuoTaskState() {
  runtimeState.currentTask = null;
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;
  runtimeState.lastXResult = null;
  runtimeState.completionEvidence = null;
}

async function maintainXinhuoXForeground(tabId, runId, control = {}) {
  while (!control.stopped && isActiveRun(runId)) {
    try {
      await focusXinhuoXTab(tabId);
    } catch (error) {
      if (runtimeState.pendingXSubmission?.tabClosed) return;
      log("warn", `保持薪火目标 X 前台失败：${error.message || String(error)}`);
      return;
    }
    await delay(XINHUO_FOREGROUND_REFOCUS_MS);
  }
}

async function stopXinhuoRun() {
  for (const controller of activeAIRequests) controller.abort(new Error("任务已停止"));
  const runId = runtimeState.runId;
  runtimeState.running = false;
  clearXinhuoXOpenWatch();
  clearXinhuoXSubmission();
  await clearXinhuoKeepalive();
  if (runtimeState.xinhuoTabId) await sendToTab(runtimeState.xinhuoTabId, { type: "CANCEL_XINHUO_RUN", runId });
  if (runtimeState.xTabId) await sendToTab(runtimeState.xTabId, { type: "CANCEL_X_RUN", runId });
  runtimeState.runId = createRunId();
  runtimeState.scheduledResumeAt = 0;
  setStage("stopped");
  log("warn", "已停止薪火自动任务");
}

async function stopWithFailure(message, stage) {
  if (runtimeState.running && runtimeState.mode === "auto") {
    return recoverXinhuoRun(message, stage);
  }
  runtimeState.running = false;
  clearXinhuoXOpenWatch();
  clearXinhuoXSubmission();
  runtimeState.failed += 1;
  setStage(stage);
  log("error", message);
  return { ok: false, error: message, state: runtimeState };
}

async function recoverXinhuoRun(message, failedStage = "recovering") {
  const runId = runtimeState.runId;
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };

  runtimeState.failed += 1;
  if (runtimeState.currentTask) markAttemptedTask(runtimeState.currentTask);
  if (runtimeState.currentTask?.claimed) {
    clearXinhuoXOpenWatch();
    clearXinhuoXSubmission();
    runtimeState.running = false;
    setStage("claimed_task_recovery_blocked");
    log("error", `${message || "已接取薪火订单后续步骤异常"}；已保留当前订单，停止扫描新任务以避免串单`);
    return { ok: false, error: message || "已接取薪火订单后续步骤异常", state: runtimeState };
  }
  clearXinhuoXOpenWatch();
  clearXinhuoXSubmission();
  setStage("recovering");
  log("warn", `${message || "当前任务异常"}，已退出本单并返回任务广场继续扫描`);

  try {
    const xinhuoTab = await getOrCreateXinhuoTab();
    runtimeState.xinhuoTabId = xinhuoTab.id;
    runtimeState.currentTask = null;
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
    runtimeState.lastXResult = null;
    await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
    await waitForTabComplete(xinhuoTab.id);
    if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
    return runNextXinhuoTask(`recover_after_${failedStage}`, { marketplaceReady: true });
  } catch (error) {
    setStage("recovery_waiting");
    log("warn", `返回薪火任务广场失败，已停止当前运行：${error.message || String(error)}`);
    runtimeState.running = false;
    return { ok: false, error: error.message || String(error), state: runtimeState };
  }
}

function finishRun(message) {
  runtimeState.running = false;
  clearXinhuoXOpenWatch();
  clearXinhuoXSubmission();
  setStage("finished");
  log("info", message);
  return { ok: true, state: runtimeState };
}

async function generateReply(tweet, task, runId = runtimeState.runId) {
  const controller = new AbortController();
  activeAIRequests.add(controller);
  try {
  const settings = await getSettings();
  const result = await generateLighthouseAIReply({
    provider: settings.aiProvider,
    model: settings.aiModel,
    apiUrl: settings.aiApiUrl,
    apiKey: settings.aiApiKey,
    systemPrompt: settings.aiSystemPrompt
  }, {
    ...(tweet || {}),
    url: tweet?.url || task?.tweetUrl || ""
  }, { minChineseChars: Number(task?.minReplyChineseChars) || 10, signal: controller.signal, timeout: 60000 });
  if (controller.signal.aborted || runId !== runtimeState.runId || !runtimeState.running) throw new Error("任务已停止，丢弃 AI 结果");
  if (result.fallback) {
    logReplyDiagnostics(result.diagnostics);
    log("warn", `AI 不可用，使用薪火兜底回复：${result.replyText}`);
  } else {
    if ((result.diagnostics || []).length) logReplyDiagnostics(result.diagnostics);
    log("info", `已生成薪火回复：${result.replyText}`);
  }
  return { ok: true, ...result };
  } finally {
    activeAIRequests.delete(controller);
  }
}

// The reply engine already returns per-round diagnostics (raw text, cleaned
// text, failure reason); dropping them made AI retry storms invisible.
function logReplyDiagnostics(diagnostics = []) {
  const items = Array.isArray(diagnostics) ? diagnostics : [];
  if (!items.length) {
    log("warn", "AI失败详情：未收到诊断信息");
    return;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] || {};
    log(item.ok ? "info" : "warn", formatReplyDiagnosticLogLine(item));
  }
}

function formatReplyDiagnosticLogLine(item) {
  const raw = item.raw || "<空>";
  const normalized = item.normalized || "<空>";
  const reasonText = item.reasonText || item.reason || "未知原因";
  const countText = Number.isFinite(item.charCount) ? `，中文字数=${item.charCount}` : "";
  const prefix = item.ok ? "AI生成通过" : "AI生成失败";
  return `${prefix} ${item.stage || "未知轮次"}：生成「${raw}」，清洗后「${normalized}」${countText}，原因：${reasonText}`;
}

function getRecoverableInterruptedTask(state) {
  const recoverableStages = new Set(["interrupted_not_resumed", "claimed_task_recovery_blocked", "verification_pending"]);
  const task = recoverableStages.has(state?.stage) ? state.currentTask : null;
  const detailPath = normalizeXinhuoTaskPath(task?.detailPath || task?.taskKey);
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  if (!task?.claimed || !detailPath || !tweetUrl) return null;
  return { ...task, taskKey: detailPath, detailPath, tweetUrl };
}

async function findRecoverableClaimedXinhuoTask(savedTask) {
  if (!savedTask) return null;
  const query = {};
  if (Number.isInteger(runtimeState.windowId)) query.windowId = runtimeState.windowId;
  const tabs = (await chrome.tabs.query(query)).filter((tab) => {
    return normalizeXinhuoTaskPath(tab.url) === savedTask.detailPath;
  });
  for (const tab of tabs) {
    const inspected = await sendToTab(tab.id, {
      type: "XINHUO_INSPECT_CURRENT_TASK",
      runId: runtimeState.runId,
      task: savedTask
    });
    const inspectedTask = inspected?.task;
    if (!inspected?.ok || !inspectedTask?.claimed) continue;
    if (normalizeXinhuoTaskPath(inspectedTask.detailPath || inspectedTask.taskKey) !== savedTask.detailPath) continue;
    if (normalizeTweetUrl(inspectedTask.tweetUrl) !== savedTask.tweetUrl) continue;
    return { tab, task: mergeXinhuoTask(savedTask, inspectedTask) };
  }
  return null;
}

function confirmationFromRecoveredTask(task, runId) {
  const state = task?.officialState || {};
  const confirmation = {
    ok: true,
    state: state.kind || "pending",
    final: Boolean(state.final),
    success: state.success,
    message: state.message || "薪火已读取到中断订单的官方状态"
  };
  return { ...confirmation, evidence: buildXinhuoCompletionEvidence(confirmation, runId, task) };
}

function buildXinhuoCompletionEvidence(confirmation, runId, task = runtimeState.currentTask) {
  return {
    platform: "xinhuo",
    runId,
    taskKey: getXinhuoTaskIdentity(task),
    detailPath: normalizeXinhuoTaskPath(task?.detailPath || task?.taskKey),
    tweetUrl: normalizeTweetUrl(task?.tweetUrl),
    state: confirmation?.state || "",
    success: confirmation?.success !== false && confirmation?.state !== "failed",
    message: String(confirmation?.message || ""),
    observedAt: new Date().toISOString()
  };
}

function latchXinhuoCompletion(evidence, runId) {
  if (!evidence || runId !== runtimeState.runId || !runtimeState.running || evidence.runId !== runId) return false;
  const expectedTaskKey = getXinhuoTaskIdentity(runtimeState.currentTask);
  const evidenceTaskKey = String(evidence.taskKey || normalizeXinhuoTaskPath(evidence.detailPath)).trim();
  if (!expectedTaskKey || evidenceTaskKey !== expectedTaskKey) return false;
  const expectedUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl);
  if (!expectedUrl || normalizeTweetUrl(evidence.tweetUrl) !== expectedUrl) return false;
  runtimeState.completionEvidence = { ...evidence };
  touchRunState();
  return true;
}

function hasLatchedXinhuoCompletion(runId) {
  const evidence = runtimeState.completionEvidence;
  return Boolean(evidence
    && evidence.runId === runId
    && evidence.taskKey === getXinhuoTaskIdentity(runtimeState.currentTask)
    && normalizeTweetUrl(evidence.tweetUrl) === normalizeTweetUrl(runtimeState.currentTask?.tweetUrl));
}

async function getOrCreateXinhuoTab() {
  let remembered = null;
  if (Number.isInteger(runtimeState.xinhuoTabId)) {
    try {
      const candidate = await chrome.tabs.get(runtimeState.xinhuoTabId);
      const runtimeWindowId = Number.isInteger(runtimeState.windowId) ? runtimeState.windowId : null;
      if (isXinhuoUrl(candidate.url) && (!runtimeWindowId || candidate.windowId === runtimeWindowId)) {
        remembered = candidate;
      } else {
        log("warn", `丢弃非薪火的残留任务标签（非当前窗口或地址不匹配）：tab=${candidate.id} · ${candidate.url || "about:blank"}`);
      }
    } catch (_) {
      // The remembered tab may have been closed while the service worker slept.
    }
    if (!remembered) runtimeState.xinhuoTabId = null;
  }

  const query = {};
  if (Number.isInteger(runtimeState.windowId)) query.windowId = runtimeState.windowId;
  else if (Number.isInteger(remembered?.windowId)) query.windowId = remembered.windowId;
  const queriedTabs = (await chrome.tabs.query(query)).filter((tab) => isXinhuoUrl(tab.url));
  const scopeWindowId = Number.isInteger(runtimeState.windowId)
    ? runtimeState.windowId
    : (Number.isInteger(remembered?.windowId)
      ? remembered.windowId
      : (queriedTabs.find((tab) => isXinhuoMarketplaceUrl(tab.url))?.windowId
        ?? queriedTabs.find((tab) => isXinhuoUrl(tab.url))?.windowId));
  const tabs = Number.isInteger(scopeWindowId)
    ? queriedTabs.filter((tab) => tab.windowId === scopeWindowId)
    : queriedTabs;
  const marketplaceTabs = tabs.filter((tab) => isXinhuoMarketplaceUrl(tab.url));
  const marketplaceKeeper = remembered && isXinhuoMarketplaceUrl(remembered.url)
    ? remembered
    : marketplaceTabs[0];
  const existing = remembered || marketplaceKeeper || tabs.find((tab) => isXinhuoUrl(tab.url));
  if (marketplaceKeeper && marketplaceTabs.length > 1) {
    await Promise.all(marketplaceTabs.filter((tab) => tab.id !== marketplaceKeeper.id && Number.isInteger(tab.id)).map((tab) => (
      chrome.tabs.remove(tab.id).catch((error) => {
        log("warn", `清理重复薪火任务广场标签失败：tab=${tab.id} · ${error.message || String(error)}`);
      })
    )));
  }
  if (existing) {
    runtimeState.xinhuoTabId = existing.id;
    return existing;
  }
  const properties = { url: XINHUO_TASKS_URL, active: true };
  if (Number.isInteger(runtimeState.windowId)) properties.windowId = runtimeState.windowId;
  return chrome.tabs.create(properties);
}

async function ensureXinhuoMarketplaceTab() {
  if (xinhuoMarketplaceTabPromise) return xinhuoMarketplaceTabPromise;
  xinhuoMarketplaceTabPromise = ensureXinhuoMarketplaceTabOnce();
  try {
    return await xinhuoMarketplaceTabPromise;
  } finally {
    xinhuoMarketplaceTabPromise = null;
  }
}

async function ensureXinhuoMarketplaceTabOnce() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tab = await getOrCreateXinhuoTab();
    if (tab?.id && isXinhuoUrl(tab.url)) return tab;
    log("warn", `薪火标签尚未就绪，第 ${attempt}/3 次重新获取：tab=${tab?.id || "missing"} · ${tab?.url || ""}`);
    await delay(300 * attempt);
  }
  throw new Error("薪火任务广场标签未就绪，未开始接单");
}

async function getSiteOpenedTargetXTab(task, openerTabId) {
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  if (!tweetUrl) return null;
  const runId = runtimeState.runId;
  const boundTab = await getBoundMatchingXinhuoXTab(tweetUrl);
  if (boundTab) return boundTab;
  if (runtimeState.pendingXOpen) runtimeState.pendingXOpen.claimStartedAt = Number(task.claimStartedAt) || Date.now();
  log("info", "等待薪火网站自动打开任务目标 X");
  const deadline = Date.now() + XINHUO_SITE_X_OPEN_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isActiveRun(runId)) return null;
    const siteOpenedTab = consumeXinhuoOpenedXTab(tweetUrl) || await findTargetXTab(tweetUrl, openerTabId);
    if (siteOpenedTab) {
      clearXinhuoXOpenWatch();
      runtimeState.xTabId = siteOpenedTab.id;
      runtimeState.xTabWindowId = siteOpenedTab.windowId;
      runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, task, { tweetUrl, xOpenSource: "site" });
      log("info", `检测到薪火网站已打开任务目标 X：${tweetUrl}`);
      return siteOpenedTab;
    }
    await delay(300);
  }

  log("warn", "薪火网站未自动打开目标 X，扩展将补开任务页面");
  if (!isActiveRun(runId)) return null;
  return openXinhuoFallbackXTab(task, openerTabId, runId);
}

async function openXinhuoFallbackXTab(task, openerTabId, runId) {
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  const taskKey = getXinhuoTaskIdentity(task) || tweetUrl;
  if (!tweetUrl || !taskKey) return null;
  const bound = await getBoundMatchingXinhuoXTab(tweetUrl);
  if (bound) return bound;
  if (directXinhuoXOpen?.taskKey === taskKey) return directXinhuoXOpen.promise;
  if (directXinhuoXOpen) {
    await directXinhuoXOpen.promise.catch(() => null);
    const rebound = await getBoundMatchingXinhuoXTab(tweetUrl);
    if (rebound) return rebound;
  }

  const opening = (async () => {
    const rebound = await getBoundMatchingXinhuoXTab(tweetUrl);
    if (rebound) return rebound;
    if (!isActiveRun(runId) || getXinhuoTaskIdentity(runtimeState.currentTask) !== taskKey) return null;
    const siteOpenedTab = consumeXinhuoOpenedXTab(tweetUrl) || await findTargetXTab(tweetUrl, openerTabId);
    if (siteOpenedTab) {
      runtimeState.xTabId = siteOpenedTab.id;
      runtimeState.xTabWindowId = siteOpenedTab.windowId;
      runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, task, { tweetUrl, xOpenSource: "site" });
      return siteOpenedTab;
    }
    clearXinhuoXOpenWatch();
    const properties = { url: tweetUrl, active: true, openerTabId };
    if (Number.isInteger(runtimeState.windowId)) properties.windowId = runtimeState.windowId;
    const tab = await chrome.tabs.create(properties);
    await focusXinhuoXTab(tab.id, tab.windowId);
    runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, task, {
      tweetUrl,
      xOpenSource: "extension_fallback"
    });
    log("info", `已打开薪火任务目标 X：${tweetUrl}`);
    return tab;
  })();
  directXinhuoXOpen = { taskKey, promise: opening };
  try {
    return await opening;
  } finally {
    if (directXinhuoXOpen?.promise === opening) directXinhuoXOpen = null;
  }
}

async function getBoundMatchingXinhuoXTab(expectedTweetUrl = "") {
  if (!Number.isInteger(runtimeState.xTabId)) return null;
  try {
    const tab = await chrome.tabs.get(runtimeState.xTabId);
    const expected = normalizeTweetUrl(expectedTweetUrl || runtimeState.currentTask?.tweetUrl);
    const actual = normalizeTweetUrl(tab?.url);
    if (!actual || (expected && actual !== expected)
        || (Number.isInteger(runtimeState.windowId) && tab.windowId !== runtimeState.windowId)) {
      runtimeState.xTabId = null;
      runtimeState.xTabWindowId = null;
      return null;
    }
    runtimeState.xTabWindowId = tab.windowId;
    return tab;
  } catch (_) {
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
    return null;
  }
}

async function findTargetXTab(tweetUrl, openerTabId) {
  const target = normalizeTweetUrl(tweetUrl);
  if (!target) return null;
  const query = { url: ["https://x.com/*", "https://twitter.com/*"] };
  if (Number.isInteger(runtimeState.windowId)) query.windowId = runtimeState.windowId;
  const pending = runtimeState.pendingXOpen;
  const matches = (await chrome.tabs.query(query))
    .filter((tab) => tab.id !== openerTabId && normalizeTweetUrl(tab.url) === target);
  if (!matches.length) return null;
  return matches
    .filter((tab) => {
      return tab.openerTabId === openerTabId
        && Number(pending?.createdAt?.[tab.id] || 0) >= Number(pending?.claimStartedAt || Infinity);
    })
    .sort((left, right) => {
      const leftOpenedByXinhuo = left.openerTabId === openerTabId ? 1 : 0;
      const rightOpenedByXinhuo = right.openerTabId === openerTabId ? 1 : 0;
      return rightOpenedByXinhuo - leftOpenedByXinhuo || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
    })[0] || null;
}

function beginXinhuoXOpenWatch(xinhuoTab) {
  runtimeState.pendingXOpen = {
    xinhuoTabId: xinhuoTab?.id || runtimeState.xinhuoTabId || null,
    windowId: xinhuoTab?.windowId ?? runtimeState.windowId ?? null,
    startedAt: Date.now(),
    createdTabIds: [],
    createdAt: {},
    candidates: []
  };
}

function clearXinhuoXOpenWatch() {
  runtimeState.pendingXOpen = null;
}

function beginXinhuoXSubmission(tabId) {
  runtimeState.pendingXSubmission = { tabId, startedAt: Date.now(), tabClosed: false };
}

function clearXinhuoXSubmission() {
  runtimeState.pendingXSubmission = null;
}

function recordPotentialXinhuoOpenedXTab(tab, created = false) {
  const pending = runtimeState.pendingXOpen;
  if (!pending || !tab?.id) return;
  if (Number.isInteger(pending.windowId) && tab.windowId !== pending.windowId) return;

  if (created) {
    pending.createdTabIds.push(tab.id);
    pending.createdAt[tab.id] = Date.now();
  }
  if (tab.openerTabId !== pending.xinhuoTabId || !pending.createdTabIds.includes(tab.id)) return;
  if (!normalizeTweetUrl(tab.url)) return;
  if (!pending.candidates.some((candidate) => candidate.id === tab.id && candidate.url === tab.url)) {
    pending.candidates.push(tab);
  }
}

function consumeXinhuoOpenedXTab(tweetUrl) {
  const pending = runtimeState.pendingXOpen;
  if (!pending) return null;
  const target = normalizeTweetUrl(tweetUrl);
  const index = pending.candidates.findIndex((candidate) => normalizeTweetUrl(candidate.url) === target
    && Number(pending.createdAt?.[candidate.id] || 0) >= Number(pending.claimStartedAt || Infinity));
  if (index < 0) return null;
  const [candidate] = pending.candidates.splice(index, 1);
  clearXinhuoXOpenWatch();
  return candidate;
}

async function sendToTab(tabId, payload) {
  payload = { ...payload, platform: "xinhuo", task: payload.task || runtimeState.currentTask };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (payload.runId && !payload.type.startsWith("CANCEL_") &&
        (payload.runId !== runtimeState.runId || !runtimeState.running)) {
      return { ok: false, cancelled: true, message: "流程已停止，不再重试旧消息" };
    }
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      if (runtimeState.pendingXSubmission?.tabId === tabId && runtimeState.pendingXSubmission?.tabClosed) {
        return { ok: false, tabClosedAfterSubmission: true };
      }
      if (isMissingReceiver(error)) {
        const injected = await injectContentScript(tabId);
        if (injected) await delay(300);
      }
      if (attempt === 7) {
        log("error", `页面通信失败：${error.message || String(error)}`);
        return null;
      }
      await delay(500);
    }
  }
  return null;
}

async function injectContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const file = /^https:\/\/xinhuo123\.com\//i.test(tab.url || "")
      ? "src/content/xinhuo.js"
      : (/^https:\/\/(?:x|twitter)\.com\//i.test(tab.url || "") ? "src/content/x.js" : "");
    if (!file) return false;
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    log("warn", `已为标签页补注入脚本：${file}（tab=${tabId}）`);
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForTabComplete(tabId) {
  for (let index = 0; index < 40; index += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return true;
    await delay(250);
  }
  return false;
}

function isActiveRun(runId) {
  return Boolean(runtimeState.running && runtimeState.mode === "auto" && runtimeState.runId === runId);
}

function getAttemptedTaskKeys() {
  const now = Date.now();
  runtimeState.attemptedTasks = (runtimeState.attemptedTasks || []).filter((item) => item.expiresAt > now);
  return runtimeState.attemptedTasks.map((item) => item.key);
}

function releaseXinhuoAttemptedTask(task) {
  const keys = getXinhuoTaskDedupeKeys(task);
  if (!keys.length || !Array.isArray(runtimeState.attemptedTasks)) return;
  const released = new Set(keys);
  runtimeState.attemptedTasks = runtimeState.attemptedTasks.filter((item) => !released.has(item.key));
}

function markAttemptedTask(task) {
  const keys = getXinhuoTaskDedupeKeys(task);
  if (!keys.length) return;
  const existing = new Set((runtimeState.attemptedTasks || []).map((item) => item.key));
  const fresh = keys.filter((key) => !existing.has(key));
  const expiresAt = Date.now() + ATTEMPT_DEDUPE_MS;
  runtimeState.attemptedTasks = [
    ...(runtimeState.attemptedTasks || []).filter((item) => item.expiresAt > Date.now() && !keys.includes(item.key)),
    ...keys.map((key) => ({ key, expiresAt }))
  ].slice(-100);
  // Without this line a deduped task silently disappears from selection and
  // the log only shows an unexplained "暂无可立即接取".
  if (fresh.length) log("info", `已登记去重 ${Math.round(ATTEMPT_DEDUPE_MS / 60000)} 分钟：${describeXinhuoTaskForLog(task)}`);
}

function describeXinhuoTaskForLog(task = {}) {
  const bounty = Number(task.bounty || 0);
  return [
    bounty > 0 ? `${bounty.toFixed(3)}KX` : "",
    task.handle || "",
    task.candidateTitle || task.title || getXinhuoTaskIdentity(task) || ""
  ].filter(Boolean).join(" · ") || "当前任务";
}

function getXinhuoTaskDedupeKeys(task) {
  return Array.from(new Set([
    getXinhuoTaskIdentity(task),
    normalizeTweetUrl(task?.tweetUrl)
  ].filter(Boolean)));
}

async function getReplyHistoryRecords() {
  const stored = await chrome.storage.local.get([REPLY_HISTORY_KEY]);
  return (Array.isArray(stored[REPLY_HISTORY_KEY]) ? stored[REPLY_HISTORY_KEY] : [])
    .map(normalizeXinhuoReplyRecord)
    .filter(Boolean)
    .slice(0, MAX_REPLY_HISTORY_RECORDS);
}

async function queryTweetReplyHistory(tweet, task) {
  const tweetUrl = normalizeTweetUrl(tweet?.url || task?.tweetUrl || "");
  const taskKey = getXinhuoTaskIdentity(task);
  if (!tweetUrl && !taskKey) return { ok: true, replied: false };
  const record = (await getReplyHistoryRecords()).find((item) => {
    return (tweetUrl && normalizeTweetUrl(item.tweetUrl) === tweetUrl)
      || (taskKey && getXinhuoTaskIdentity(item) === taskKey);
  });
  return record ? { ok: true, replied: true, source: "local_reply_history", record, message: "本地记录显示该推文已回复" } : { ok: true, replied: false };
}

async function recordReplyHistory(result) {
  if (!result?.replyText) return;
  const task = runtimeState.currentTask || {};
  const tweet = result.tweet || {};
  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    platform: "xinhuo",
    taskKey: getXinhuoTaskIdentity(task),
    detailPath: normalizeXinhuoTaskPath(task.detailPath || task.taskKey),
    tweetUrl: normalizeTweetUrl(tweet.url || task.tweetUrl || ""),
    tweetText: String(tweet.text || task.detailText || "").slice(0, 500),
    replyText: String(result.replyText).slice(0, 280),
    taskType: task.taskType || "评论",
    bounty: Number(task.bounty || 0)
  };
  const prior = await getReplyHistoryRecords();
  const next = [record, ...prior.filter((item) => {
    const sameTweet = record.tweetUrl && normalizeTweetUrl(item.tweetUrl) === record.tweetUrl;
    const sameTask = record.taskKey && getXinhuoTaskIdentity(item) === record.taskKey;
    return !sameTweet && !sameTask;
  })].slice(0, MAX_REPLY_HISTORY_RECORDS);
  await chrome.storage.local.set({ [REPLY_HISTORY_KEY]: next });
}

function normalizeXinhuoReplyRecord(record) {
  if (!record || typeof record !== "object") return null;
  const tweetUrl = normalizeTweetUrl(record.tweetUrl);
  const taskKey = getXinhuoTaskIdentity(record);
  if (!tweetUrl && !taskKey) return null;
  return {
    id: String(record.id || `${record.createdAt || "legacy"}-${taskKey || tweetUrl}`),
    createdAt: String(record.createdAt || ""),
    platform: "xinhuo",
    taskKey,
    detailPath: normalizeXinhuoTaskPath(record.detailPath || record.taskKey),
    tweetUrl,
    tweetText: String(record.tweetText || "").slice(0, 500),
    replyText: String(record.replyText || "").slice(0, 280),
    taskType: String(record.taskType || "评论"),
    bounty: Number(record.bounty || 0) || 0
  };
}

async function openDebugPage(windowId) {
  const query = { url: DEBUG_PAGE_URL };
  if (Number.isInteger(windowId)) query.windowId = windowId;
  const existing = (await chrome.tabs.query(query))[0];
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create(Number.isInteger(windowId) ? { url: DEBUG_PAGE_URL, windowId, active: true } : { url: DEBUG_PAGE_URL, active: true });
  return { ok: true };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings"]);
  const settings = normalizeSettings(stored.settings || {});
  if (JSON.stringify(stored.settings || {}) !== JSON.stringify(settings)) await chrome.storage.local.set({ settings });
  return settings;
}

function migrateSettings(settings) {
  const next = { ...(settings || {}) };
  const version = Number.parseInt(next.settingsVersion, 10) || 0;
  let changed = false;
  if (version < 2) {
    const currentPrompt = String(next.aiSystemPrompt || "").trim();
    const isPriorDefault = !currentPrompt
      || /你是普通中文用户，帮我写一条推文回复/.test(currentPrompt)
      || /像路过随手回一句/.test(currentPrompt);
    if (isPriorDefault) {
      next.aiSystemPrompt = XINHUO_DEFAULT_AI_SYSTEM_PROMPT;
      changed = true;
    }
    if (typeof next.aiModel !== "string") {
      next.aiModel = "";
      changed = true;
    }
    next.settingsVersion = 2;
    changed = true;
  }
  if (version < 3) {
    if (next.aiProvider === "gpt-5.6-terra" && !String(next.aiModel || "").trim()) {
      next.aiModel = "gpt-5.6-terra";
      changed = true;
    }
    if (next.replyProvider !== "native" && next.replyProvider !== "sola_bridge") {
      next.replyProvider = DEFAULT_SETTINGS.replyProvider;
      changed = true;
    }
    next.settingsVersion = 3;
    changed = true;
  }
  if (version < 4) {
    if (next.aiProvider === "gpt-5.6-terra" || next.aiProvider === "gpt-5-nano") {
      if (!String(next.aiModel || "").trim()) next.aiModel = next.aiProvider;
      next.aiProvider = "openai";
      changed = true;
    }
    next.settingsVersion = 4;
    changed = true;
  }
  return { settings: next, changed };
}

function normalizeSettings(settings) {
  const migrated = migrateSettings(settings).settings;
  const merged = { ...DEFAULT_SETTINGS, ...migrated };
  const providerModelAlias = ["gpt-5-nano", "gpt-5.6-terra"].includes(merged.aiProvider)
    ? merged.aiProvider
    : "";
  const aiProvider = providerModelAlias
    ? "openai"
    : (["openai", "deepseek", "grok", "gemini", "gemini-flash"].includes(merged.aiProvider)
      ? merged.aiProvider
      : DEFAULT_SETTINGS.aiProvider);
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
  };
  return {
    ...merged,
    settingsVersion: 4,
    taskPlatform: "xinhuo",
    actionDelayMs: number(merged.actionDelayMs, DEFAULT_SETTINGS.actionDelayMs, 500, 10000),
    claimTimeoutMs: number(merged.claimTimeoutMs ?? merged.lockSeatTimeoutMs, DEFAULT_SETTINGS.claimTimeoutMs, 5000, 300000),
    cooldownPollMs: number(merged.cooldownPollMs, DEFAULT_SETTINGS.cooldownPollMs, 200, 5000),
    xinhuoMinTaskBounty: number(merged.xinhuoMinTaskBounty, 0, 0, 9999),
    maxTasksPerRun: number(merged.maxTasksPerRun, 9999, 1, 9999),
    maxTaskAttempts: number(merged.maxTaskAttempts, 9999, 1, 9999),
    replyMode: merged.replyMode === "post" ? "post" : "fill",
    replyProvider: merged.replyProvider === "sola_bridge" ? "sola_bridge" : "native",
    readingSimulationMs: number(merged.readingSimulationMs, 4000, 500, 20000),
    autoSubmitXinhuo: Boolean(merged.autoSubmitXinhuo ?? merged.autoSubmitLighthouse),
    aiProvider,
    aiModel: (String(merged.aiModel || "").trim() || providerModelAlias
      || (aiProvider === "openai" ? DEFAULT_SETTINGS.aiModel : "")).slice(0, 128),
    aiApiUrl: String(merged.aiApiUrl || "").trim(),
    aiApiKey: String(merged.aiApiKey || "").trim(),
    aiSystemPrompt: String(merged.aiSystemPrompt || XINHUO_DEFAULT_AI_SYSTEM_PROMPT).trim(),
    runWindowEnabled: merged.runWindowEnabled === true,
    runWindowStart: normalizeClock(merged.runWindowStart, DEFAULT_SETTINGS.runWindowStart),
    runWindowEnd: normalizeClock(merged.runWindowEnd, DEFAULT_SETTINGS.runWindowEnd)
  };
}

function toContentSettings(settings) {
  return { ...settings, lockSeatTimeoutMs: settings.claimTimeoutMs };
}

function getScheduleState(settings) {
  if (!settings.runWindowEnabled) return { inWindow: true, nextStartAt: 0 };
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseClock(settings.runWindowStart);
  const end = parseClock(settings.runWindowEnd);
  const inWindow = start === end || (start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end);
  if (inWindow) return { inWindow, nextStartAt: 0 };
  const next = new Date(now);
  next.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return { inWindow, nextStartAt: next.getTime() };
}

async function enterScheduleWait(schedule) {
  runtimeState.running = false;
  runtimeState.scheduledResumeAt = 0;
  setStage("manual_start_required");
  log("warn", "运行时段限制不会创建定时任务；请在允许时段手动启动");
}

function createInitialState() {
  return { running: false, mode: "idle", stage: "idle", completed: 0, failed: 0, attempts: 0, windowId: null, xinhuoTabId: null, xTabId: null, xTabWindowId: null, currentTask: null, lastXResult: null, completionEvidence: null, pendingXOpen: null, pendingXSubmission: null, attemptedTasks: [], scheduledResumeAt: 0, lastProgressAt: Date.now(), runId: createRunId(), logs: [] };
}

function createRunId() { sequence += 1; return `${Date.now()}-${sequence}`; }
function isXinhuoUrl(url) { return /^https:\/\/xinhuo123\.com\/(?:tasks(?:[/?#]|$)|(?:[?#]|$))/.test(String(url || "")); }
function isXinhuoMarketplaceUrl(url) { return /^https:\/\/xinhuo123\.com\/tasks(?:[?#]|$)/.test(String(url || "")); }
function assertXinhuoTab(tab, context = "薪火任务操作") {
  if (!tab?.id || !isXinhuoUrl(tab.url)) {
    throw new Error(`${context}拒绝使用非薪火标签：${tab?.url || "missing tab"}`);
  }
}
function setStage(stage) {
  runtimeState.stage = stage;
  touchRunState();
}
function log(level, text, meta = null) {
  const task = runtimeState.currentTask || {};
  const taskKey = String(task.taskKey || task.detailPath || "").split("/").pop();
  runtimeState.logs.unshift({
    at: new Date().toISOString(),
    level,
    text: String(text || ""),
    source: meta?.source || "background",
    pagePhase: meta?.page?.phase || stageToPagePhase(runtimeState.stage),
    taskType: task.taskType || "",
    bounty: Number(task.bounty || 0) || 0,
    taskId: taskKey || "",
    taskTitle: String(task.candidateTitle || task.title || task.taskTitle || "").slice(0, 120),
    tweetUrl: normalizeTweetUrl(task.tweetUrl)
  });
  runtimeState.logs = runtimeState.logs.slice(0, 120);
  persistRuntimeState();
}
function stageToPagePhase(stage) {
  const phases = {
    debug_takeover: "xinhuo",
    xinhuo_tasks_opened: "marketplace",
    xinhuo_task_detail_opened: "detail",
    xinhuo_x_opened: "x_open",
    xinhuo_x_replied: "x_reply",
    xinhuo_x_task_submitted: "x_submit",
    xinhuo_tasks_returned: "marketplace",
    debug_step_failed: "unknown",
    starting: "marketplace",
    resuming_claimed_task: "claim_recovery",
    selecting_task: "marketplace",
    claim_not_acquired: "claim",
    replying: "x_reply",
    foreground_wait: "x_reply",
    submitting_x_task: "x_submit",
    waiting_verification_result: "verification",
    submitted: "completed",
    verification_failed: "verification",
    recovering: "recovery",
    claimed_task_recovery_blocked: "recovery_error"
  };
  return phases[stage] || "unknown";
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normalizeTweetUrl(url) { const match = String(url || "").match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i); return match ? match[0].replace("twitter.com", "x.com") : ""; }
function normalizeXinhuoTaskPath(value) {
  try {
    const url = new URL(String(value || ""), XINHUO_TASKS_URL);
    return /^\/tasks\/[^/?#]+$/.test(url.pathname) ? url.pathname : "";
  } catch (_) {
    return "";
  }
}
function getXinhuoTaskIdentity(task) {
  return normalizeXinhuoTaskPath(task?.taskKey || task?.detailPath || task?.id);
}
function mergeXinhuoTask(currentTask, nextTask, overrides = {}) {
  const currentIdentity = getXinhuoTaskIdentity(currentTask);
  const nextIdentity = getXinhuoTaskIdentity(nextTask);
  const sameTask = !nextTask || Boolean(currentIdentity && nextIdentity && currentIdentity === nextIdentity);
  const currentUrl = normalizeTweetUrl(currentTask?.tweetUrl);
  const nextUrl = normalizeTweetUrl(nextTask?.tweetUrl);
  const overrideUrl = normalizeTweetUrl(overrides?.tweetUrl);
  return {
    ...(currentTask || {}),
    ...(nextTask || {}),
    ...(overrides || {}),
    taskKey: nextIdentity || (sameTask ? currentIdentity : ""),
    detailPath: normalizeXinhuoTaskPath(nextTask?.detailPath || nextTask?.taskKey)
      || (sameTask ? normalizeXinhuoTaskPath(currentTask?.detailPath || currentTask?.taskKey) : ""),
    tweetUrl: overrideUrl || nextUrl || (sameTask ? currentUrl : "")
  };
}
function isMissingReceiver(error) { return /Receiving end does not exist|Could not establish connection/i.test(String(error?.message || error)); }
function isLimitReached(count, limit) { return Number.isFinite(Number(limit)) && Number(limit) < 9999 && count >= Number(limit); }
function normalizeClock(value, fallback) { return /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : fallback; }
function parseClock(value) { const [hour, minute] = normalizeClock(value, "00:00").split(":").map(Number); return hour * 60 + minute; }
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN", { hour12: false }); }

async function restoreRuntimeState() {
  try {
    const stored = await chrome.storage.local.get([RUN_STATE_KEY]);
    const saved = stored[RUN_STATE_KEY];
    if (!saved || typeof saved !== "object" || !saved.running) return;
    runtimeState = {
      ...createInitialState(),
      ...saved,
      running: false,
      mode: "idle",
      stage: "interrupted_not_resumed",
      logs: Array.isArray(saved.logs) ? saved.logs.slice(0, 120) : [],
      pendingXOpen: null,
      pendingXSubmission: null,
      runId: saved.runId || createRunId()
    };
    log("warn", "Chrome 后台恢复了中断的薪火状态，等待保活闹钟自动续跑");
    await ensureXinhuoKeepalive();
  } catch (_) {
    // A missing or malformed snapshot should behave like a fresh idle worker.
  }
}

async function ensureXinhuoKeepalive() {
  try {
    if (typeof chrome === "undefined" || !chrome.alarms) return;
    await chrome.alarms.create(XINHUO_KEEPALIVE_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5
    });
  } catch (_) {
    // Keepalive is best-effort; the run itself must never fail because of it.
  }
}

async function clearXinhuoKeepalive() {
  try {
    if (typeof chrome === "undefined" || !chrome.alarms) return;
    await chrome.alarms.clear(XINHUO_KEEPALIVE_ALARM);
  } catch (_) {}
}

async function handleXinhuoKeepaliveTick() {
  await runtimeStateReady;
  if (runtimeState.running && runtimeState.mode === "auto") {
    // The alarm wake restarts the idle window; an API touch makes it deterministic.
    try { await chrome.runtime.getPlatformInfo(); } catch (_) {}
    if (runtimeState.stage === "selecting_task"
      && !runtimeState.currentTask
      && Date.now() - Number(runtimeState.lastProgressAt || 0) >= XINHUO_MARKETPLACE_IDLE_REFRESH_MS
      && !runtimeState.marketplaceRefreshInFlight
      && Number.isInteger(runtimeState.xinhuoTabId)) {
      runtimeState.marketplaceRefreshInFlight = true;
      try {
        const windowId = runtimeState.windowId;
        log("info", "薪火任务广场连续 5 分钟无活动，停止当前运行并重新执行全量检测");
        await stopXinhuoRun();
        if (Number.isInteger(runtimeState.xinhuoTabId)) {
          await chrome.tabs.reload(runtimeState.xinhuoTabId);
          await waitForTabComplete(runtimeState.xinhuoTabId);
        }
        void startXinhuoRun(windowId).catch((error) => {
          log("error", `薪火重新执行全量检测失败：${error.message || String(error)}`);
        });
      } catch (error) {
        log("warn", `薪火停止并重新检测失败：${error.message || String(error)}`);
      } finally {
        runtimeState.marketplaceRefreshInFlight = false;
      }
    }
    return;
  }
  if (await tryResumeXinhuoAfterInterruption()) return;
  await clearXinhuoKeepalive();
}

async function tryResumeXinhuoAfterInterruption() {
  if (runtimeState.running) return true;
  if (runtimeState.mode !== "idle" || runtimeState.stage !== "interrupted_not_resumed") return false;
  const savedTask = runtimeState.currentTask || {};
  const hasClaimedIncompleteOrder = Boolean(savedTask.claimed && !runtimeState.completionEvidence);
  if (hasClaimedIncompleteOrder) {
    log("error", `service worker 重启后仍有已接取未完成的薪火订单（${describeXinhuoTaskForLog(savedTask)}），不自动续跑，请人工处理该订单后重新启动`);
    return false;
  }
  // The old content-script claim may still hold with the previous runId; cancel
  // it so the resumed scan is not answered with a conflict.
  if (Number.isInteger(runtimeState.xinhuoTabId)) {
    try {
      await chrome.tabs.sendMessage(runtimeState.xinhuoTabId, {
        type: "CANCEL_XINHUO_RUN",
        runId: runtimeState.runId
      });
    } catch (_) {}
  }
  runtimeState.runId = createRunId();
  runtimeState.running = true;
  runtimeState.mode = "auto";
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;
  runtimeState.lastXResult = null;
  setStage("auto_resumed_after_restart");
  log("warn", "service worker 重启，已自动恢复薪火扫描任务广场");
  await runNextXinhuoTask("resume_after_service_worker_restart");
  return runtimeState.running;
}

function touchRunState() {
  runtimeState.lastProgressAt = Date.now();
  persistRuntimeState();
}

function persistRuntimeState() {
  const snapshot = {
    ...runtimeState,
    pendingXOpen: null,
    pendingXSubmission: null,
    logs: Array.isArray(runtimeState.logs) ? runtimeState.logs.slice(0, 120) : []
  };
  chrome.storage.local.set({ [RUN_STATE_KEY]: snapshot }, () => {
    void chrome.runtime.lastError;
  });
}

async function focusXinhuoXTab(tabId, knownWindowId = null) {
  if (!Number.isInteger(tabId)) throw new Error("缺少薪火目标 X 标签页，无法切到前台");
  const tab = await chrome.tabs.update(tabId, { active: true });
  const windowId = Number.isInteger(knownWindowId) ? knownWindowId : tab.windowId;
  if (Number.isInteger(windowId)) await chrome.windows.update(windowId, { focused: true });
  runtimeState.xTabId = tab.id;
  return tab;
}

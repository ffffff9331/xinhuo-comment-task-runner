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
const REPLY_DIAGNOSTIC_HISTORY_KEY = "xinhuoReplyDiagnosticHistoryRecords";
const MAX_REPLY_HISTORY_RECORDS = 200;
const XINHUO_AI_TIMEOUT_MS = 120000;
const AI_API_KEY_STORAGE_KEY = "xinhuoAiApiKeyV1";
const ATTEMPT_DEDUPE_MS = 3 * 60 * 1000;
const XINHUO_PREVIOUS_DEFAULT_AI_SYSTEM_PROMPT = "根据原推文写一句自然的中文回复。像真实用户刷到后随手留下的感受，简短、有一点具体反应，不必完整表达观点。10到15个汉字为主，可保留必要的英文词。避免宣传腔、总结腔、夸张吹捧、复述原文和模板化感叹。只输出回复。";
const XINHUO_DEFAULT_AI_SYSTEM_PROMPT = "根据原推文写一句自然的中文回复。像真实用户刷到后随手留下的感受，简短、有一点具体反应，不必完整表达观点。10到20个汉字为主，可保留必要的英文词。避免宣传腔、总结腔、夸张吹捧、复述原文和模板化感叹。只输出回复。";

const DEFAULT_SETTINGS = {
  settingsVersion: 5,
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
  aiModel: "gpt-6.1-sol",
  aiApiUrl: "https://api.vayne.cc.cd/v1/responses",
  aiApiKey: "",
  aiSystemPrompt: XINHUO_DEFAULT_AI_SYSTEM_PROMPT,
  runWindowEnabled: false,
  runWindowStart: "11:00",
  runWindowEnd: "01:00"
};

let sequence = 0;
let runtimeState = createInitialState();
const runtimeStateReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(restoreRuntimeState);
const activeAIRequests = new Set();
let directXinhuoXOpen = null;
let xinhuoMarketplaceTabPromise = null;
let manualDebugCommandTail = Promise.resolve();
let runtimeStateWriteTail = Promise.resolve();
let stopXinhuoRunPromise = null;
let settingsOperationTail = Promise.resolve();
let settingsOperationRevision = 0;

chrome.runtime.onInstalled.addListener(async () => {
  await runtimeStateReady;
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  await getSettings();
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
  if (!isAuthorizedMessage(message, sender)) {
    sendResponse({ ok: false, error: "消息来源无权执行此操作" });
    return false;
  }
  const receivedState = runtimeState;
  const receivedRunId = receivedState.runId;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      if (runtimeState === receivedState && receivedState.runId === receivedRunId) log("error", error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error), failureType: error.failureType || "", state: runtimeState });
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
      if (sender?.tab && !String(sender.url || "").startsWith("chrome-extension://")) return { ok: false, error: "完整设置仅限扩展界面访问" };
      return { ok: true, state: runtimeState, settings: await getSettings() };
    case "SAVE_SETTINGS": {
      const state = runtimeState;
      const runId = state.runId;
      const settings = await saveXinhuoSettings(message.settings || {});
      if (runtimeState === state && state.runId === runId) log("info", "薪火配置已保存");
      return { ok: true, state: runtimeState, settings };
    }
    case "START_RUN": {
      const pending = startXinhuoRun(messageWindowId);
      const state = runtimeState;
      const runId = state.runId;
      const result = await pending;
      if (runtimeState === state && state.runId === runId && !result?.cancelled && result?.ok === false && result.error) log("error", result.error);
      return result;
    }
    case "CHECK_XINHUO_CONNECTION":
      return checkXinhuoConnection(messageWindowId);
    case "XINHUO_CLAIM_INTENT":
      return recordXinhuoClaimIntent(message, sender);
    case "STOP_RUN":
      await stopXinhuoRun();
      return { ok: true, state: runtimeState };
    case "CONTENT_LOG":
      if (runtimeState.running && message.runId && message.runId === runtimeState.runId) {
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
      return { ok: true, records: await getCombinedReplyRecords() };
    case "CLEAR_REPLY_RECORDS":
      await chrome.storage.local.set({ [REPLY_HISTORY_KEY]: [], [REPLY_DIAGNOSTIC_HISTORY_KEY]: [] });
      log("info", "已清空薪火回复与诊断记录");
      return { ok: true, records: [] };
    case "QUERY_TWEET_REPLY_HISTORY":
      return queryTweetReplyHistory(message.tweet, message.task);
    case "OPEN_DEBUG_PAGE":
      return openDebugPage(message.clientWindowId ?? sender?.tab?.windowId ?? null);
    default:
      return { ok: false, error: "未知消息" };
  }
}

function isAuthorizedMessage(message, sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  if (String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return true;
  if (!Number.isInteger(sender?.tab?.id) || (sender.frameId ?? 0) !== 0) return false;
  const url = String(sender.url || "");
  if (/^https:\/\/(?:x|twitter)\.com\//.test(url)) {
    return ["GENERATE_AI_REPLY", "QUERY_TWEET_REPLY_HISTORY"].includes(message?.type);
  }
  return /^https:\/\/xinhuo123\.com\//.test(url) && ["CONTENT_LOG", "XINHUO_CLAIM_INTENT"].includes(message?.type);
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

function requiresXinhuoAIReply(task) {
  const type = String(task?.taskType || "").trim();
  return /评论|回复|comment|reply/i.test(type) || !/点赞|关注|like|follow/i.test(type);
}

function enqueueManualDebugCommand(message, windowId) {
  const state = runtimeState;
  const operation = manualDebugCommandTail.then(() => runtimeState === state && !state.stopping
    ? runManualDebugCommand(message, windowId)
    : { ok: false, cancelled: true, error: "旧单步队列已停止" });
  manualDebugCommandTail = operation.catch(() => {});
  return operation;
}

async function runManualDebugCommand(message, windowId) {
  if (runtimeState.stopping) return { ok: false, cancelled: true, error: "流程正在停止" };
  const state = runtimeState;
  const runId = state.runId;
  if (["DEBUG_XINHUO_OPEN_TASKS", "DEBUG_XINHUO_OPEN_FIRST_TASK"].includes(message.type)
      && (runtimeState.uncertainAction || (runtimeState.currentTask?.claimed
        && !hasLatchedXinhuoCompletion(runtimeState.completionEvidence?.runId)))) {
    return { ok: false, error: "旧订单尚未核对，不能接管或打开另一任务", state: runtimeState };
  }
  const lockResult = lockRuntimeWindowForCommand(windowId, message.type);
  if (!lockResult.ok) return { ok: false, error: lockResult.error, state: runtimeState };
  if (["DEBUG_XINHUO_CLAIM_OPEN_X", "DEBUG_XINHUO_RUN_X_REPLY"].includes(message.type)) {
    const settings = await getSettings();
    if (runtimeState !== state || state.runId !== runId || state.stopping) return { ok: false, cancelled: true };
    if (!settings.aiApiKey && requiresXinhuoAIReply(state.currentTask)) {
      return { ok: false, error: "尚未配置 AI API Key，请在侧栏重新填写并保存", state };
    }
  }
  state.manuallyStopped = false;
  await prepareDebugRunForCommand(windowId, message.type);
  if (runtimeState !== state || !state.running || state.mode !== "debug") return { ok: false, cancelled: true };

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
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
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
    if (!current()) return;
    const cancellations = [];
    if (runtimeState.xinhuoTabId) cancellations.push(sendToTab(runtimeState.xinhuoTabId, { type: "CANCEL_XINHUO_RUN", runId: previousRunId }));
    if (runtimeState.xTabId) cancellations.push(sendToTab(runtimeState.xTabId, { type: "CANCEL_X_RUN", runId: previousRunId }));
    await Promise.allSettled(cancellations);
    if (!current()) return;
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
  const state = runtimeState;
  let runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && state.running;
  if (runtimeState.uncertainAction || (runtimeState.currentTask?.claimed && !hasLatchedXinhuoCompletion(runtimeState.completionEvidence?.runId))) {
    return { ok: false, error: "旧订单尚未核对，已保留当前订单和页面", state: runtimeState };
  }
  const previousRunId = runtimeState.runId;
  const cancellations = [];
  if (runtimeState.xinhuoTabId) cancellations.push(sendToTab(runtimeState.xinhuoTabId, { type: "CANCEL_XINHUO_RUN", runId: previousRunId }));
  if (runtimeState.xTabId) cancellations.push(sendToTab(runtimeState.xTabId, { type: "CANCEL_X_RUN", runId: previousRunId }));
  await Promise.allSettled(cancellations);
  if (!current()) return { ok: false, cancelled: true };
  runtimeState.runId = createRunId();
  runId = runtimeState.runId;
  clearXinhuoXOpenWatch();
  clearXinhuoXSubmission();
  runtimeState.currentTask = null;
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;
  runtimeState.lastXResult = null;
  runtimeState.completionEvidence = null;
  const tab = await ensureXinhuoMarketplaceTab();
  if (!current()) return { ok: false, cancelled: true };
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { url: XINHUO_TASKS_URL, active: true });
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(tab.id);
  if (!current()) return { ok: false, cancelled: true };
  setStage("xinhuo_tasks_opened");
  log("info", "已打开薪火任务广场并开始检测任务");
  return { ok: true, state: runtimeState };
}

async function debugOpenFirstXinhuoTask() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && state.running;
  if (runtimeState.uncertainAction || (runtimeState.currentTask?.claimed && !hasLatchedXinhuoCompletion(runtimeState.completionEvidence?.runId))) {
    return { ok: false, error: "旧订单尚未核对，不能打开另一任务", state: runtimeState };
  }
  const tab = await getOrCreateXinhuoTab();
  if (!current()) return { ok: false, cancelled: true };
  assertXinhuoTab(tab, "打开薪火任务详情前");
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { active: true });
  if (!current()) return { ok: false, cancelled: true };
  const settings = await getSettings();
  if (!current()) return { ok: false, cancelled: true };
  const result = await sendToTab(tab.id, {
    type: "DEBUG_XINHUO_OPEN_FIRST_TASK",
    runId: runtimeState.runId,
    settings: toContentSettings(settings),
    attemptedTaskRecords: getAttemptedTaskRecords(),
    attemptedTaskKeys: getAttemptedTaskKeys()
  });
  if (!current()) return { ok: false, cancelled: true };
  if (!result?.ok || !result.task) return failDebugStep(result, "打开首个薪火可接任务失败");
  runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, result.task);
  setStage("xinhuo_task_detail_opened");
  log("info", result.message || "已打开首个薪火可接任务详情");
  return { ok: true, result, state: runtimeState };
}

async function debugClaimXinhuoTaskAndOpenX() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && state.running;
  const settings = await getSettings();
  if (!current()) return { ok: false, cancelled: true };
  if (!settings.aiApiKey && requiresXinhuoAIReply(state.currentTask)) return { ok: false, error: "尚未配置 AI API Key，未接取任务", state };
  const tab = await getOrCreateXinhuoTab();
  if (!current()) return { ok: false, cancelled: true };
  assertXinhuoTab(tab, "接取薪火任务前");
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { active: true });
  if (!current()) return { ok: false, cancelled: true };
  beginXinhuoXOpenWatch(tab);
  const result = await sendToTab(tab.id, {
    type: "DEBUG_XINHUO_CLAIM_CURRENT_TASK",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  if (!current()) return { ok: false, cancelled: true };
  if (!result?.ok || !result.task) {
    clearXinhuoXOpenWatch();
    return failDebugStep(result, "薪火接单或风险确认失败");
  }
  runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, result.task);
  markAttemptedTask(runtimeState.currentTask);
  const xTab = await getSiteOpenedTargetXTab(runtimeState.currentTask, tab.id);
  if (!current()) return { ok: false, cancelled: true };
  if (!xTab) return failDebugStep(result, "薪火已接单，但未能打开当前任务的目标 X");
  await focusXinhuoXTab(xTab.id, xTab.windowId);
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(xTab.id);
  if (!current()) return { ok: false, cancelled: true };
  setStage("xinhuo_x_opened");
  log("info", "薪火任务已接取并打开目标 X");
  return { ok: true, result, state: runtimeState };
}

async function debugRunXinhuoXReply() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && state.running;
  const settings = await getSettings();
  if (!current()) return { ok: false, cancelled: true };
  if (!settings.aiApiKey && requiresXinhuoAIReply(state.currentTask)) return { ok: false, error: "尚未配置 AI API Key，未执行回复", state };
  const xTab = await resolveCurrentXinhuoXTab();
  if (!current()) return { ok: false, cancelled: true };
  await focusXinhuoXTab(xTab.id, xTab.windowId);
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(xTab.id);
  if (!current()) return { ok: false, cancelled: true };
  await delay(Math.max(XINHUO_X_HYDRATION_MS, settings.actionDelayMs * 2));
  if (!current()) return { ok: false, cancelled: true };
  const result = await sendToTab(xTab.id, {
    type: "RUN_X_REPLY",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  if (!current()) return { ok: false, cancelled: true };
  if (!result?.ok) return failDebugStep(result, "薪火 X 回复步骤失败");
  runtimeState.lastXResult = result;
  await recordReplyHistory(result);
  if (!current()) return { ok: false, cancelled: true };
  setStage("xinhuo_x_replied");
  log("info", result.message || "薪火 X 回复已完成");
  return { ok: true, result, state: runtimeState };
}

async function debugCompleteXinhuoXTask() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && state.running;
  const xTab = await resolveCurrentXinhuoXTab();
  if (!current()) return { ok: false, cancelled: true };
  const settings = await getSettings();
  if (!current()) return { ok: false, cancelled: true };
  const control = { stopped: false };
  const keeper = maintainXinhuoXForeground(xTab.id, runtimeState.runId, control);
  let result;
  try {
    await delay(XINHUO_FOREGROUND_MS);
    if (!current()) return { ok: false, cancelled: true };
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
  if (!current()) return { ok: false, cancelled: true };
  const closedAfterSubmission = runtimeState.pendingXSubmission?.tabClosed === true;
  if (!result?.ok && !closedAfterSubmission) return failDebugStep(result, "薪火 X 任务组件提交失败");
  setStage("xinhuo_x_task_submitted");
  log("info", closedAfterSubmission ? "X 任务页已关闭，继续核对薪火结果" : (result?.message || "薪火 X 任务已提交"));
  return { ok: true, result, state: runtimeState };
}

async function debugWaitXinhuoCompletionAndReturn() {
  const state = runtimeState;
  const runId = runtimeState.runId;
  const current = () => runtimeState === state && state.runId === runId && state.running;
  const settings = await getSettings();
  if (!current()) return { ok: false, cancelled: true };
  const tab = await getCurrentXinhuoTaskTab();
  if (!current()) return { ok: false, cancelled: true };
  await chrome.tabs.update(tab.id, { active: true });
  if (!current()) return { ok: false, cancelled: true };
  await chrome.tabs.reload(tab.id);
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(tab.id);
  if (!current()) return { ok: false, cancelled: true };
  const initial = await sendToTab(tab.id, {
    type: "XINHUO_WAIT_FOR_SUBMISSION_RESULT",
    runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  if (!current()) return { ok: false, cancelled: true };
  const finalResult = await waitForXinhuoFinalVerification(tab.id, runId, settings, initial);
  if (!current()) return { ok: false, cancelled: true };
  return finishXinhuoOfficialResult(tab, runId, settings, finalResult);
}

async function debugReturnXinhuoTasks() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && state.running;
  const tab = await getOrCreateXinhuoTab();
  if (!current()) return { ok: false, cancelled: true };
  assertXinhuoTab(tab, "返回薪火任务广场前");
  runtimeState.xinhuoTabId = tab.id;
  await chrome.tabs.update(tab.id, { url: XINHUO_TASKS_URL, active: true });
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(tab.id);
  if (!current()) return { ok: false, cancelled: true };
  setStage("xinhuo_tasks_returned");
  log("info", "已返回薪火任务广场");
  return { ok: true, state: runtimeState };
}

async function resolveCurrentXinhuoXTab() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  const expected = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl);
  if (!expected) throw new Error("当前薪火任务缺少目标 X 链接，请先执行接单开 X");
  const bound = await getBoundMatchingXinhuoXTab(expected);
  if (!current()) return null;
  if (bound) return bound;
  const query = { url: ["https://x.com/*", "https://twitter.com/*"] };
  if (Number.isInteger(runtimeState.windowId)) query.windowId = runtimeState.windowId;
  const matches = (await chrome.tabs.query(query)).filter((tab) => normalizeTweetUrl(tab.url) === expected);
  if (!current()) return null;
  const tab = matches.find((candidate) => candidate.active) || matches[0];
  if (!tab) throw new Error("未找到与当前薪火任务精确匹配的 X 标签页");
  runtimeState.xTabId = tab.id;
  runtimeState.xTabWindowId = tab.windowId;
  return tab;
}

async function getCurrentXinhuoTaskTab() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  const taskPath = normalizeXinhuoTaskPath(runtimeState.currentTask?.detailPath || runtimeState.currentTask?.taskKey);
  if (!taskPath) throw new Error("当前薪火任务缺少详情页身份");
  let tab = await getOrCreateXinhuoTab();
  if (!current()) return null;
  assertXinhuoTab(tab, "核对薪火任务结果前");
  if (normalizeXinhuoTaskPath(tab.url) !== taskPath) {
    tab = await chrome.tabs.update(tab.id, { url: new URL(taskPath, XINHUO_TASKS_URL).href, active: true });
    if (!current()) return null;
    await waitForTabComplete(tab.id);
    if (!current()) return null;
  }
  runtimeState.xinhuoTabId = tab.id;
  return tab;
}

async function reconcileUncertainXinhuoClaim(windowId) {
  // Validate the complete stored identity before the legacy normalizers can
  // extract a valid-looking path or status URL from a different address.
  const strictTaskPath = value => typeof value === "string"
    ? value.match(/^(?:https:\/\/xinhuo123\.com)?(\/tasks\/[A-Za-z0-9_-]+)$/)?.[1] || "" : "";
  const strictTweetUrl = value => {
    if (typeof value !== "string") return "";
    const match = value.match(/^https:\/\/(?:x|twitter)\.com(\/[A-Za-z0-9_]+\/status\/[0-9]+)(?:\/(?:photo|video)\/[1-9][0-9]*)?\/?(?:[?#].*)?$/i);
    return match ? `https://x.com${match[1]}` : "";
  };
  const state = runtimeState;
  const intent = state.uncertainAction;
  const task = intent?.task || state.currentTask;
  const currentTask = state.currentTask;
  const detailPath = strictTaskPath(task?.detailPath || task?.taskKey);
  const tweetUrl = strictTweetUrl(task?.tweetUrl);
  const supported = ["XINHUO_SELECT_AND_CLAIM", "DEBUG_XINHUO_CLAIM_CURRENT_TASK"].includes(intent?.type)
    || (intent?.type === "XINHUO_CLAIM" && intent.protocol === 1);
  if (!supported || !detailPath || !tweetUrl || strictTaskPath(intent?.taskKey) !== detailPath
      || !intent.runId || !Number.isInteger(intent.tabId)) {
    return { ok: false, error: "旧动作不是可核对的领取，或缺少完整订单身份；已保留保护记录" };
  }
  const matchesTask = candidate => strictTaskPath(candidate?.detailPath || candidate?.taskKey) === detailPath
    && [candidate?.detailPath, candidate?.taskKey, candidate?.claimedDetailPath]
      .filter(value => value !== undefined && value !== null && value !== "")
      .every(value => strictTaskPath(value) === detailPath)
    && strictTweetUrl(candidate?.tweetUrl) === tweetUrl;
  if (!matchesTask(task) || (currentTask && !matchesTask(currentTask))) {
    return { ok: false, error: "旧领取记录与当前订单身份冲突，未解除任何订单保护" };
  }
  if (!Number.isInteger(state.windowId) || windowId !== state.windowId) {
    return { ok: false, error: "请在原薪火窗口核对旧领取，未解除订单保护" };
  }
  if (state.running || state.stopping || state.claimRecoveryInFlight) {
    return { ok: false, error: "正在停止或核对旧领取，请等待结果" };
  }
  const runId = state.runId;
  const boundTabId = state.xinhuoTabId;
  const token = {};
  state.claimRecoveryInFlight = true;
  state.claimRecoveryToken = token;
  const current = () => runtimeState === state && state.runId === runId && !state.running && !state.stopping
    && state.windowId === windowId && state.xinhuoTabId === boundTabId
    && state.currentTask === currentTask && state.uncertainAction === intent && state.claimRecoveryToken === token
    && matchesTask(task) && (!state.currentTask || matchesTask(state.currentTask))
    && (!intent.task || intent.task === task) && strictTaskPath(intent.taskKey) === detailPath;
  const cancelled = () => ({ ok: false, cancelled: true, error: "流程已变化，取消旧领取核对" });
  const allowedPage = tab => tab?.windowId === windowId && !tab.pendingUrl
    && /^https:\/\/xinhuo123\.com\//.test(tab.url || "")
    && (normalizeXinhuoTaskPath(tab.url) === detailPath || new URL(tab.url).pathname === "/tasks");
  const exactPage = tab => allowedPage(tab) && normalizeXinhuoTaskPath(tab.url) === detailPath;
  try {
    let tab;
    try { tab = await chrome.tabs.get(intent.tabId); }
    catch (error) {
      if (!current()) return cancelled();
      if (!/No tab|Invalid tab/i.test(String(error?.message || error))) throw error;
      // A closed source tab has no remaining page actions. Reuse only a
      // suitable Xinhuo page in the recorded window, never another window.
      const tabs = await chrome.tabs.query({ windowId, url: "https://xinhuo123.com/*" });
      if (!current()) return cancelled();
      tab = tabs.find(exactPage) || tabs.find(allowedPage);
      if (!tab) return { ok: false, error: "原领取标签已关闭，请在原窗口打开薪火任务广场后再核对" };
    }
    if (!current()) return cancelled();
    if (!allowedPage(tab)) return { ok: false, error: "原薪火页面或窗口已变化，未清除旧领取记录" };
    const cancelledPage = await chrome.tabs.sendMessage(tab.id, { type: "CANCEL_XINHUO_RUN", runId: intent.runId });
    if (!current()) return cancelled();
    if (!cancelledPage?.ok) return { ok: false, error: "未确认旧页面动作已停止，保留领取记录" };
    const inspectionTabId = tab.id;
    tab = await chrome.tabs.get(inspectionTabId);
    if (!current()) return cancelled();
    if (!allowedPage(tab)) return { ok: false, error: "取消旧动作期间页面已变化，未重新加载或清除记录" };
    if (exactPage(tab)) await chrome.tabs.reload(inspectionTabId);
    else await chrome.tabs.update(inspectionTabId, { url: new URL(detailPath, XINHUO_TASKS_URL).href, active: false });
    if (!current()) return cancelled();
    await waitForTabComplete(inspectionTabId);
    if (!current()) return cancelled();
    let inspection;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      tab = await chrome.tabs.get(inspectionTabId);
      if (!current()) return cancelled();
      if (!exactPage(tab)) return { ok: false, error: "核对页面已离开原订单，保留领取记录" };
      // No runId: this is a read-only inspection while the runner is stopped.
      inspection = await chrome.tabs.sendMessage(inspectionTabId, {
        type: "XINHUO_INSPECT_CURRENT_TASK", task: { ...task, taskKey: detailPath, detailPath, tweetUrl,
          ...(task.claimedDetailPath ? { claimedDetailPath: detailPath } : {}) }
      });
      if (!current()) return cancelled();
      tab = await chrome.tabs.get(inspectionTabId);
      if (!current()) return cancelled();
      if (!exactPage(tab)) return { ok: false, error: "核对回执到达时页面已变化，保留领取记录" };
      const loading = inspection?.inspectionLoading === true
        || inspection?.message === "订单面板尚未加载";
      if (inspection?.inspectionState !== "unknown" || !loading || attempt === 19) break;
      await delay(500);
      if (!current()) return cancelled();
    }
    const inspectedTask = inspection?.task;
    if (!inspection?.ok || !["unclaimed", "completed", "failed"].includes(inspection.inspectionState)
        || strictTaskPath(inspectedTask?.detailPath) !== detailPath
        || strictTaskPath(inspectedTask?.taskKey) !== detailPath
        || !matchesTask(inspectedTask)) {
      return { ok: false, error: inspection?.message
        ? `旧订单尚未取得明确未领取或已结束证据：${inspection.message}；已保留保护记录`
        : "旧订单仍在进行中或官网证据不足，已保留保护记录" };
    }
    const recovered = { ...state, currentTask: null, xinhuoTabId: inspectionTabId };
    delete recovered.uncertainAction;
    // Keep the memory guard until durable clearing succeeds. A concurrent
    // STOP queues its protected snapshot after this write and wins on disk.
    await persistRuntimeState(true, recovered);
    if (!current()) {
      await persistRuntimeState(true);
      return cancelled();
    }
    delete state.uncertainAction;
    state.currentTask = null;
    state.xinhuoTabId = inspectionTabId;
    log("info", `已核对旧领取 ${detailPath}：${inspection.inspectionState}，允许重新扫描`);
    return { ok: true, kind: inspection.inspectionState, task: inspectedTask };
  } catch (error) {
    return current() ? { ok: false, error: `无法核对旧领取：${error.message || String(error)}；已保留保护记录` } : cancelled();
  } finally {
    if (state.claimRecoveryToken === token) {
      state.claimRecoveryInFlight = false;
      delete state.claimRecoveryToken;
    }
  }
}

async function startXinhuoRun(windowId, { automatic = false } = {}) {
  if (automatic && runtimeState.manuallyStopped) return { ok: false, cancelled: true };
  if (runtimeState.stopping || runtimeState.claimRecoveryInFlight) return { ok: false, error: "正在停止或核对旧领取，请等待结果", state: runtimeState };
  if (runtimeState.running) return { ok: false, error: "薪火自动任务正在运行", state: runtimeState };
  if (runtimeState.uncertainAction) {
    const state = runtimeState;
    const runId = state.runId;
    const recovery = await reconcileUncertainXinhuoClaim(windowId);
    if (!recovery.ok) return { ...recovery, state: runtimeState };
    if (runtimeState !== state || state.runId !== runId || state.running || state.stopping) {
      return { ok: false, cancelled: true, error: "流程已变化，核对后未启动任务", state: runtimeState };
    }
  }
  const recoverableTask = getRecoverableInterruptedTask(runtimeState);
  if (runtimeState.currentTask?.claimed && !recoverableTask) {
    return { ok: false, error: "旧订单身份不完整，无法安全核对，已保留订单", state: runtimeState };
  }
  runtimeState = createInitialState();
  runtimeState.currentTask = recoverableTask;
  runtimeState.running = true;
  runtimeState.mode = "auto";
  runtimeState.runId = createRunId();
  const startingState = runtimeState;
  const startingRunId = runtimeState.runId;
  const currentStart = () => runtimeState === startingState && runtimeState.runId === startingRunId && runtimeState.running;
  runtimeState.windowId = Number.isInteger(windowId) ? windowId : null;
  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    if (!currentStart()) return { ok: false, cancelled: true, state: runtimeState };
    runtimeState.running = false;
    setStage("blocked");
    return { ok: false, error: error.message, state: runtimeState };
  }
  if (!currentStart()) return { ok: false, cancelled: true, state: runtimeState };
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
  if (!currentStart()) return { ok: false, cancelled: true, state: runtimeState };
  setStage("starting");
  log("info", "薪火自动接单已启动：只接当前等级可做的评论、点赞、评论+点赞任务");
  if (recoverableTask) {
    let inspection;
    try {
      inspection = await inspectInterruptedXinhuoOrder(recoverableTask);
    } catch (error) {
      if (!currentStart()) return { ok: false, cancelled: true };
      runtimeState.currentTask = recoverableTask;
      runtimeState.running = false;
      setStage("claimed_task_recovery_blocked");
      log("error", `启动前无法核对旧薪火订单：${error.message || String(error)}；已保留订单，不扫描新任务`);
      await clearXinhuoKeepalive();
      return { ok: false, error: "无法核对旧薪火订单，已保留订单", state: runtimeState };
    }
    if (!currentStart()) return { ok: false, cancelled: true };
    if (inspection.kind === "claimed" || inspection.kind === "unknown") {
      runtimeState.xinhuoTabId = inspection.tab?.id || runtimeState.xinhuoTabId;
      runtimeState.currentTask = inspection.task || recoverableTask;
      runtimeState.running = false;
      setStage("claimed_task_recovery_blocked");
      log("warn", `${inspection.message || "旧薪火订单仍未结束"}；已保留订单，不扫描新任务`);
      await clearXinhuoKeepalive();
      return { ok: false, error: "旧薪火订单仍在进行中或无法确认，未扫描新任务", state: runtimeState };
    }
    if (inspection.kind === "completed") {
      releaseXinhuoAttemptedTask(inspection.task || recoverableTask);
      if (!recoverableTask.completionCounted) runtimeState.completed += 1;
      log("info", `启动前确认旧薪火订单已完成：${inspection.message}；返回广场继续扫描`);
    } else if (inspection.kind === "failed") {
      runtimeState.failed += 1;
      log("warn", `启动前确认旧薪火订单未通过：${inspection.message}；返回广场继续扫描`);
    } else {
      log("warn", `启动前确认旧薪火订单已不在进行中：${inspection.message}；返回广场继续扫描`);
    }
    clearCompletedXinhuoTaskState();
    clearXinhuoXOpenWatch();
    clearXinhuoXSubmission();
  }
  return runNextXinhuoTask("start");
}

async function runNextXinhuoTask(reason, options = {}) {
  const state = runtimeState;
  const runId = runtimeState.runId;
  const current = () => runtimeState === state && isActiveRun(runId);
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    if (!current()) return { ok: false, cancelled: true };
    return blockXinhuoConfiguration(error.message);
  }
  if (!current()) return { ok: false, cancelled: true };
  if (!settings.aiApiKey) {
    return blockXinhuoConfiguration("尚未配置 AI API Key，已停止扫描，请重新填写并保存");
  }
  if (isLimitReached(runtimeState.completed, settings.maxTasksPerRun)) return finishRun("达到任务上限，运行结束");
  if (isLimitReached(runtimeState.attempts, settings.maxTaskAttempts)) return finishRun("达到接单尝试上限，运行结束");

  let xinhuoTab;
  let result;
  const resumingClaimedTask = Boolean(options.resumeTask && Number.isInteger(options.resumeTabId));
  if (resumingClaimedTask) {
    xinhuoTab = await chrome.tabs.get(options.resumeTabId);
    if (!current()) return { ok: false, cancelled: true };
    assertXinhuoTab(xinhuoTab, "恢复薪火已接订单前");
    runtimeState.xinhuoTabId = xinhuoTab.id;
    runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, options.resumeTask);
    beginXinhuoXOpenWatch(xinhuoTab);
    result = { ok: true, task: runtimeState.currentTask };
  } else {
    xinhuoTab = await ensureXinhuoMarketplaceTab();
    if (!current()) return { ok: false, cancelled: true };
    assertXinhuoTab(xinhuoTab, "扫描薪火任务前");
    runtimeState.xinhuoTabId = xinhuoTab.id;
    // A browser may already have an unrelated task-detail tab open. Starting
    // an automatic run must begin from the marketplace unless an interrupted
    // claimed order was matched by both its saved path and target tweet URL.
    const marketplaceReady = options.marketplaceReady && isXinhuoMarketplaceUrl(xinhuoTab.url);
    if (!marketplaceReady) {
      log("info", `正在打开薪火任务广场：tab=${xinhuoTab.id}`);
      await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
      if (!current()) return { ok: false, cancelled: true };
      await waitForTabComplete(xinhuoTab.id);
      if (!current()) return { ok: false, cancelled: true };
    }
    if (runtimeState.mode === "auto" && !runtimeState.currentTask && Number(runtimeState.marketplaceNoClaimSince || 0) <= 0) {
      runtimeState.marketplaceNoClaimSince = Date.now();
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
      attemptedTaskRecords: getAttemptedTaskRecords(),
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
      if (!current()) return { ok: false, cancelled: true };
      await waitForTabComplete(xinhuoTab.id);
      if (!current()) return { ok: false, cancelled: true };
      return runNextXinhuoTask("claim_not_acquired", { marketplaceReady: true });
    }
    return stopWithFailure(result?.message || "薪火接取任务失败，已停留在当前页面", "claim_failed");
  }

  if (!resumingClaimedTask) runtimeState.attempts += 1;
  runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, result.task);
  if (!resumingClaimedTask && runtimeState.currentTask?.claimed) {
    runtimeState.marketplaceNoClaimSince = 0;
  }
  markAttemptedTask(result.task);
  // Persist the claimed order state. The separate five-minute watchdog begins
  // only after a later empty marketplace scan sets marketplaceNoClaimSince.
  if (typeof touchRunState === "function") touchRunState();
  else runtimeState.lastProgressAt = Date.now();
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
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(xTab.id);
  if (!current()) return { ok: false, cancelled: true };
  log("info", "X 推文页已打开，等待页面加载和任务组件初始化");
  await delay(Math.max(XINHUO_X_HYDRATION_MS, settings.actionDelayMs * 2));
  const reply = await sendToTab(xTab.id, { type: "RUN_X_REPLY", runId, task: result.task, settings: toContentSettings(settings) });
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  if (!reply?.ok) {
    const message = reply?.message || "X 回复失败，已保留当前页面";
    if (!isAIReplyFailureType(reply?.failureType)) {
      await recordReplyDiagnosticHistory(buildReplyFailureRecord("x_send_failed", message, result.task));
    }
    if (!current()) return { ok: false, cancelled: true };
    return stopWithFailure(message, "reply_failed");
  }
  runtimeState.lastXResult = reply;
  await recordReplyHistory(reply);
  if (!current()) return { ok: false, cancelled: true };

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
  const shouldUseDetailVerificationFallback = !submit?.ok
    && !xClosedAfterSubmission
    && !submit?.submissionAttempted;
  if (!submit?.ok && !xClosedAfterSubmission) {
    log("warn", `${submit?.message || "X 任务组件未确认提交"}；先回当前薪火订单读取官方结果，再决定是否失败`);
  } else {
    log("info", xClosedAfterSubmission
      ? "X 任务页已关闭，等待薪火确认是否提交成功"
      : (submit?.message || "已点击 X 任务组件的提交任务按钮，等待薪火确认"));
  }

  setStage("waiting_verification_result");
  log("info", shouldUseDetailVerificationFallback
    ? "正在回到当前薪火订单详情，执行一次官方 X API 核验兜底"
    : "正在回到当前薪火订单详情，只读核对结果，不重复使用 X API 补验");
  await delay(Math.max(1500, settings.actionDelayMs));
  if (!current()) return { ok: false, cancelled: true };
  await chrome.tabs.reload(xinhuoTab.id);
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(xinhuoTab.id);
  if (!current()) return { ok: false, cancelled: true };
  await chrome.tabs.update(xinhuoTab.id, { active: true });
  if (!current()) return { ok: false, cancelled: true };
  if (shouldUseDetailVerificationFallback) {
    log("warn", "X 任务组件未找到或未点击提交控件，改为在当前薪火订单执行一次官方 X API 核验兜底");
  }
  const confirmation = await sendToTab(xinhuoTab.id, {
    type: shouldUseDetailVerificationFallback
      ? "XINHUO_CONFIRM_AND_WAIT_VERIFICATION"
      : "XINHUO_WAIT_FOR_SUBMISSION_RESULT",
    runId,
    task: runtimeState.currentTask,
    settings: toContentSettings(settings)
  });
  if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
  if (!confirmation?.ok) {
    const released = await releaseXinhuoOrderIfNoLongerClaimed(xinhuoTab, runId);
    if (!current()) return { ok: false, cancelled: true };
    if (released) return released;
  }
  if (!submit?.ok && !xClosedAfterSubmission && !submit?.submissionAttempted && !confirmation?.ok) {
    return stopWithFailure(
      confirmation?.message || submit?.message || "X 组件和薪火官网均未确认任务提交，已保留当前订单",
      "submit_failed"
    );
  }
  const finalConfirmation = await waitForXinhuoFinalVerification(xinhuoTab.id, runId, settings, confirmation);
  return finishXinhuoOfficialResult(xinhuoTab, runId, settings, finalConfirmation);
}

async function releaseXinhuoOrderIfNoLongerClaimed(xinhuoTab, runId) {
  const state = runtimeState;
  const inspection = await sendToTab(xinhuoTab.id, {
    type: "XINHUO_INSPECT_CURRENT_TASK",
    runId,
    task: runtimeState.currentTask
  });
  if (runtimeState !== state || !isActiveRun(runId, state.mode)) return null;
  if (inspection?.claimed !== false) return null;
  clearCompletedXinhuoTaskState();
  log("warn", "薪火官网已不再显示该订单为已接取或进行中，已清理旧订单并返回广场继续扫描");
  return recoverXinhuoRun(
    "薪火官网未保留当前已接订单，已退出旧订单恢复流程",
    "released_claimed_task"
  );
}

async function waitForXinhuoFinalVerification(tabId, runId, settings, initial = null) {
  const state = runtimeState;
  const mode = runtimeState.mode;
  const current = () => runtimeState === state && isActiveRun(runId, mode);
  let latest = initial;
  let lastLogAt = 0;
  const startedAt = Date.now();
  const maxWaitMs = 30 * 60 * 1000;
  // 15s reloads are fine while the result is expected any moment; after two
  // minutes the wait is long-haul, so back off to once a minute.
  const pollIntervalMs = () => (Date.now() - startedAt >= 120000 ? 60000 : XINHUO_VERIFICATION_POLL_MS);
  while (isActiveRun(runId, mode)) {
    if (!isActiveRun(runId, mode)) return { ok: false, message: "薪火流程已停止" };
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
    if (!isActiveRun(runId, mode)) return { ok: false, message: "薪火流程已停止" };
    await chrome.tabs.reload(tabId);
    if (!current()) return { ok: false, cancelled: true };
    await waitForTabComplete(tabId);
    if (!current()) return { ok: false, cancelled: true };
    latest = await sendToTab(tabId, {
      type: "XINHUO_WAIT_FOR_SUBMISSION_RESULT",
      runId,
      task: runtimeState.currentTask,
      settings: toContentSettings(settings)
    });
    if (!current()) return { ok: false, cancelled: true };
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
  const state = runtimeState;
  const current = () => runtimeState === state && state.running && state.runId === runId;
  if (!current()) return { ok: false, cancelled: true };
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
    if (!current()) return { ok: false, cancelled: true };
    await waitForTabComplete(xinhuoTab.id);
    if (!current()) return { ok: false, cancelled: true };
    if (runtimeState.mode === "debug") return resumeXinhuoAutoAfterDebug(runId, "after_verification_failed");
    return runNextXinhuoTask("after_verification_failed", { marketplaceReady: true });
  }
  if (runtimeState.currentTask?.completionCounted) {
    return { ok: true, duplicate: true, state: runtimeState };
  }
  runtimeState.currentTask = { ...runtimeState.currentTask, completionCounted: true };
  runtimeState.completed += 1;
  if (typeof touchRunState === "function") touchRunState();
  else runtimeState.lastProgressAt = Date.now();
  // Completed orders are excluded by their own detail state; drop them from
  // the dedupe table so the next scan does not treat the plaza as stale.
  releaseXinhuoAttemptedTask(runtimeState.currentTask);
  setStage("submitted");
  log("info", finalConfirmation.message || "薪火已确认任务完成");
  await delay(Math.max(1000, settings.actionDelayMs));
  if (!runtimeState.running || runtimeState.runId !== runId) return { ok: false, cancelled: true, message: "流程已停止，保留已完成订单" };
  log("info", "本单已完成，正在返回薪火任务广场继续检测下一单");
  await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
  if (!current()) return { ok: false, cancelled: true };
  await waitForTabComplete(xinhuoTab.id);
  if (!runtimeState.running || runtimeState.runId !== runId) return { ok: false, cancelled: true, message: "流程已变化，未清理其他运行的订单" };
  clearCompletedXinhuoTaskState();
  if (runtimeState.mode === "debug") return resumeXinhuoAutoAfterDebug(runId, "after_submit");
  return runNextXinhuoTask("after_submit", { marketplaceReady: true });
}

async function resumeXinhuoAutoAfterDebug(runId, reason) {
  if (!isActiveRun(runId, "debug")) return { ok: false, error: "接管流程已停止，未启动下一轮" };
  const state = runtimeState;
  const current = () => runtimeState === state && isActiveRun(runId, "debug");
  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    if (!current()) return { ok: false, cancelled: true };
    return { ...await blockXinhuoConfiguration(error.message), queueFinished: true };
  }
  if (!current()) return { ok: false, cancelled: true, error: "流程已停止，未启动下一轮" };
  if (settings.replyMode !== "post" || !settings.autoSubmitXinhuo || !settings.aiApiKey) {
    const message = "本单已完成并返回广场；自动发送、自动提交或 AI 配置未就绪，未启动下一轮";
    return { ...finishRun(message), queueFinished: true, message };
  }
  runtimeState.mode = "auto";
  await persistRuntimeState(true);
  if (!isActiveRun(runId)) return { ok: false, cancelled: true };
  await ensureXinhuoKeepalive();
  if (!isActiveRun(runId)) return { ok: false, error: "流程已停止，未启动下一轮" };
  const schedule = getScheduleState(settings);
  if (!schedule.inWindow) {
    await enterScheduleWait(schedule);
    return { ok: true, queueFinished: true, message: "本单已完成，等待下个运行时段", state: runtimeState };
  }
  log("info", "接管订单已收尾，已交回自动接单循环");
  // The sidebar must finish its old step queue before a new order is processed.
  // runNext enforces task limits before scanning; never replay its trailing
  // "return to marketplace" step over a newly claimed order.
  void runNextXinhuoTask(reason, { marketplaceReady: true }).catch((error) => {
    if (isActiveRun(runId)) void stopWithFailure(error.message || String(error), "resume_failed");
  });
  return { ok: true, queueFinished: true, message: "本单已完成，已交回自动流程（按任务上限运行）", state: runtimeState };
}

function clearCompletedXinhuoTaskState() {
  runtimeState.currentTask = null;
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;
  runtimeState.lastXResult = null;
  runtimeState.completionEvidence = null;
}

async function maintainXinhuoXForeground(tabId, runId, control = {}) {
  const mode = runtimeState.mode;
  while (!control.stopped && isActiveRun(runId, mode)) {
    try {
      await focusXinhuoXTab(tabId);
    } catch (error) {
      if (!isActiveRun(runId, mode)) return;
      if (runtimeState.pendingXSubmission?.tabClosed) return;
      log("warn", `保持薪火目标 X 前台失败：${error.message || String(error)}`);
      return;
    }
    await delay(XINHUO_FOREGROUND_REFOCUS_MS);
  }
}

async function stopXinhuoRun({ manual = true } = {}) {
  if (runtimeState.stopping && stopXinhuoRunPromise) {
    const state = runtimeState;
    const stopping = stopXinhuoRunPromise;
    if (manual && !state.manuallyStopped) {
      state.manuallyStopped = true;
      await Promise.all([stopping, persistRuntimeState(true)]);
      return runtimeState === state ? state : null;
    }
    return stopping;
  }
  const previous = runtimeState;
  const state = { ...createInitialState(), stage: "stopped", manuallyStopped: manual, stopping: true };
  runtimeState = state;
  for (const controller of activeAIRequests) controller.abort(new Error("任务已停止"));
  activeAIRequests.clear();
  directXinhuoXOpen = null;
  xinhuoMarketplaceTabPromise = null;
  manualDebugCommandTail = Promise.resolve();
  const current = () => runtimeState === state;
  const targets = new Map();
  const cancel = (tabId, type, runId) => {
    if (Number.isInteger(tabId)) targets.set(`${tabId}:${type}:${runId}`, { tabId, type, runId });
  };
  cancel(previous.xinhuoTabId, "CANCEL_XINHUO_RUN", previous.runId);
  cancel(previous.pendingXOpen?.xinhuoTabId, "CANCEL_XINHUO_RUN", previous.runId);
  cancel(previous.xTabId, "CANCEL_X_RUN", previous.runId);
  cancel(previous.pendingXSubmission?.tabId, "CANCEL_X_RUN", previous.runId);
  if (previous.uncertainAction) {
    const intent = previous.uncertainAction;
    cancel(intent.tabId, /^(?:RUN_X_|COMPLETE_X_)/.test(intent.type) ? "CANCEL_X_RUN" : "CANCEL_XINHUO_RUN", intent.runId);
  }
  // Queue the empty snapshot immediately, but never delay page cancellation
  // behind a slow or failed storage write.
  const saving = persistRuntimeState(true).then(() => null, error => error);
  const stopping = Promise.resolve().then(async () => {
    try {
      await Promise.allSettled([clearXinhuoKeepalive(), ...Array.from(targets.values(), target =>
        sendToTab(target.tabId, { type: target.type, runId: target.runId, reset: true }))]);
      const persistenceError = await saving;
      if (persistenceError) {
        throw new Error(`停止状态保存失败：${persistenceError.message || String(persistenceError)}；已取消页面动作并清空内存中的运行记录`);
      }
      return current() ? state : null;
    } finally {
      if (current()) state.stopping = false;
    }
  });
  stopXinhuoRunPromise = stopping;
  try {
    return await stopping;
  } finally {
    if (stopXinhuoRunPromise === stopping) stopXinhuoRunPromise = null;
  }
}

async function blockXinhuoConfiguration(message) {
  const state = runtimeState;
  state.running = false;
  clearXinhuoXOpenWatch();
  clearXinhuoXSubmission();
  setStage("config_missing");
  log("error", message);
  await clearXinhuoKeepalive();
  return { ok: false, error: message, state: runtimeState };
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
  const state = runtimeState;
  const runId = runtimeState.runId;
  const current = () => runtimeState === state && isActiveRun(runId);
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
    if (!current()) return { ok: false, cancelled: true };
    runtimeState.xinhuoTabId = xinhuoTab.id;
    runtimeState.currentTask = null;
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
    runtimeState.lastXResult = null;
    await chrome.tabs.update(xinhuoTab.id, { url: XINHUO_TASKS_URL, active: true });
    if (!current()) return { ok: false, cancelled: true };
    await waitForTabComplete(xinhuoTab.id);
    if (!isActiveRun(runId)) return { ok: false, state: runtimeState };
    return runNextXinhuoTask(`recover_after_${failedStage}`, { marketplaceReady: true });
  } catch (error) {
    if (!current()) return { ok: false, cancelled: true };
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
  const state = runtimeState;
  const controller = new AbortController();
  const current = () => runtimeState === state && state.running && state.runId === runId && !controller.signal.aborted;
  activeAIRequests.add(controller);
  try {
  const settings = await getSettings();
  if (!current()) throw new Error("任务已停止，取消 AI 请求");
  if (!settings.aiApiKey) throw new Error("尚未配置 AI API Key，请在侧栏重新填写并保存");
  const taskMinChineseChars = Number(task?.minReplyChineseChars) || 10;
  log("info", describeXinhuoReplyRule(settings, taskMinChineseChars));
  const result = await generateLighthouseAIReply({
    provider: settings.aiProvider,
    model: settings.aiModel,
    apiUrl: settings.aiApiUrl,
    apiKey: settings.aiApiKey,
    systemPrompt: settings.aiSystemPrompt
  }, {
    ...(tweet || {}),
    url: tweet?.url || task?.tweetUrl || ""
  }, { minChineseChars: taskMinChineseChars, signal: controller.signal, timeout: XINHUO_AI_TIMEOUT_MS });
  if (controller.signal.aborted || runId !== runtimeState.runId || !runtimeState.running) throw new Error("任务已停止，丢弃 AI 结果");
  await recordAIReplyDiagnostics(result, tweet, task);
  if (!current()) throw new Error("任务已停止，丢弃 AI 结果");
  if ((result.diagnostics || []).length) logReplyDiagnostics(result.diagnostics);
  log("info", `已生成薪火回复：${result.replyText}`);
  return { ok: true, ...result };
  } catch (error) {
    const message = error?.message || String(error);
    if (current() && !/任务已停止|丢弃 AI 结果/.test(message)) {
      const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics : [];
      await recordReplyDiagnosticHistory(buildReplyFailureRecord(
        isAIReplyFailureType(error?.failureType) ? error.failureType : getAIReplyFailureType(diagnostics),
        message,
        task,
        tweet,
        diagnostics
      ));
    }
    throw error;
  } finally {
    activeAIRequests.delete(controller);
  }
}

function describeXinhuoReplyRule(settings, taskMinChineseChars) {
  const prompt = String(settings?.aiSystemPrompt || XINHUO_DEFAULT_AI_SYSTEM_PROMPT).trim();
  const range = getReplyLengthRange(prompt, { minChineseChars: taskMinChineseChars });
  const source = prompt === XINHUO_DEFAULT_AI_SYSTEM_PROMPT ? "默认 Prompt" : "自定义 Prompt";
  return `薪火 AI 回复规则：${source} · 中文 ${range.min}-${range.max} 字 · 任务最低 ${taskMinChineseChars} 字`;
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
  const task = state?.running ? null : state?.currentTask;
  const detailPath = normalizeXinhuoTaskPath(task?.detailPath || task?.taskKey);
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  if (!task?.claimed || !detailPath || !tweetUrl) return null;
  return { ...task, taskKey: detailPath, detailPath, tweetUrl };
}

async function findRecoverableClaimedXinhuoTask(savedTask) {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  if (!savedTask) return null;
  const query = {};
  if (Number.isInteger(runtimeState.windowId)) query.windowId = runtimeState.windowId;
  const tabs = (await chrome.tabs.query(query)).filter((tab) => {
    return normalizeXinhuoTaskPath(tab.url) === savedTask.detailPath;
  });
  if (!current()) return null;
  for (const tab of tabs) {
    const inspected = await sendToTab(tab.id, {
      type: "XINHUO_INSPECT_CURRENT_TASK",
      runId: runtimeState.runId,
      task: savedTask
    });
    if (!current()) return null;
    const inspectedTask = inspected?.task;
    if (!inspected?.ok || !inspectedTask?.claimed) continue;
    if (normalizeXinhuoTaskPath(inspectedTask.detailPath || inspectedTask.taskKey) !== savedTask.detailPath) continue;
    if (normalizeTweetUrl(inspectedTask.tweetUrl) !== savedTask.tweetUrl) continue;
    return { tab, task: mergeXinhuoTask(savedTask, inspectedTask) };
  }
  return null;
}

async function inspectInterruptedXinhuoOrder(savedTask, options = {}) {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  const cancelled = () => ({ kind: "unknown", cancelled: true, message: "流程已停止，取消旧订单核对" });
  const detailPath = normalizeXinhuoTaskPath(savedTask?.detailPath || savedTask?.taskKey);
  const tweetUrl = normalizeTweetUrl(savedTask?.tweetUrl);
  if (!detailPath || !tweetUrl) return { kind: "unknown", message: "中断订单缺少详情或目标 X 身份" };

  let tab = await getOrCreateXinhuoTab();
  if (!current()) return cancelled();
  assertXinhuoTab(tab, "恢复前核对薪火订单");
  if (normalizeXinhuoTaskPath(tab.url) !== detailPath) {
    tab = await chrome.tabs.update(tab.id, {
      url: new URL(detailPath, XINHUO_TASKS_URL).href,
      active: options.activate !== false
    });
    if (!current()) return cancelled();
    await waitForTabComplete(tab.id);
    if (!current()) return cancelled();
  }
  const inspection = await sendToTab(tab.id, {
    type: "XINHUO_INSPECT_CURRENT_TASK",
    runId: runtimeState.runId,
    task: savedTask
  });
  if (!current()) return cancelled();
  if (inspection?.claimed === false) {
    return { kind: "released", tab, message: inspection.message || "薪火官网未保留该已接订单" };
  }

  const task = inspection?.task;
  if (!inspection?.ok || !task?.claimed) {
    return { kind: "unknown", tab, message: inspection?.message || "无法确认中断薪火订单状态" };
  }
  if (normalizeXinhuoTaskPath(task.detailPath || task.taskKey) !== detailPath
      || normalizeTweetUrl(task.tweetUrl) !== tweetUrl) {
    return { kind: "unknown", tab, message: "薪火详情身份与中断订单不一致" };
  }
  const officialState = task.officialState || null;
  if (officialState?.final) {
    return {
      kind: officialState.success === false || officialState.kind === "failed" ? "failed" : "completed",
      tab,
      task: mergeXinhuoTask(savedTask, task),
      message: officialState.message || "薪火官网已给出中断订单终态"
    };
  }
  return { kind: "claimed", tab, task: mergeXinhuoTask(savedTask, task), message: officialState?.message || "薪火订单仍在进行中" };
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
  runtimeState.uncertainAction = null;
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
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  if (!current()) return null;
  let remembered = null;
  if (Number.isInteger(runtimeState.xinhuoTabId)) {
    try {
      const candidate = await chrome.tabs.get(runtimeState.xinhuoTabId);
      if (!current()) return null;
      const runtimeWindowId = Number.isInteger(runtimeState.windowId) ? runtimeState.windowId : null;
      if (isXinhuoUrl(candidate.url) && (!runtimeWindowId || candidate.windowId === runtimeWindowId)) {
        remembered = candidate;
      } else {
        log("warn", `丢弃非薪火的残留任务标签（非当前窗口或地址不匹配）：tab=${candidate.id} · ${candidate.url || "about:blank"}`);
      }
    } catch (_) {
      if (!current()) return null;
      // The remembered tab may have been closed while the service worker slept.
    }
    if (!remembered) runtimeState.xinhuoTabId = null;
  }

  const query = {};
  if (Number.isInteger(runtimeState.windowId)) query.windowId = runtimeState.windowId;
  else if (Number.isInteger(remembered?.windowId)) query.windowId = remembered.windowId;
  const queriedTabs = (await chrome.tabs.query(query)).filter((tab) => isXinhuoUrl(tab.url));
  if (!current()) return null;
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
        if (current()) log("warn", `清理重复薪火任务广场标签失败：tab=${tab.id} · ${error.message || String(error)}`);
      })
    )));
    if (!current()) return null;
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
  const pending = ensureXinhuoMarketplaceTabOnce();
  xinhuoMarketplaceTabPromise = pending;
  try {
    return await pending;
  } finally {
    if (xinhuoMarketplaceTabPromise === pending) xinhuoMarketplaceTabPromise = null;
  }
}

async function ensureXinhuoMarketplaceTabOnce() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!current()) return null;
    const tab = await getOrCreateXinhuoTab();
    if (!current()) return null;
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
  const state = runtimeState;
  const mode = state.mode;
  const current = () => runtimeState === state && isActiveRun(runId, mode);
  const boundTab = await getBoundMatchingXinhuoXTab(tweetUrl);
  if (!current()) return null;
  if (boundTab) return boundTab;
  if (runtimeState.pendingXOpen) runtimeState.pendingXOpen.claimStartedAt = Number(task.claimStartedAt) || Date.now();
  log("info", "等待薪火网站自动打开任务目标 X");
  const deadline = Date.now() + XINHUO_SITE_X_OPEN_WAIT_MS;
  while (Date.now() < deadline) {
    if (!current()) return null;
    const siteOpenedTab = consumeXinhuoOpenedXTab(tweetUrl) || await findTargetXTab(tweetUrl, openerTabId);
    if (!current()) return null;
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

  if (!current()) return null;
  log("warn", "薪火网站未自动打开目标 X，扩展将补开任务页面");
  return openXinhuoFallbackXTab(task, openerTabId, runId);
}

async function openXinhuoFallbackXTab(task, openerTabId, runId) {
  const state = runtimeState;
  const mode = state.mode;
  const current = () => runtimeState === state && isActiveRun(runId, mode);
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  const taskKey = getXinhuoTaskIdentity(task) || tweetUrl;
  if (!tweetUrl || !taskKey) return null;
  const bound = await getBoundMatchingXinhuoXTab(tweetUrl);
  if (!current()) return null;
  if (bound) return bound;
  if (directXinhuoXOpen?.taskKey === taskKey) return directXinhuoXOpen.promise;
  if (directXinhuoXOpen) {
    await directXinhuoXOpen.promise.catch(() => null);
    if (!current()) return null;
    const rebound = await getBoundMatchingXinhuoXTab(tweetUrl);
    if (!current()) return null;
    if (rebound) return rebound;
  }

  const opening = (async () => {
    const rebound = await getBoundMatchingXinhuoXTab(tweetUrl);
    if (!current()) return null;
    if (rebound) return rebound;
    if (!current() || getXinhuoTaskIdentity(runtimeState.currentTask) !== taskKey) return null;
    const siteOpenedTab = consumeXinhuoOpenedXTab(tweetUrl) || await findTargetXTab(tweetUrl, openerTabId);
    if (!current()) return null;
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
    if (!current()) return null;
    await focusXinhuoXTab(tab.id, tab.windowId);
    if (!current()) return null;
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
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  if (!Number.isInteger(runtimeState.xTabId)) return null;
  try {
    const tab = await chrome.tabs.get(runtimeState.xTabId);
    if (!current()) return null;
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
    if (!current()) return null;
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

async function recordXinhuoClaimIntent(message, sender) {
  const state = runtimeState;
  const task = message.task;
  const taskKey = getXinhuoTaskIdentity(task);
  const active = () => runtimeState === state && state.running && message.runId === state.runId
    && sender?.tab?.id === state.xinhuoTabId;
  const reject = (reason) => ({ ok: false, failureType: "claim_guard_rejected", error: `接单校验失败：${reason}，未点击接取` });
  if (!active()) return reject("运行或标签页已变化");
  if (!taskKey) return reject("缺少订单详情身份");
  if (state.uncertainAction) return reject("已有动作待核对");
  if ((sender.frameId ?? 0) !== 0 || (sender.documentLifecycle && sender.documentLifecycle !== "active")) {
    return reject("消息不来自当前活动主页面");
  }
  // sender.url can retain the document's initial marketplace URL after an SPA
  // transition. Verify the current tab and the originating document instead.
  let tab, documentState;
  try {
    tab = await chrome.tabs.get(sender.tab.id);
    const target = sender.documentId ? { documentId: sender.documentId } : { frameId: 0 };
    documentState = await chrome.tabs.sendMessage(sender.tab.id, { type: "CHECK_XINHUO_CONTENT" }, target);
  } catch (error) {
    return reject(`无法核对当前页面：${error.message || String(error)}`);
  }
  if (!active() || state.uncertainAction) return reject("核对期间流程已变化");
  const tabPath = /^https:\/\/xinhuo123\.com\//.test(tab.url || "") ? normalizeXinhuoTaskPath(tab.url) : "";
  if (tab.pendingUrl || tabPath !== taskKey) return reject(`当前标签页不是目标详情 ${taskKey}`);
  if (!documentState?.ok || documentState.claimProtocol !== 1 || documentState.path !== taskKey) {
    return reject(`原页面已离开目标详情 ${taskKey}`);
  }
  if (state.mode !== "debug" || requiresXinhuoAIReply(task)) {
    let settings;
    try {
      settings = await getSettings();
    } catch (error) {
      return reject(error.message);
    }
    if (!active() || state.uncertainAction) return reject("读取配置期间流程已变化");
    if (!settings.aiApiKey) return reject("尚未配置 AI API Key，请重新填写并保存");
  }
  if (normalizeXinhuoTaskPath(sender.url) !== taskKey) {
    log("info", `已核对页面内跳转后的接单身份：消息来源 ${new URL(sender.url).pathname}，当前订单 ${taskKey}`);
  }
  const intent = { type: "XINHUO_CLAIM", protocol: 1, taskKey,
    runId: message.runId, tabId: sender.tab.id, documentId: sender.documentId || "" };
  state.currentTask = { ...task, claimed: false };
  state.uncertainAction = intent;
  // Do not acknowledge until the order identity survives a worker restart.
  try {
    await persistRuntimeState(true);
  } catch (error) {
    if (state.uncertainAction === intent) delete state.uncertainAction;
    throw error;
  }
  if (runtimeState !== state || !state.running || state.runId !== message.runId) {
    if (state.uncertainAction === intent) {
      delete state.uncertainAction;
      await persistRuntimeState(true);
    }
    return { ok: false, error: "流程已停止，未授权接单" };
  }
  setStage("claiming_task");
  return { ok: true, taskKey };
}

async function ensureXinhuoContentReady(tabId, settings = {}) {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  const version = chrome.runtime.getManifest().version;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current()) throw new Error("流程已停止，取消页面连接");
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "CHECK_XINHUO_CONTENT", settings });
      if (!current()) throw new Error("流程已停止，取消页面连接");
      if (result?.ok && result.version === version && result.claimProtocol === 1) return result;
      lastError = new Error("页面脚本版本不匹配或未支持接单确认协议");
    } catch (error) { lastError = error; }
    if (!current()) throw new Error("流程已停止，取消页面连接");
    if (attempt < 2) {
      if (!(await injectContentScript(tabId))) break;
      await delay(250);
    }
  }
  throw new Error(`薪火页面连接未就绪（tab=${tabId}）：${lastError?.message || "页面无响应"}`);
}

async function checkXinhuoConnection(windowId) {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  const cancelled = () => ({ ok: false, cancelled: true, error: "流程已停止，取消旧连接检查" });
  if (!current()) return cancelled();
  const intent = state.uncertainAction;
  const query = { url: "https://xinhuo123.com/*" };
  if (Number.isInteger(windowId)) query.windowId = windowId;
  const tabs = await chrome.tabs.query(query);
  if (!current()) return cancelled();
  let tab = tabs.find((item) => item.active && isXinhuoMarketplaceUrl(item.url))
    || tabs.find((item) => isXinhuoMarketplaceUrl(item.url));
  if (!tab) return { ok: false, error: "请在当前窗口打开薪火任务广场，再检查连接" };
  const settings = toContentSettings(await getSettings());
  if (!current()) return cancelled();
  const legacyScan = !state.running && intent?.type === "XINHUO_SELECT_AND_CLAIM"
    && !intent.protocol && !intent.taskKey && !state.currentTask?.claimed;
  if (legacyScan) {
    log("warn", "检测到旧版遗留的扫描锁，先终止旧扫描并只读核对官网进行中订单");
    let sourceTab = null;
    try { sourceTab = await chrome.tabs.get(intent.tabId); }
    catch (error) {
      if (!/No tab|Invalid tab/i.test(String(error?.message || error))) throw error;
    }
    if (!current()) return cancelled();
    if (sourceTab) {
      if (!isXinhuoMarketplaceUrl(sourceTab.url) || sourceTab.windowId !== tab.windowId) {
        return { ok: false, error: "旧扫描页面已进入详情或位于其他窗口，保留锁定，请先核对该页订单" };
      }
      tab = sourceTab;
    }
    // Reload only a marketplace, never an order detail. This ends any orphaned
    // old-version polling loop before the official account counters are read.
    await chrome.tabs.reload(tab.id);
    if (!current()) return cancelled();
    await waitForTabComplete(tab.id);
    if (!current()) return cancelled();
  }
  let snapshot = await ensureXinhuoContentReady(tab.id, settings);
  if (!current()) return cancelled();
  for (let attempt = 0; attempt < 40 && !snapshot.accountReady; attempt += 1) {
    await delay(250);
    if (!current()) return cancelled();
    snapshot = await ensureXinhuoContentReady(tab.id, settings);
    if (!current()) return cancelled();
  }
  if (!snapshot.accountReady) {
    return { ok: false, error: "页面已连接，但官网账号数据尚未加载完成；未判定可接任务，已保留现有订单保护，请稍后重试" };
  }
  if (legacyScan) {
    if (runtimeState !== state || state.running || state.uncertainAction !== intent) {
      return { ok: false, error: "检查期间流程已变化，未解除旧锁" };
    }
    if (!snapshot.idleConfirmed) {
      return { ok: false, error: "官网未确认进行中、待复核、验证中均为 0，已保留旧扫描锁" };
    }
    state.lastScanRecovery = { intent: { ...intent }, tabId: tab.id, snapshot, at: Date.now() };
    delete state.uncertainAction;
    state.currentTask = null;
    state.xinhuoTabId = tab.id;
    await persistRuntimeState(true);
    if (!current()) return cancelled();
    log("info", "官网确认进行中 0、待复核 0、验证中 0；已解除旧版遗留扫描锁，保持停止，可重新启动");
  }
  const message = `页面连接正常 · v${snapshot.version} · 识别 ${snapshot.total} 笔任务，官网可立即接取 ${snapshot.ready} 笔，符合赏金设置 ${snapshot.eligible} 笔，冷却 ${snapshot.cooling} 笔`;
  log("info", message);
  if (state.uncertainAction) {
    return { ok: false, error: `${message}；仍有待核对动作 ${state.uncertainAction.type}，未解除订单保护` };
  }
  return { ok: true, message, snapshot };
}

async function sendToTab(tabId, payload) {
  payload = { ...payload, platform: "xinhuo", task: payload.task || runtimeState.currentTask };
  const claimsOrder = ["XINHUO_SELECT_AND_CLAIM", "DEBUG_XINHUO_CLAIM_CURRENT_TASK"].includes(payload.type);
  // Scanning has no irreversible effect. Only the page's claim-intent handshake
  // may persist an unknown action, immediately before the actual claim click.
  const ownClaimIntent = () => {
    const intent = runtimeState.uncertainAction;
    return claimsOrder && intent?.runId === payload.runId && intent?.tabId === tabId ? intent : null;
  };
  const sentState = runtimeState;
  const sentRunId = runtimeState.runId;
  const stale = () => runtimeState !== sentState || runtimeState.runId !== sentRunId;
  const readOnlyOrCancel = /^(?:CANCEL_|XINHUO_INSPECT_|CHECK_|READ_)/.test(payload.type)
    || payload.type === "XINHUO_WAIT_FOR_SUBMISSION_RESULT";
  if (!payload.type.startsWith("CANCEL_") && (runtimeState.manuallyStopped
      || (payload.runId && (payload.runId !== runtimeState.runId || !runtimeState.running)))) {
    return { ok: false, cancelled: true, message: "旧流程已停止" };
  }
  if (runtimeState.uncertainAction && !readOnlyOrCancel) {
    return { ok: false, uncertain: true, message: "旧动作结果未知，禁止重复执行，请先核对本单" };
  }
  if (payload.settings) payload.settings = toContentSettings(payload.settings);
  if (claimsOrder) {
    try { await ensureXinhuoContentReady(tabId); }
    catch (error) {
      if (!stale()) {
        runtimeState.running = false;
        setStage("connection_failed");
        log("error", error.message || String(error));
      }
      return { ok: false, message: error.message || String(error) };
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (payload.runId && !payload.type.startsWith("CANCEL_") &&
        (payload.runId !== runtimeState.runId || !runtimeState.running)) {
      return { ok: false, cancelled: true, message: "流程已停止，不再重试旧消息" };
    }
    try {
      if (runtimeState.uncertainAction && runtimeState.uncertainAction !== ownClaimIntent() && !readOnlyOrCancel) {
        return { ok: false, uncertain: true, message: "旧动作结果未知，禁止重复执行，请先核对本单" };
      }
      const result = await chrome.tabs.sendMessage(tabId, payload);
      if (!payload.type.startsWith("CANCEL_") && (stale() || (payload.runId && !runtimeState.running))) {
        return { ok: false, cancelled: true, message: "流程已变化，未采用旧回执" };
      }
      const claimIntent = ownClaimIntent();
      if (claimIntent) {
        const matchingTask = getXinhuoTaskIdentity(result?.task) === claimIntent.taskKey;
        if (matchingTask && result?.task?.claimed) {
          runtimeState.currentTask = mergeXinhuoTask(runtimeState.currentTask, result.task);
        } else if (!(matchingTask && result?.ok === false && result.retryable && result.returnToMarketplace && result.task?.claimed === false)) {
          runtimeState.running = false;
          setStage("action_result_unknown");
          return { ok: false, uncertain: true, message: "接单回执未确认订单状态，已保留执行意图，请先核对本单" };
        }
        delete runtimeState.uncertainAction;
        try { await persistRuntimeState(true); }
        catch (error) {
          if (!stale()) runtimeState.uncertainAction = claimIntent;
          throw error;
        }
        if (stale() || (payload.runId && !runtimeState.running)) {
          return { ok: false, cancelled: true, message: "流程已变化，订单已保存但不再继续旧流程" };
        }
      }
      return result;
    } catch (error) {
      if (!payload.type.startsWith("CANCEL_") && stale()) {
        return { ok: false, cancelled: true, message: "流程已变化，未将旧错误写入当前任务" };
      }
      if (runtimeState.pendingXSubmission?.tabId === tabId && runtimeState.pendingXSubmission?.tabClosed) {
        return { ok: false, tabClosedAfterSubmission: true };
      }
      if (payload.type.startsWith("CANCEL_") && (isMissingReceiver(error) || /No tab with id|tab.*closed/i.test(String(error?.message || error)))) {
        return { ok: true, receiverAbsent: true };
      }
      if (claimsOrder && !ownClaimIntent() && !isMissingReceiver(error)) {
        return { ok: false, retryable: true, returnToMarketplace: true,
          task: { claimed: false }, message: "扫描页面已断开，尚未授权接单，可重新检测" };
      }
      if (isMissingReceiver(error) && !ownClaimIntent()) {
        const injected = await injectContentScript(tabId);
        if (injected) await delay(300);
      } else if (!readOnlyOrCancel) {
        runtimeState.uncertainAction = ownClaimIntent() || { type: payload.type, taskKey: payload.task?.taskKey || "", runId: payload.runId, tabId };
        runtimeState.running = false;
        runtimeState.stage = "action_result_unknown";
        await persistRuntimeState(true);
        if (stale()) return { ok: false, cancelled: true };
        log("error", `动作 ${payload.type} 的回执丢失，结果未知；已停止，禁止自动重发，请先核对本单`);
        return { ok: false, uncertain: true, message: "动作可能已执行，回执丢失，未自动重试" };
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
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  try {
    if (!current()) return false;
    const tab = await chrome.tabs.get(tabId);
    if (!current()) return false;
    const file = /^https:\/\/xinhuo123\.com\//i.test(tab.url || "")
      ? "src/content/xinhuo.js"
      : (/^https:\/\/(?:x|twitter)\.com\//i.test(tab.url || "") ? "src/content/x.js" : "");
    if (!file) return false;
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    if (!current()) return false;
    log("warn", `已为标签页补注入脚本：${file}（tab=${tabId}）`);
    return true;
  } catch (error) {
    if (current()) log("warn", `页面脚本注入失败（tab=${tabId}）：${error.message || String(error)}`);
    return false;
  }
}

async function waitForTabComplete(tabId) {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  for (let index = 0; index < 40; index += 1) {
    if (!current()) return false;
    const tab = await chrome.tabs.get(tabId);
    if (!current()) return false;
    if (tab.status === "complete") return true;
    await delay(250);
  }
  return false;
}

function isActiveRun(runId, mode = "auto") {
  return Boolean(runtimeState.running && ["auto", "debug"].includes(mode)
    && runtimeState.mode === mode && runtimeState.runId === runId);
}

function getAttemptedTaskRecords() {
  const now = Date.now();
  runtimeState.attemptedTasks = (runtimeState.attemptedTasks || []).filter((item) => item.expiresAt > now);
  return runtimeState.attemptedTasks.map((item) => ({ key: item.key, expiresAt: item.expiresAt }));
}

function getAttemptedTaskKeys() {
  return getAttemptedTaskRecords().map((item) => item.key);
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
  const retryAt = Number(task?.retryAt) || 0;
  const expiresAt = retryAt > Date.now() ? retryAt : Date.now() + ATTEMPT_DEDUPE_MS;
  runtimeState.attemptedTasks = [
    ...(runtimeState.attemptedTasks || []).filter((item) => item.expiresAt > Date.now() && !keys.includes(item.key)),
    ...keys.map((key) => ({ key, expiresAt }))
  ].slice(-100);
  if (fresh.length) {
    const waitMs = Math.max(0, expiresAt - Date.now());
    const strategy = retryAt > Date.now()
      ? `${formatXinhuoRetryDelay(waitMs)} 后重新检测（下次放号前 1 分钟）`
      : `已登记去重 ${Math.round(ATTEMPT_DEDUPE_MS / 60000)} 分钟`;
    log("info", `${strategy}：${describeXinhuoTaskForLog(task)}`);
  }
}

function formatXinhuoRetryDelay(ms) {
  const seconds = Math.max(0, Math.ceil(Number(ms) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
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

async function getReplyDiagnosticRecords() {
  const stored = await chrome.storage.local.get([REPLY_DIAGNOSTIC_HISTORY_KEY]);
  return (Array.isArray(stored[REPLY_DIAGNOSTIC_HISTORY_KEY]) ? stored[REPLY_DIAGNOSTIC_HISTORY_KEY] : [])
    .map(normalizeXinhuoReplyDiagnosticRecord)
    .filter(Boolean)
    .slice(0, MAX_REPLY_HISTORY_RECORDS);
}

async function getCombinedReplyRecords() {
  const [replies, diagnostics] = await Promise.all([getReplyHistoryRecords(), getReplyDiagnosticRecords()]);
  return [...replies, ...diagnostics]
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
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
  const state = runtimeState;
  const runId = state.runId;
  if (state.manuallyStopped) return;
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
  if (runtimeState !== state || state.runId !== runId || state.manuallyStopped) return;
  const next = [record, ...prior.filter((item) => {
    const sameTweet = record.tweetUrl && normalizeTweetUrl(item.tweetUrl) === record.tweetUrl;
    const sameTask = record.taskKey && getXinhuoTaskIdentity(item) === record.taskKey;
    return !sameTweet && !sameTask;
  })].slice(0, MAX_REPLY_HISTORY_RECORDS);
  await chrome.storage.local.set({ [REPLY_HISTORY_KEY]: next });
}

async function recordAIReplyDiagnostics(result, tweet, task) {
  const failures = Array.isArray(result?.diagnostics) ? result.diagnostics.filter((item) => !item?.ok) : [];
  if (!failures.length) return;
  const hasTimeout = failures.some((item) => item.reason === "timeout");
  const hasInvalidOutput = failures.some((item) => !["timeout", "api_error"].includes(item.reason));
  const failureType = hasTimeout ? "ai_timeout" : (hasInvalidOutput ? "ai_invalid_output" : "ai_api_error");
  const latest = failures.at(-1) || {};
  await recordReplyDiagnosticHistory(buildReplyFailureRecord(
    failureType,
    latest.reasonText || "AI 生成未通过，已使用兜底回复",
    task,
    tweet,
    failures
  ));
}

function getAIReplyFailureType(diagnostics = []) {
  const failures = Array.isArray(diagnostics) ? diagnostics.filter((item) => !item?.ok) : [];
  if (failures.some((item) => item.reason === "timeout")) return "ai_timeout";
  if (failures.some((item) => !["api_error"].includes(item.reason))) return "ai_invalid_output";
  return "ai_api_error";
}

function isAIReplyFailureType(value) {
  return ["ai_timeout", "ai_invalid_output", "ai_api_error"].includes(String(value || ""));
}

function buildReplyFailureRecord(failureType, message, task = runtimeState.currentTask || {}, tweet = {}, diagnostics = []) {
  const labels = {
    ai_timeout: "AI 请求超时",
    ai_invalid_output: "AI 输出不合规",
    ai_api_error: "AI 接口异常",
    x_send_failed: "X 页面填入/发送失败"
  };
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    platform: "xinhuo",
    kind: "diagnostic",
    failureType: labels[failureType] ? failureType : "x_send_failed",
    failureLabel: labels[failureType] || labels.x_send_failed,
    failureMessage: String(message || "未知失败").slice(0, 280),
    diagnostics: Array.isArray(diagnostics) ? diagnostics.slice(-6).map((item) => ({
      stage: String(item?.stage || ""),
      reason: String(item?.reason || ""),
      reasonText: String(item?.reasonText || "").slice(0, 180)
    })) : [],
    taskKey: getXinhuoTaskIdentity(task),
    detailPath: normalizeXinhuoTaskPath(task?.detailPath || task?.taskKey),
    tweetUrl: normalizeTweetUrl(tweet?.url || task?.tweetUrl || ""),
    tweetText: String(tweet?.text || task?.detailText || task?.candidateTitle || "").slice(0, 500),
    taskType: task?.taskType || "评论",
    bounty: Number(task?.bounty || 0)
  };
}

async function recordReplyDiagnosticHistory(record) {
  const state = runtimeState;
  const runId = state.runId;
  if (state.manuallyStopped) return;
  const normalized = normalizeXinhuoReplyDiagnosticRecord(record);
  if (!normalized) return;
  const prior = await getReplyDiagnosticRecords();
  if (runtimeState !== state || state.runId !== runId || state.manuallyStopped) return;
  const next = [normalized, ...prior].slice(0, MAX_REPLY_HISTORY_RECORDS);
  await chrome.storage.local.set({ [REPLY_DIAGNOSTIC_HISTORY_KEY]: next });
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

function normalizeXinhuoReplyDiagnosticRecord(record) {
  if (!record || typeof record !== "object") return null;
  const failureType = String(record.failureType || "");
  const allowedTypes = new Set(["ai_timeout", "ai_invalid_output", "ai_api_error", "x_send_failed"]);
  if (!allowedTypes.has(failureType)) return null;
  return {
    id: String(record.id || `${record.createdAt || "diagnostic"}-${failureType}`),
    createdAt: String(record.createdAt || ""),
    platform: "xinhuo",
    kind: "diagnostic",
    failureType,
    failureLabel: String(record.failureLabel || failureType),
    failureMessage: String(record.failureMessage || "未知失败").slice(0, 280),
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics.slice(-6).map((item) => ({
      stage: String(item?.stage || ""),
      reason: String(item?.reason || ""),
      reasonText: String(item?.reasonText || "").slice(0, 180)
    })) : [],
    taskKey: getXinhuoTaskIdentity(record),
    detailPath: normalizeXinhuoTaskPath(record.detailPath || record.taskKey),
    tweetUrl: normalizeTweetUrl(record.tweetUrl),
    tweetText: String(record.tweetText || "").slice(0, 500),
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
  // A suspended old read must not block STOP followed by a fresh START.
  while (true) {
    const revision = settingsOperationRevision;
    const snapshot = await readXinhuoSettingsSnapshot();
    const settings = await enqueueSettingsOperation(() => loadXinhuoSettings(snapshot), revision);
    if (settings !== null) return settings;
  }
}

function enqueueSettingsOperation(operation, expectedRevision = null) {
  const pending = settingsOperationTail.then(async () => {
    // Retry stale snapshots outside the queue without invalidating other readers.
    if (expectedRevision !== null && expectedRevision !== settingsOperationRevision) return null;
    try {
      return await operation();
    } finally {
      // Also invalidate snapshots taken during a partially failed SAVE.
      settingsOperationRevision += 1;
    }
  });
  settingsOperationTail = pending.catch(() => {});
  return pending;
}

async function getTrustedLocalStorage() {
  const local = chrome.storage.local;
  if (!local?.get || !local?.set || !local?.setAccessLevel) {
    throw new Error("浏览器不支持受限 API Key 存储，请更新 Chrome 后重试");
  }
  try {
    await local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (_) {
    throw new Error("API Key 本地存储访问设置失败，请重试");
  }
  return local;
}

async function setStoredApiKey(local, apiKey) {
  try {
    await local.set({ [AI_API_KEY_STORAGE_KEY]: apiKey });
  } catch (_) {
    throw new Error("API Key 本地保存失败，未开始任务，请重试");
  }
}

async function persistXinhuoSettings(settings) {
  const { aiApiKey, ...persistentSettings } = settings;
  try {
    await chrome.storage.local.set({ settings: persistentSettings });
  } catch (_) {
    throw new Error("配置保存或旧 API Key 清理失败，请重试");
  }
}

async function readXinhuoSettingsSnapshot() {
  const local = await getTrustedLocalStorage();
  let stored;
  try {
    stored = await local.get(["settings", AI_API_KEY_STORAGE_KEY]);
  } catch (_) {
    throw new Error("API Key 或配置读取失败，请重试");
  }
  let sessionValues = {};
  // The dedicated local value, including an explicit clear, is authoritative.
  // Read the old session only while migrating; later restarts never depend on it.
  if (!Object.prototype.hasOwnProperty.call(stored, AI_API_KEY_STORAGE_KEY) && chrome.storage.session) {
    try {
      const session = chrome.storage.session;
      await session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      sessionValues = await session.get([AI_API_KEY_STORAGE_KEY]);
    } catch (_) {
      throw new Error("旧 API Key 会话迁移读取失败，请重试");
    }
  }
  return { local, sessionValues, stored };
}

// This loader runs only inside settingsOperationTail. Dedicated local storage
// wins over the old session and legacy settings, including an explicit empty key.
async function loadXinhuoSettings(snapshot) {
  const { local, sessionValues, stored } = snapshot || await readXinhuoSettingsSnapshot();
  const legacy = stored.settings || {};
  const settings = normalizeSettings(legacy);
  let apiKey = "";
  if (Object.prototype.hasOwnProperty.call(stored, AI_API_KEY_STORAGE_KEY)) {
    apiKey = String(stored[AI_API_KEY_STORAGE_KEY] || "").trim();
  } else {
    apiKey = Object.prototype.hasOwnProperty.call(sessionValues, AI_API_KEY_STORAGE_KEY)
      ? String(sessionValues[AI_API_KEY_STORAGE_KEY] || "").trim()
      : settings.aiApiKey;
    // Persist first, even when empty, so old credentials cannot revive later.
    await setStoredApiKey(local, apiKey);
  }
  const { aiApiKey, ...persistentSettings } = settings;
  if (JSON.stringify(legacy) !== JSON.stringify(persistentSettings)) await persistXinhuoSettings(settings);
  return { ...persistentSettings, aiApiKey: apiKey };
}

function saveXinhuoSettings(incoming) {
  return enqueueSettingsOperation(async () => {
    const current = await loadXinhuoSettings();
    const settings = normalizeSettings({ ...current, ...incoming, aiProvider: current.aiProvider });
    const hasKey = Object.prototype.hasOwnProperty.call(incoming, "aiApiKey");
    const apiKey = hasKey ? settings.aiApiKey : current.aiApiKey;
    if (hasKey) await setStoredApiKey(await getTrustedLocalStorage(), apiKey);
    await persistXinhuoSettings(settings);
    return { ...settings, aiApiKey: apiKey };
  });
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
  if (version < 5) {
    const currentPrompt = String(next.aiSystemPrompt || "").trim();
    if (currentPrompt === XINHUO_PREVIOUS_DEFAULT_AI_SYSTEM_PROMPT) {
      next.aiSystemPrompt = XINHUO_DEFAULT_AI_SYSTEM_PROMPT;
      changed = true;
    }
    next.settingsVersion = 5;
    changed = true;
  }
  return { settings: next, changed };
}

function normalizeSettings(settings) {
  const migrated = migrateSettings(settings).settings;
  const merged = { ...DEFAULT_SETTINGS, ...migrated };
  const aiApiUrl = "https://api.vayne.cc.cd/v1/responses";
  const aiApiKey = String(settings?.aiApiUrl || "").trim() === aiApiUrl
    ? String(merged.aiApiKey || "").trim() : "";
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
    settingsVersion: 5,
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
    aiModel: (String((providerModelAlias ? migrated.aiModel : merged.aiModel) || "").trim() || providerModelAlias
      || (aiProvider === "openai" ? DEFAULT_SETTINGS.aiModel : "")).slice(0, 128),
    aiApiUrl,
    aiApiKey,
    aiSystemPrompt: String(merged.aiSystemPrompt || XINHUO_DEFAULT_AI_SYSTEM_PROMPT).trim(),
    runWindowEnabled: merged.runWindowEnabled === true,
    runWindowStart: normalizeClock(merged.runWindowStart, DEFAULT_SETTINGS.runWindowStart),
    runWindowEnd: normalizeClock(merged.runWindowEnd, DEFAULT_SETTINGS.runWindowEnd)
  };
}

function toContentSettings(settings) {
  const allowed = ["actionDelayMs", "claimTimeoutMs", "cooldownPollMs", "xinhuoMinTaskBounty", "replyMode", "replyProvider", "readingSimulationMs", "autoSubmitXinhuo"];
  return {
    ...Object.fromEntries(allowed.filter((key) => Object.hasOwn(settings, key)).map((key) => [key, settings[key]])),
    lockSeatTimeoutMs: settings.claimTimeoutMs ?? settings.lockSeatTimeoutMs
  };
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
  return { running: false, mode: "idle", stage: "idle", completed: 0, failed: 0, attempts: 0, windowId: null, xinhuoTabId: null, xTabId: null, xTabWindowId: null, currentTask: null, lastXResult: null, completionEvidence: null, pendingXOpen: null, pendingXSubmission: null, attemptedTasks: [], scheduledResumeAt: 0, lastProgressAt: Date.now(), marketplaceNoClaimSince: 0, runId: createRunId(), logs: [] };
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
  if (runtimeState.manuallyStopped) return;
  runtimeState.stage = stage;
  persistRuntimeState();
}
function log(level, text, meta = null) {
  if (runtimeState.manuallyStopped) return;
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
    if (!saved || typeof saved !== "object") return;
    if (saved.manuallyStopped) {
      runtimeState = { ...createInitialState(), stage: "stopped", manuallyStopped: true };
      await clearXinhuoKeepalive();
      return;
    }
    const mayResume = saved.running === true && saved.mode === "auto" && !saved.uncertainAction;
    runtimeState = {
      ...createInitialState(),
      ...saved,
      running: false,
      mode: "idle",
      stage: mayResume ? "interrupted_not_resumed" : "stopped",
      logs: Array.isArray(saved.logs) ? saved.logs.slice(0, 120) : [],
      pendingXOpen: null,
      pendingXSubmission: null,
      claimRecoveryInFlight: false,
      claimRecoveryToken: null,
      stopping: false,
      runId: saved.runId || createRunId()
    };
    log("warn", mayResume ? "Chrome 后台恢复了中断的薪火状态，等待保活闹钟自动续跑（先核对订单）" : "已恢复薪火订单记录，保持停止状态");
    if (mayResume) await ensureXinhuoKeepalive();
  } catch (_) {
    // A missing or malformed snapshot should behave like a fresh idle worker.
  }
}

async function ensureXinhuoKeepalive() {
  const state = runtimeState;
  const runId = state.runId;
  try {
    if (runtimeState.manuallyStopped) return;
    if (typeof chrome === "undefined" || !chrome.alarms) return;
    await chrome.alarms.create(XINHUO_KEEPALIVE_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5
    });
    if ((runtimeState !== state || state.runId !== runId) && !(runtimeState.running && runtimeState.mode === "auto" && !runtimeState.manuallyStopped)) {
      await clearXinhuoKeepalive();
    }
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
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  if (!current()) return;
  if (runtimeState.running && runtimeState.mode === "auto") {
    // The alarm wake restarts the idle window; an API touch makes it deterministic.
    try { await chrome.runtime.getPlatformInfo(); } catch (_) {}
    if (!current()) return;
    if (shouldRestartXinhuoRunAfterNoClaim()
      && !runtimeState.marketplaceRefreshInFlight
      && Number.isInteger(runtimeState.xinhuoTabId)) {
      runtimeState.marketplaceRefreshInFlight = true;
      try {
        const windowId = runtimeState.windowId;
        const marketplaceTabId = runtimeState.xinhuoTabId;
        log("info", "薪火连续 5 分钟未接到订单，停止当前运行并重新执行全量检测");
        const stopped = await stopXinhuoRun({ manual: false });
        if (!stopped || runtimeState !== stopped || stopped.manuallyStopped) return;
        const stoppedRunId = stopped.runId;
        const restartCurrent = () => runtimeState === stopped && stopped.runId === stoppedRunId && !stopped.manuallyStopped;
        if (Number.isInteger(marketplaceTabId)) {
          await chrome.tabs.reload(marketplaceTabId);
          if (!restartCurrent()) return;
          await waitForTabComplete(marketplaceTabId);
          if (!restartCurrent()) return;
        }
        void startXinhuoRun(windowId, { automatic: true }).catch((error) => {
          if (runtimeState === stopped && !stopped.manuallyStopped) log("error", `薪火重新执行全量检测失败：${error.message || String(error)}`);
        });
      } catch (error) {
        if (current()) log("warn", `薪火停止并重新检测失败：${error.message || String(error)}`);
      } finally {
        if (current()) state.marketplaceRefreshInFlight = false;
      }
    }
    return;
  }
  if (await tryResumeXinhuoAfterInterruption()) return;
  if (!current()) return;
  if (runtimeState.mode === "idle" && runtimeState.stage === "claimed_task_recovery_blocked") return;
  await clearXinhuoKeepalive();
}

function shouldRestartXinhuoRunAfterNoClaim(now = Date.now()) {
  if (runtimeState.mode !== "auto" || runtimeState.stage !== "selecting_task" || runtimeState.currentTask || runtimeState.uncertainAction) {
    return false;
  }
  const marketplaceNoClaimSince = Number(runtimeState.marketplaceNoClaimSince || 0);
  return Number.isFinite(marketplaceNoClaimSince)
    && marketplaceNoClaimSince > 0
    && now - marketplaceNoClaimSince >= XINHUO_MARKETPLACE_IDLE_REFRESH_MS;
}

async function tryResumeXinhuoAfterInterruption() {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  if (!current()) return false;
  if (runtimeState.running) return true;
  if (runtimeState.uncertainAction) return false;
  if (runtimeState.mode !== "idle" || !["interrupted_not_resumed", "claimed_task_recovery_blocked"].includes(runtimeState.stage)) return false;
  const savedTask = runtimeState.currentTask || {};
  const hasClaimedIncompleteOrder = Boolean(savedTask.claimed && !runtimeState.completionEvidence);
  if (hasClaimedIncompleteOrder) {
    let inspection;
    try {
      inspection = await inspectInterruptedXinhuoOrder(savedTask, { activate: false });
    } catch (error) {
      if (!current()) return false;
      log("error", `service worker 重启后无法核对已接订单（${describeXinhuoTaskForLog(savedTask)}）：${error.message || String(error)}；已保留订单，不自动续跑`);
      return false;
    }
    if (!current()) return false;
    if (inspection.kind === "claimed") {
      runtimeState.xinhuoTabId = inspection.tab?.id || runtimeState.xinhuoTabId;
      runtimeState.currentTask = inspection.task || savedTask;
      setStage("claimed_task_recovery_blocked");
      log("error", `service worker 重启后订单仍在官网进行中（${describeXinhuoTaskForLog(savedTask)}）：${inspection.message}；已保留订单，不自动续跑`);
      return false;
    }
    if (inspection.kind === "unknown") {
      setStage("claimed_task_recovery_blocked");
      log("error", `service worker 重启后未能确认已接订单（${describeXinhuoTaskForLog(savedTask)}）：${inspection.message}；已保留订单，不自动续跑`);
      return false;
    }
    if (inspection.kind === "completed") {
      releaseXinhuoAttemptedTask(inspection.task || savedTask);
      if (!savedTask.completionCounted) runtimeState.completed += 1;
      log("info", `service worker 重启后确认旧订单已完成：${inspection.message}；清理旧订单并恢复任务广场扫描`);
    } else if (inspection.kind === "failed") {
      runtimeState.failed += 1;
      log("warn", `service worker 重启后确认旧订单未通过：${inspection.message}；清理旧订单并恢复任务广场扫描`);
    } else {
      log("warn", `service worker 重启后确认旧订单已不在进行中：${inspection.message}；清理旧订单并恢复任务广场扫描`);
    }
    clearCompletedXinhuoTaskState();
    clearXinhuoXOpenWatch();
    clearXinhuoXSubmission();
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
    if (!current()) return false;
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

function persistRuntimeState(requireSuccess = false, state = runtimeState) {
  const snapshot = {
    ...state,
    pendingXOpen: null,
    pendingXSubmission: null,
    claimRecoveryInFlight: false,
    claimRecoveryToken: null,
    stopping: false,
    logs: Array.isArray(state.logs) ? state.logs.slice(0, 120) : []
  };
  const write = runtimeStateWriteTail.then(() => chrome.storage.local.set({ [RUN_STATE_KEY]: snapshot }));
  runtimeStateWriteTail = write.catch(() => {});
  if (requireSuccess) return write;
}

async function focusXinhuoXTab(tabId, knownWindowId = null) {
  const state = runtimeState;
  const runId = state.runId;
  const current = () => runtimeState === state && state.runId === runId && !state.manuallyStopped;
  if (!current()) return null;
  if (!Number.isInteger(tabId)) throw new Error("缺少薪火目标 X 标签页，无法切到前台");
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (!current()) return null;
  const windowId = Number.isInteger(knownWindowId) ? knownWindowId : tab.windowId;
  if (Number.isInteger(windowId)) await chrome.windows.update(windowId, { focused: true });
  if (!current()) return null;
  runtimeState.xTabId = tab.id;
  return tab;
}

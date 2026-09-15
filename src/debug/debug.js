const fields = {
  runWindowEnabled: document.getElementById("runWindowEnabled"),
  runWindowStart: document.getElementById("runWindowStart"),
  runWindowEnd: document.getElementById("runWindowEnd"),
  xinhuoMinTaskBounty: document.getElementById("xinhuoMinTaskBounty"),
  claimTimeoutMs: document.getElementById("claimTimeoutMs"),
  cooldownPollMs: document.getElementById("cooldownPollMs"),
  maxTasksPerRun: document.getElementById("maxTasksPerRun"),
  maxTaskAttempts: document.getElementById("maxTaskAttempts"),
  replyMode: document.getElementById("replyMode"),
  autoSubmitXinhuo: document.getElementById("autoSubmitXinhuo"),
  actionDelayMs: document.getElementById("actionDelayMs"),
  aiModel: document.getElementById("aiModel"),
  aiApiUrl: document.getElementById("aiApiUrl"),
  aiApiKey: document.getElementById("aiApiKey"),
  aiSystemPrompt: document.getElementById("aiSystemPrompt")
};

const modeBadge = document.getElementById("modeBadge");
const stageBadge = document.getElementById("stageBadge");
const runWindowHint = document.getElementById("runWindowHint");
const logList = document.getElementById("logList");
const replyRecordList = document.getElementById("replyRecordList");
const replyRecordCount = document.getElementById("replyRecordCount");
const saveBtn = document.getElementById("saveBtn");
const startBtn = document.getElementById("startAutoBtn");
const stopBtn = document.getElementById("stopBtn");
const viewButtons = Array.from(document.querySelectorAll("[data-view]"));
const viewPanels = Array.from(document.querySelectorAll("[data-view-panel]"));
const stepButtons = Array.from(document.querySelectorAll(".quickActions [data-command]"));
const commandStatus = document.getElementById("commandStatus");
let settingsDirty = false;
let saveStatusTimer = null;
let commandStatusTimer = null;
let commandQueueRunning = false;

const STEP_COMPLETION_STAGES = {
  DEBUG_XINHUO_OPEN_TASKS: ["xinhuo_tasks_opened"],
  DEBUG_XINHUO_OPEN_FIRST_TASK: ["xinhuo_task_detail_opened"],
  DEBUG_XINHUO_CLAIM_OPEN_X: ["xinhuo_x_opened"],
  DEBUG_XINHUO_RUN_X_REPLY: ["xinhuo_x_replied"],
  DEBUG_XINHUO_COMPLETE_X_TASK: ["xinhuo_x_task_submitted"],
  DEBUG_XINHUO_WAIT_COMPLETION: ["xinhuo_tasks_returned"],
  DEBUG_XINHUO_RETURN_TASKS: ["xinhuo_tasks_returned"]
};

Object.values(fields).forEach((field) => {
  field.addEventListener("input", markSettingsDirty);
  field.addEventListener("change", markSettingsDirty);
});
viewButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
stepButtons.forEach((button, index) => button.addEventListener("click", () => runStepQueue(index)));
saveBtn.addEventListener("click", saveSettings);
startBtn.addEventListener("click", startRun);
stopBtn.addEventListener("click", stopRun);
document.getElementById("clearReplyRecordsBtn").addEventListener("click", clearReplyRecords);

setView(localStorage.getItem("xinhuoDebugView") || "tasks");
loadState();
setInterval(loadState, 1000);

async function startRun() {
  if (!(await saveSettings())) return;
  startBtn.disabled = true;
  try {
    const pending = chrome.runtime.sendMessage(await withClientWindowId({ type: "START_RUN" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    void pending.catch(() => {});
  } finally {
    startBtn.disabled = false;
    await loadState();
  }
}

async function stopRun() {
  await chrome.runtime.sendMessage({ type: "STOP_RUN" });
  await loadState();
}

async function runStepQueue(startIndex) {
  if (commandQueueRunning) return;
  commandQueueRunning = true;
  setStepButtonsDisabled(true);
  let completed = false;
  try {
    if (!(await saveSettings())) {
      showCommandStatus("配置保存失败，未执行流程", "error");
      return;
    }
    showCommandStatus(`从第 ${startIndex + 1} 步开始连续执行`, "info", 0);
    completed = true;
    for (const button of stepButtons.slice(startIndex)) {
      setButtonRunning(button, true);
      const label = button.querySelector("strong")?.textContent || "步骤";
      try {
        const response = await sendCommandAndWaitForStage(button.dataset.command);
        if (!response?.ok) {
          completed = false;
          showCommandStatus(response?.error || response?.result?.message || `${label}未完成`, "error");
          break;
        }
      } finally {
        setButtonRunning(button, false);
        await loadState();
      }
    }
  } finally {
    commandQueueRunning = false;
    setStepButtonsDisabled(false);
    await loadState();
  }
  if (completed) showCommandStatus("后续流程已连续执行完成", "success");
}

async function sendCommandAndWaitForStage(command) {
  const response = await chrome.runtime.sendMessage(await withClientWindowId({ type: command }));
  if (!response || response.ok === false) return response || { ok: false };
  const expectedStages = STEP_COMPLETION_STAGES[command];
  if (!expectedStages?.length || expectedStages.includes(response.state?.stage)) return response;
  const completed = await waitForStateStage(expectedStages, getStepWaitTimeoutMs(command));
  return completed ? response : { ok: false, error: `步骤未完成：${command}` };
}

async function waitForStateStage(expectedStages, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (response?.ok && expectedStages.includes(response.state?.stage)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function getStepWaitTimeoutMs(command) {
  if (command === "DEBUG_XINHUO_WAIT_COMPLETION") return 31 * 60 * 1000;
  if (command === "DEBUG_XINHUO_CLAIM_OPEN_X" || command === "DEBUG_XINHUO_RUN_X_REPLY") return 90000;
  if (command === "DEBUG_XINHUO_COMPLETE_X_TASK") return 120000;
  return 30000;
}

function showCommandStatus(text, kind = "info", timeoutMs = 5000) {
  if (!commandStatus) return;
  if (commandStatusTimer) clearTimeout(commandStatusTimer);
  commandStatus.textContent = text || "";
  commandStatus.dataset.kind = kind;
  commandStatus.hidden = !text;
  commandStatusTimer = null;
  if (text && timeoutMs > 0) {
    commandStatusTimer = setTimeout(() => {
      commandStatus.textContent = "";
      commandStatus.hidden = true;
      commandStatusTimer = null;
    }, timeoutMs);
  }
}

function setStepButtonsDisabled(disabled) {
  stepButtons.forEach((button) => { button.disabled = disabled; });
}

function setButtonRunning(button, running) {
  button.disabled = running || (commandQueueRunning && stepButtons.includes(button));
  button.classList.toggle("is-running", running);
  button.toggleAttribute("aria-busy", running);
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) return;
  if (!settingsDirty) renderSettings(response.settings || {});
  renderState(response.state || {}, settingsDirty ? readSettings() : (response.settings || {}));
  if (getActiveView() === "records") await loadReplyRecords();
}

async function saveSettings() {
  const settings = readSettings();
  if (!(await requestCustomAIHostPermission(settings.aiApiUrl))) return false;
  const response = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  if (!response?.ok) return false;
  settingsDirty = false;
  renderSettings(response.settings || settings);
  showSaveStatus("已保存");
  return true;
}

function readSettings() {
  return {
    taskPlatform: "xinhuo",
    runMode: "auto",
    runWindowEnabled: fields.runWindowEnabled.checked,
    runWindowStart: fields.runWindowStart.value,
    runWindowEnd: fields.runWindowEnd.value,
    xinhuoMinTaskBounty: Number(fields.xinhuoMinTaskBounty.value),
    claimTimeoutMs: Number(fields.claimTimeoutMs.value),
    cooldownPollMs: Number(fields.cooldownPollMs.value),
    maxTasksPerRun: Number(fields.maxTasksPerRun.value),
    maxTaskAttempts: Number(fields.maxTaskAttempts.value),
    replyMode: fields.replyMode.value,
    autoSubmitXinhuo: fields.autoSubmitXinhuo.checked,
    actionDelayMs: Number(fields.actionDelayMs.value),
    aiProvider: "openai",
    aiModel: fields.aiModel.value.trim(),
    aiApiUrl: fields.aiApiUrl.value.trim(),
    aiApiKey: fields.aiApiKey.value.trim(),
    aiSystemPrompt: fields.aiSystemPrompt.value.trim()
  };
}

function renderSettings(settings) {
  fields.runWindowEnabled.checked = settings.runWindowEnabled !== false;
  fields.runWindowStart.value = settings.runWindowStart || "11:00";
  fields.runWindowEnd.value = settings.runWindowEnd || "01:00";
  fields.xinhuoMinTaskBounty.value = settings.xinhuoMinTaskBounty ?? 0;
  fields.claimTimeoutMs.value = settings.claimTimeoutMs ?? 60000;
  fields.cooldownPollMs.value = settings.cooldownPollMs ?? 500;
  fields.maxTasksPerRun.value = settings.maxTasksPerRun ?? 9999;
  fields.maxTaskAttempts.value = settings.maxTaskAttempts ?? 9999;
  fields.replyMode.value = settings.replyMode === "post" ? "post" : "fill";
  fields.autoSubmitXinhuo.checked = Boolean(settings.autoSubmitXinhuo);
  fields.actionDelayMs.value = settings.actionDelayMs ?? 1200;
  fields.aiModel.value = settings.aiModel || "";
  fields.aiApiUrl.value = settings.aiApiUrl || "";
  fields.aiApiKey.value = settings.aiApiKey || "";
  fields.aiSystemPrompt.value = settings.aiSystemPrompt || "";
}

function renderState(state, settings) {
  modeBadge.textContent = formatMode(state.mode);
  stageBadge.textContent = formatStage(state.stage);
  document.body.dataset.mode = state.mode || "idle";
  document.body.dataset.stage = state.stage || "idle";
  renderRunWindowHint(state, settings);
  const logs = Array.isArray(state.logs) ? state.logs.slice(0, 60) : [];
  logList.replaceChildren(...logs.map(renderLogEntry));
}

function renderRunWindowHint(state, settings) {
  if (settings.runWindowEnabled === false) {
    runWindowHint.textContent = "运行时段 已关闭";
    return;
  }
  if (state.stage === "auto_waiting_schedule" && state.scheduledResumeAt) {
    runWindowHint.textContent = `等待 ${formatDateTime(state.scheduledResumeAt)}`;
    return;
  }
  runWindowHint.textContent = `运行时段 ${settings.runWindowStart || "11:00"}-${settings.runWindowEnd || "01:00"}`;
}

function formatMode(value) {
  return ({ auto: "自动运行", debug: "流程控制", idle: "空闲", stopped: "已停止" })[value] || "空闲";
}

function formatStage(value) {
  const labels = {
    idle: "等待开始",
    stopped: "已停止",
    finished: "已完成",
    xinhuo_starting: "打开薪火",
    xinhuo_selecting_task: "检测任务",
    xinhuo_foreground_wait: "X 页面停留",
    xinhuo_submitted: "已提交核验",
    xinhuo_blocked: "配置未满足",
    xinhuo_claim_failed: "接取失败",
    xinhuo_x_open_failed: "X 打开失败",
    xinhuo_reply_failed: "回复失败",
    xinhuo_submitting_x_task: "在 X 提交任务",
    xinhuo_waiting_verification_result: "等待核验结果",
    xinhuo_submit_failed: "核验提交失败",
    auto_waiting_schedule: "等待运行时段",
    attempt_limit_reached: "达到尝试上限"
  };
  Object.assign(labels, {
    starting: "打开薪火",
    resuming_claimed_task: "恢复已接订单",
    selecting_task: "检测任务",
    claim_not_acquired: "未抢到，继续扫描",
    foreground_wait: "X 页面停留",
    submitting_x_task: "在 X 提交任务",
    waiting_verification_result: "等待核验结果",
    submitted: "已提交核验",
    blocked: "配置未满足",
    claim_failed: "接取失败",
    x_open_failed: "X 打开失败",
    reply_failed: "回复失败",
    submit_failed: "核验提交失败",
    verification_failed: "官方核验失败",
    recovering: "返回广场恢复",
    recovery_waiting: "恢复失败",
    manual_start_required: "等待人工启动",
    interrupted_not_resumed: "运行已中断",
    claimed_task_recovery_blocked: "订单已保留"
  });
  Object.assign(labels, {
    debug_takeover: "流程控制已接管",
    xinhuo_tasks_opened: "任务广场已打开",
    xinhuo_task_detail_opened: "任务详情已打开",
    xinhuo_x_opened: "目标 X 已打开",
    xinhuo_x_replied: "X 回复已完成",
    xinhuo_x_task_submitted: "X 任务已提交",
    xinhuo_tasks_returned: "已返回任务广场",
    debug_step_failed: "流程步骤失败"
  });
  return labels[value] || value || "等待开始";
}

function renderLogEntry(entry) {
  const item = document.createElement("li");
  item.className = entry.level || "info";
  const time = document.createElement("time");
  time.textContent = formatTime(entry.at);
  const text = document.createElement("span");
  const phase = formatLogPagePhase(entry.pagePhase);
  const task = entry.taskId
    ? " · " + (entry.taskType || "任务") + (entry.bounty ? " " + Number(entry.bounty).toFixed(3) + " KX" : "") + " · " + entry.taskId.slice(0, 8)
    : "";
  const title = entry.taskTitle ? ` · ${entry.taskTitle}` : "";
  const url = entry.tweetUrl ? ` · ${entry.tweetUrl}` : "";
  text.textContent = "[" + (entry.level || "info") + "]" + (phase ? " [" + phase + "]" : "") + task + title + url + " " + (entry.text || "");
  item.append(time, text);
  return item;
}

function formatLogPagePhase(phase) {
  const labels = {
    marketplace: "任务广场",
    claim: "接取任务",
    detail: "任务详情",
    x_open: "打开 X",
    x_reply: "X 回复",
    x_submit: "X 提交",
    verification: "薪火核验",
    completed: "已完成",
    recovery: "恢复流程",
    recovery_error: "恢复失败",
    claim_recovery: "恢复已接订单",
    xinhuo: "薪火页面",
    unknown: ""
  };
  return labels[phase] || "";
}

async function loadReplyRecords() {
  const response = await chrome.runtime.sendMessage({ type: "GET_REPLY_RECORDS" });
  const records = response?.ok && Array.isArray(response.records) ? response.records : [];
  replyRecordCount.textContent = `${records.length} 条`;
  if (!records.length) {
    replyRecordList.innerHTML = '<p class="recordEmpty">暂无回复记录</p>';
    return;
  }
  replyRecordList.replaceChildren(...records.map(renderReplyRecord));
}

function renderReplyRecord(record) {
  const item = document.createElement("article");
  item.className = `replyRecordItem${record.kind === "diagnostic" ? " replyRecordFailure" : ""}`;
  const meta = document.createElement("div");
  meta.className = "replyRecordMeta";
  meta.textContent = record.kind === "diagnostic"
    ? `${formatDateTime(record.createdAt)} · ${record.failureLabel || "失败诊断"}`
    : `${formatDateTime(record.createdAt)} · ${record.taskType || "评论"} · ${record.bounty ?? "--"} KX`;
  const tweet = document.createElement("p");
  tweet.className = "replyRecordTweet";
  tweet.textContent = record.tweetText || record.taskTitle || "未记录到推文正文";
  const reply = document.createElement("p");
  reply.className = "replyRecordReply";
  reply.textContent = record.kind === "diagnostic"
    ? record.failureMessage || "未记录到失败详情"
    : record.replyText || "";
  item.append(meta, tweet, reply);
  return item;
}

async function clearReplyRecords() {
  await chrome.runtime.sendMessage({ type: "CLEAR_REPLY_RECORDS" });
  await loadReplyRecords();
}

async function requestCustomAIHostPermission(apiUrl) {
  if (!apiUrl) return true;
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:") throw new Error();
    const origin = `${url.protocol}//${url.host}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    if (await chrome.permissions.request({ origins: [origin] })) return true;
  } catch (_) {}
  showSaveStatus("请授权有效的 HTTPS API 地址");
  return false;
}

async function withClientWindowId(payload) {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (Number.isInteger(currentWindow?.id)) return { ...payload, clientWindowId: currentWindow.id };
  } catch (_) {}
  return payload;
}

function markSettingsDirty() {
  settingsDirty = true;
  showSaveStatus("保存配置");
}

function showSaveStatus(text) {
  saveBtn.textContent = text;
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  if (text !== "保存配置") {
    saveStatusTimer = setTimeout(() => {
      saveBtn.textContent = "保存配置";
      saveStatusTimer = null;
    }, 1500);
  }
}

function setView(view) {
  const next = ["tasks", "records", "settings"].includes(view) ? view : "tasks";
  localStorage.setItem("xinhuoDebugView", next);
  viewButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.view === next));
  viewPanels.forEach((panel) => {
    const active = panel.dataset.viewPanel === next;
    panel.classList.toggle("is-active", active);
    panel.toggleAttribute("hidden", !active);
  });
  if (next === "records") void loadReplyRecords();
}

function getActiveView() {
  return localStorage.getItem("xinhuoDebugView") || "tasks";
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN", { hour12: false });
}

const fields = {
  actionDelayMs: document.getElementById("actionDelayMs"),
  autoSubmitXinhuo: document.getElementById("autoSubmitXinhuo"),
  maxTasksPerRun: document.getElementById("maxTasksPerRun"),
  replyMode: document.getElementById("replyMode"),
  replyProvider: document.getElementById("replyProvider"),
  aiModel: document.getElementById("aiModel"),
  aiApiKey: document.getElementById("aiApiKey"),
  aiSystemPrompt: document.getElementById("aiSystemPrompt")
};

const statusBadge = document.getElementById("statusBadge");
const completedCount = document.getElementById("completedCount");
const failedCount = document.getElementById("failedCount");
const logList = document.getElementById("logList");

document.getElementById("saveBtn").addEventListener("click", saveSettings);
document.getElementById("debugBtn").addEventListener("click", openDebugPage);
document.getElementById("startBtn").addEventListener("click", startRun);
document.getElementById("stopBtn").addEventListener("click", stopRun);

loadState();
setInterval(loadState, 1500);

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response || !response.ok) return;
  renderSettings(response.settings);
  renderState(response.state);
}

async function saveSettings() {
  const current = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: { ...(current?.settings || {}), ...readSettings() }
  });
  await loadState();
}

async function startRun() {
  await saveSettings();
  await chrome.runtime.sendMessage(await withClientWindowId({ type: "START_RUN" }));
  await loadState();
}

async function stopRun() {
  await chrome.runtime.sendMessage({ type: "STOP_RUN" });
  await loadState();
}

async function openDebugPage() {
  await saveSettings();
  await chrome.runtime.sendMessage(await withClientWindowId({ type: "OPEN_DEBUG_PAGE" }));
}

async function withClientWindowId(payload) {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (Number.isInteger(currentWindow?.id)) {
      return { ...payload, clientWindowId: currentWindow.id };
    }
  } catch (_) {}
  return payload;
}

function readSettings() {
  return {
    taskPlatform: "xinhuo",
    actionDelayMs: Number(fields.actionDelayMs.value),
    autoSubmitXinhuo: fields.autoSubmitXinhuo.checked,
    maxTasksPerRun: Number(fields.maxTasksPerRun.value),
    replyMode: fields.replyMode.value,
    replyProvider: fields.replyProvider.value,
    aiProvider: "openai",
    aiModel: fields.aiModel.value.trim(),
    aiApiKey: fields.aiApiKey.value.trim(),
    aiSystemPrompt: fields.aiSystemPrompt.value.trim()
  };
}

function renderSettings(settings) {
  const active = document.activeElement;
  if (Object.values(fields).includes(active)) return;

  fields.actionDelayMs.value = settings.actionDelayMs;
  fields.autoSubmitXinhuo.checked = settings.autoSubmitXinhuo;
  fields.maxTasksPerRun.value = settings.maxTasksPerRun;
  fields.replyMode.value = settings.replyMode;
  fields.replyProvider.value = settings.replyProvider;
  fields.aiModel.value = settings.aiModel || "";
  fields.aiApiKey.value = settings.aiApiKey || "";
  fields.aiSystemPrompt.value = settings.aiSystemPrompt || "";
}

function renderState(state) {
  statusBadge.textContent = state.running ? "运行中" : "空闲";
  statusBadge.classList.toggle("running", Boolean(state.running));
  completedCount.textContent = state.completed || 0;
  failedCount.textContent = state.failed || 0;

  logList.replaceChildren(...(state.logs || []).slice(0, 20).map((entry) => {
    const item = document.createElement("li");
    item.className = entry.level || "info";
    item.textContent = `${formatTime(entry.at)} [${entry.level}] ${entry.text}`;
    return item;
  }));
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

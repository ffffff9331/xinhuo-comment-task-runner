import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/content/xinhuo.js", import.meta.url), "utf8");
const xPage = readFileSync(new URL("../src/content/x.js", import.meta.url), "utf8");
const popupHtml = readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
const popupJs = readFileSync(new URL("../src/popup/popup.js", import.meta.url), "utf8");
const debugHtml = readFileSync(new URL("../src/debug/debug.html", import.meta.url), "utf8");
const debugJs = readFileSync(new URL("../src/debug/debug.js", import.meta.url), "utf8");

assert.match(background, /const XINHUO_SITE_X_OPEN_WAIT_MS = 5000/);
assert.match(background, /const XINHUO_FOREGROUND_REFOCUS_MS = 1000/);
assert.match(background, /settingsVersion: 4/);
assert.match(background, /aiModel: "gpt-5\.6-terra"/);
assert.match(background, /aiProvider: "openai"/);
assert.match(background, /function migrateSettings/);
assert.match(background, /model: settings\.aiModel/);
assert.doesNotMatch(popupHtml, /id="aiProvider"|AI 提供商|模型提供商/);
assert.doesNotMatch(debugHtml, /id="aiProvider"|AI 提供商|模型提供商/);
assert.doesNotMatch(debugHtml, /提供商默认模型/);
assert.match(popupHtml, /id="aiModel"/);
assert.match(debugHtml, /id="aiModel"/);
assert.match(popupJs, /aiProvider: "openai"/);
assert.match(debugJs, /aiProvider: "openai"/);
for (const command of [
  "DEBUG_XINHUO_OPEN_TASKS",
  "DEBUG_XINHUO_OPEN_FIRST_TASK",
  "DEBUG_XINHUO_CLAIM_OPEN_X",
  "DEBUG_XINHUO_RUN_X_REPLY",
  "DEBUG_XINHUO_COMPLETE_X_TASK",
  "DEBUG_XINHUO_WAIT_COMPLETION",
  "DEBUG_XINHUO_RETURN_TASKS"
]) {
  assert.match(debugHtml, new RegExp(`data-command="${command}"`));
  assert.match(background, new RegExp(command));
}
assert.match(debugJs, /stepButtons\.slice\(startIndex\)/);
assert.match(page, /DEBUG_XINHUO_OPEN_FIRST_TASK/);
assert.match(page, /DEBUG_XINHUO_CLAIM_CURRENT_TASK/);
assert.doesNotMatch(debugHtml, /Lighthouse|灯塔|lhdao/i);
assert.match(background, /function maintainXinhuoXForeground/);
assert.match(background, /function mergeXinhuoTask/);
assert.match(background, /function latchXinhuoCompletion/);
assert.match(background, /function hasLatchedXinhuoCompletion/);
assert.match(background, /function openXinhuoFallbackXTab/);
assert.match(background, /function getBoundMatchingXinhuoXTab/);
assert.match(background, /function findRecoverableClaimedXinhuoTask/);
assert.match(background, /XINHUO_INSPECT_CURRENT_TASK/);
assert.match(background, /先回当前薪火订单读取官方结果/);
assert.match(background, /const schedule = getScheduleState\(settings\)/);
assert.match(background, /运行时段限制不会创建定时任务/);
assert.match(background, /starting: "marketplace"/);
assert.match(background, /foreground_wait: "x_reply"/);
assert.match(background, /assertXinhuoTab\(xinhuoTab, "扫描薪火任务前"\)/);
assert.match(background, /function ensureXinhuoMarketplaceTab/);
assert.match(background, /薪火标签尚未就绪/);
assert.match(background, /const tabs = \(await chrome\.tabs\.query\(query\)\)\.filter/);
assert.match(background, /function isXinhuoUrl/);
assert.match(background, /function isXinhuoMarketplaceUrl/);
assert.match(background, /丢弃非薪火的残留任务标签/);
assert.match(background, /isXinhuoUrl\(tab\.url\)/);
assert.match(background, /\$\{context\}拒绝使用非薪火标签/);
assert.match(background, /claimed_task_recovery_blocked/);
assert.match(background, /function focusXinhuoXTab/);
assert.match(background, /active: true, openerTabId/);
// The 30s keepalive alarm is the only sanctioned alarms usage: it keeps the
// MV3 worker alive during plaza waits and resumes a safe auto run after an
// unexpected worker restart. Resume must refuse a claimed, unfinished order.
assert.doesNotMatch(background, /RUN_WATCHDOG_PERIOD_MINUTES|RUN_STALL_TIMEOUT_MS/);
assert.match(background, /chrome\.alarms\.onAlarm\.addListener/);
assert.match(background, /const XINHUO_KEEPALIVE_ALARM = "xinhuoAutoRunKeepaliveV1"/);
assert.match(background, /periodInMinutes: 0\.5/);
assert.match(background, /hasClaimedIncompleteOrder/);
assert.match(background, /不自动续跑，请人工处理该订单后重新启动/);
assert.match(background, /resume_after_service_worker_restart/);
assert.match(background, /Chrome 后台恢复了中断的薪火状态，等待保活闹钟自动续跑/);
assert.match(background, /XINHUO_WAIT_FOR_SUBMISSION_RESULT/);
assert.doesNotMatch(background, /type: "XINHUO_CONFIRM_AND_WAIT_VERIFICATION"/);
assert.match(background, /不重复使用 X API 补验/);
assert.match(background, /waitForXinhuoFinalVerification/);
assert.match(background, /finalConfirmation\.final/);
assert.match(page, /function confirmAndWaitVerification/);
assert.match(page, /function getCurrentTaskDetailText/);
assert.match(page, /function getSubmissionState/);
assert.match(page, /function assertCurrentClaimedTask/);
assert.match(page, /function findMarketplaceTaskAnchors/);
assert.match(page, /function normalizeMarketplaceTaskHref/);
assert.match(page, /function inspectCurrentTask/);
assert.match(page, /function buildSubmissionEvidence/);
assert.match(page, /detailPath: location\.pathname/);
assert.match(page, /薪火订单详情已变化/);
assert.match(page, /if \(location\.pathname !== taskPath\) return false/);
assert.match(page, /该任务已完成/);
assert.match(page, /核验失败\|任务未通过\|任务失败/);
assert.doesNotMatch(page, /if \(location\.pathname !== taskPath\) return true/);
assert.match(xPage, /waitForXinhuoTaskWidgetSubmission/);
assert.match(xPage, /已在薪火任务组件确认提交/);
assert.match(xPage, /const widget = findXinhuoTaskWidget\(\)/);
assert.match(xPage, /继续提交薪火任务/);


// The two projects carry forked copies of src/content/x.js. This pin makes an
// accidental deletion or rename of a shared reply-pipeline function fail the
// regression run in BOTH repos, so an X-side fix cannot land in only one.
const sharedReplyPipelineFns = ["runReply",
  "scrapeCurrentTweet",
  "inferTaskActions",
  "detectExistingReplyBeforeWriting",
  "queryLocalReplyHistory",
  "findExistingOwnReplyOnPage",
  "tryWholeTextPasteOnce",
  "insertReplyTextViaCharacterPaste",
  "setReplyComposerTextNatively",
  "waitForNativeComposerText",
  "classifyReplyComposerMismatch",
  "clearReplyBoxIfNeeded",
  "findReplyBox",
  "clickPostButtonAndVerify",
  "waitForReplySendButtonReady",
  "waitForReplySuccess",
  "waitForDraftClearAfterReplySuccess",
  "waitForReplyBoxContentStable",
  "simulateReadingBeforeReply",
  "waitForPageReady",
  "waitForStableMainTweet",
  "assertActiveRun",
  "findMainTweetArticle",
  "completeTaskWidgetLifecycle",
  "hasAccountRestrictionBanner",];
for (const fn of sharedReplyPipelineFns) {
  assert.match(xPage, new RegExp(`function ${fn}\\(`));
}

assert.match(background, /XINHUO_MARKETPLACE_IDLE_REFRESH_MS = 5 \* 60 \* 1000/);
assert.match(background, /runtimeState\.stage === "selecting_task"/);
assert.match(background, /!runtimeState\.currentTask/);
assert.match(background, /Date\.now\(\) - Number\(runtimeState\.lastProgressAt \|\| 0\) >= XINHUO_MARKETPLACE_IDLE_REFRESH_MS/);
assert.match(background, /chrome\.tabs\.reload\(runtimeState\.xinhuoTabId\)/);
assert.doesNotMatch(background, /case "CONTENT_LOG"[\s\S]{0,260}touchRunState\(\)/);

console.log("Xinhuo regression checks passed.");

(function () {
  const SINGLETON_KEY = "__xinhuoTaskRunnerSingleton__";
  const SCRIPT_VERSION = "0.1.38";
  if (globalThis[SINGLETON_KEY]?.version === SCRIPT_VERSION) return;
  globalThis[SINGLETON_KEY] = { version: SCRIPT_VERSION };

  let activeRunId = "";
  const cancelledRunIds = new Set();
  let claimOperation = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (globalThis[SINGLETON_KEY]?.version !== SCRIPT_VERSION) return false;
    if (message?.type === "CANCEL_XINHUO_RUN") {
      if (message.runId) cancelledRunIds.add(message.runId);
      activeRunId = `cancelled-${Date.now()}`;
      sendResponse({ ok: true });
      return true;
    }
    if (message?.runId && cancelledRunIds.has(message.runId)) {
      sendResponse({ ok: false, cancelled: true, message: "旧任务已取消" });
      return true;
    }
    if (message?.type === "XINHUO_SELECT_AND_CLAIM") {
      if (claimOperation) {
        if (claimOperation.runId === message.runId) claimOperation.promise.then(sendResponse);
        else sendResponse({ ok: false, conflict: true, message: "旧接单操作尚未结束" });
        return true;
      }
      activeRunId = message.runId || `manual-${Date.now()}`;
      const operation = { runId: message.runId };
      claimOperation = operation;
      operation.promise = Promise.resolve()
        .then(() => selectAndClaim(message.settings || {}, message.attemptedTaskKeys || []))
        .catch((error) => ({ ok: false, message: error.message || String(error) }))
        .finally(() => { if (claimOperation === operation) claimOperation = null; });
      operation.promise.then(sendResponse);
      return true;
    }
    if (message?.type === "DEBUG_XINHUO_OPEN_FIRST_TASK") {
      if (claimOperation) {
        if (claimOperation.runId === message.runId) claimOperation.promise.then(sendResponse);
        else sendResponse({ ok: false, conflict: true, message: "旧任务操作尚未结束" });
        return true;
      }
      activeRunId = message.runId || `manual-${Date.now()}`;
      const operation = { runId: message.runId };
      claimOperation = operation;
      operation.promise = Promise.resolve()
        .then(() => openFirstReadyTask(message.settings || {}, message.attemptedTaskKeys || []))
        .catch((error) => ({ ok: false, message: error.message || String(error) }))
        .finally(() => { if (claimOperation === operation) claimOperation = null; });
      operation.promise.then(sendResponse);
      return true;
    }
    if (message?.type === "DEBUG_XINHUO_CLAIM_CURRENT_TASK") {
      if (claimOperation) {
        if (claimOperation.runId === message.runId) claimOperation.promise.then(sendResponse);
        else sendResponse({ ok: false, conflict: true, message: "旧任务操作尚未结束" });
        return true;
      }
      activeRunId = message.runId || `manual-${Date.now()}`;
      const operation = { runId: message.runId };
      claimOperation = operation;
      operation.promise = Promise.resolve()
        .then(() => claimCurrentTask(message.settings || {}, message.task || {}))
        .catch((error) => ({ ok: false, message: error.message || String(error) }))
        .finally(() => { if (claimOperation === operation) claimOperation = null; });
      operation.promise.then(sendResponse);
      return true;
    }
    if (message?.type === "XINHUO_SUBMIT_VERIFICATION") {
      activeRunId = message.runId || `manual-${Date.now()}`;
      submitVerification(message.settings || {}, message.task || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error.message || String(error) }));
      return true;
    }
    if (message?.type === "XINHUO_CONFIRM_AND_WAIT_VERIFICATION") {
      activeRunId = message.runId || `manual-${Date.now()}`;
      confirmAndWaitVerification(message.settings || {}, message.task || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error.message || String(error) }));
      return true;
    }
    if (message?.type === "XINHUO_WAIT_FOR_SUBMISSION_RESULT") {
      activeRunId = message.runId || `manual-${Date.now()}`;
      waitForSubmissionResult(message.settings || {}, message.task || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error.message || String(error) }));
      return true;
    }
    if (message?.type === "XINHUO_INSPECT_CURRENT_TASK") {
      activeRunId = message.runId || `manual-${Date.now()}`;
      try {
        sendResponse(inspectCurrentTask(message.task || {}));
      } catch (error) {
        sendResponse({ ok: false, message: error.message || String(error) });
      }
      return true;
    }
    return false;
  });

  async function selectAndClaim(settings, attemptedTaskKeys) {
    await ensureTasksPage(settings);
    const runId = activeRunId;
    const attempted = new Set(attemptedTaskKeys || []);
    const pollMs = Math.max(500, Number(settings.cooldownPollMs) || 500);
    const minBounty = Math.max(0, Number(settings.xinhuoMinTaskBounty) || 0);
    let lastReportAt = 0;

    if (hasAlreadyClaimed()) {
      return getManuallyClaimedTask();
    }

    while (true) {
      assertActive(runId);
      if (hasAlreadyClaimed()) return getManuallyClaimedTask();
      const candidates = collectCandidates().filter((task) => meetsMinimumBounty(task, minBounty));
      const ready = candidates.filter((task) => task.ready && !task.attempted && !attempted.has(task.taskKey));
      const imminent = candidates.filter((task) => isClaimWindowCandidate(task) && !task.attempted && !attempted.has(task.taskKey)).sort((a, b) => a.cooldownMs - b.cooldownMs);
      const next = ready[0] || imminent[0];
      if (next) {
        report(`${next.ready ? `发现 ${ready.length} 笔可立即接取的薪火任务，准备接取` : `发现薪火任务进入 5 秒抢单窗口（${formatDuration(next.cooldownMs)}）`}：${next.title || next.handle || "未命名任务"}`);
        try {
          return await openAndClaim(next, settings, runId);
        } catch (error) {
          assertActive(runId);
          // Preserve the candidate identity even when navigation or hydration fails.
          return { ok: false, retryable: !hasAlreadyClaimed(), returnToMarketplace: !hasAlreadyClaimed(),
            message: error.message || String(error),
            task: { taskKey: next.taskKey, detailPath: new URL(next.href).pathname, claimed: hasAlreadyClaimed() } };
        }
      }

      const cooling = candidates.filter((task) => task.cooldownMs > 0).sort((a, b) => a.cooldownMs - b.cooldownMs);
      if (Date.now() - lastReportAt > 15000) {
        lastReportAt = Date.now();
        report(buildSelectionStatus(candidates, attempted, minBounty));
      }
      await wait(pollMs);
    }
  }

  // A bare "已检查 N 笔任务" hides why nothing is claimable. Spell out the
  // breakdown (deduped / blocked by tier or quota / below bounty / cooling)
  // the same way the Lighthouse runner does.
  function buildSelectionStatus(bountyPassed, attemptedSet, minBounty) {
    const deduped = bountyPassed.filter((task) => attemptedSet.has(task.taskKey)).length;
    const lowBountyNote = minBounty > 0;
    const blockedIdle = bountyPassed.filter((task) => !task.ready && task.cooldownMs <= 0 && !attemptedSet.has(task.taskKey)).length;
    const cooling = bountyPassed.filter((task) => task.cooldownMs > 0).sort((a, b) => a.cooldownMs - b.cooldownMs);
    const detail = `去重 ${deduped} 笔、状态暂不可接 ${blockedIdle} 笔`;
    if (cooling[0]) {
      return `薪火最近可接互动任务仍在冷却：${formatDuration(cooling[0].cooldownMs)}（${detail}），继续在广场等待`;
    }
    return `薪火任务广场已检查 ${bountyPassed.length} 笔评论、点赞或评论+点赞任务，暂无可立即接取（${detail}${lowBountyNote ? `、低于 ${minBounty} KX 已过滤` : ""}），继续等待刷新`;
  }

  async function openFirstReadyTask(settings, attemptedTaskKeys) {
    await ensureTasksPage(settings);
    const runId = activeRunId;
    const attempted = new Set(attemptedTaskKeys || []);
    const pollMs = Math.max(500, Number(settings.cooldownPollMs) || 500);
    const minBounty = Math.max(0, Number(settings.xinhuoMinTaskBounty) || 0);
    let lastReportAt = 0;

    if (hasAlreadyClaimed()) {
      const claimed = getManuallyClaimedTask();
      return { ...claimed, message: "当前薪火详情已接单，保留订单进入下一步" };
    }

    while (true) {
      assertActive(runId);
      const candidates = collectCandidates().filter((task) => meetsMinimumBounty(task, minBounty));
      const ready = candidates.filter((task) => task.ready && !task.attempted && !attempted.has(task.taskKey));
      const imminent = candidates.filter((task) => isClaimWindowCandidate(task) && !task.attempted && !attempted.has(task.taskKey)).sort((a, b) => a.cooldownMs - b.cooldownMs);
      const candidate = ready[0] || imminent[0];
      if (candidate) {
        report(`已点击薪火任务入口：${candidate.title || candidate.handle || candidate.taskKey}，等待详情页加载`);
        candidate.anchor.click();
        await waitFor(() => location.pathname === new URL(candidate.href).pathname, 15000, "打开薪火任务详情超时");
        await waitFor(() => Boolean(findClaimButton() || hasAlreadyClaimed()), 15000, "薪火任务详情未显示接取状态");
        assertActive(runId);
        const task = buildOpenedTask(candidate);
        report(`已打开薪火任务详情：${task.taskType || "互动"} ${Number(task.bounty || 0).toFixed(3)} KX，尚未接单`);
        return { ok: true, task, message: "已打开首个当前等级可接的薪火任务详情" };
      }

      if (Date.now() - lastReportAt > 15000) {
        lastReportAt = Date.now();
        report(buildSelectionStatus(candidates, attempted, minBounty));
      }
      await wait(pollMs);
    }
  }

  async function claimCurrentTask(settings, openedTask = {}) {
    const runId = activeRunId;
    assertActive(runId);
    assertCurrentClaimedTask(openedTask);
    if (hasAlreadyClaimed()) {
      const claimed = getManuallyClaimedTask(openedTask);
      return { ...claimed, message: "当前薪火任务已经接取" };
    }
    const detailText = normalize(document.body.innerText || "");
    const candidate = {
      taskKey: location.pathname,
      taskType: openedTask.taskType || (/评论\+点赞/.test(detailText) ? "评论+点赞" : (/评论/.test(detailText) ? "评论" : (/点赞/.test(detailText) ? "点赞" : ""))),
      bounty: Number(openedTask.bounty) || parseBounty(detailText),
      handle: openedTask.handle || (detailText.match(/@[A-Za-z0-9_]{1,20}/) || [""])[0],
      title: openedTask.candidateTitle || openedTask.title || "当前薪火任务"
    };
    return claimCurrentDetail(candidate, settings, runId, Date.now());
  }

  function buildOpenedTask(candidate) {
    const detailText = normalize(document.body.innerText || "");
    const tweetUrl = Array.from(document.querySelectorAll('a[href*="x.com/"][href*="/status/"]'))
      .map((link) => link.href)
      .find(Boolean) || "";
    return {
      platform: "xinhuo",
      claimed: hasAlreadyClaimed(),
      detailPath: location.pathname,
      taskKey: location.pathname,
      taskType: candidate.taskType,
      bounty: candidate.bounty,
      handle: candidate.handle,
      candidateTitle: candidate.title,
      tweetUrl,
      detailText: detailText.slice(0, 1000),
      minReplyChineseChars: 10
    };
  }

  function collectCandidates() {
    const anchors = findMarketplaceTaskAnchors();
    return anchors.map((anchor) => {
      const text = normalize(anchor.innerText || "");
      const href = normalizeMarketplaceTaskHref(anchor);
      if (!text || !href) return null;
      const taskType = /评论\+点赞/.test(text) ? "评论+点赞" : (/评论/.test(text) ? "评论" : (/点赞/.test(text) ? "点赞" : ""));
      const explicitlyReady = /可立即接取|立即接取/.test(text);
      const blocked = isCandidateBlocked(text + " " + (anchor.getAttribute("aria-label") || ""));
      const cooldownMs = parseCooldownMs(text);
      const bounty = parseBounty(text);
      const handle = (text.match(/@[A-Za-z0-9_]{1,20}/) || [""])[0];
      const titlePrefix = handle ? text.split(handle)[0] : text;
      const title = titlePrefix.replace(/冷却中，暂不可进入：|任务状态|等待释放/g, "").trim();
      const taskKey = new URL(href).pathname;
      return {
        anchor,
        href,
        text,
        taskType,
        bounty,
        handle,
        title,
        taskKey,
        cooldownMs,
        // “开放接取” only means the publisher has opened the task.  A card
        // is safe to claim only when the marketplace explicitly marks it as
        // immediately claimable for the current account.
        ready: Boolean(taskType && explicitlyReady && !blocked && cooldownMs <= 0 && anchor.getAttribute("aria-disabled") !== "true"),
        attempted: false
      };
    }).filter(Boolean).filter((task) => task.taskType && !isCandidateBlocked(task.text));
  }

  function findMarketplaceTaskAnchors() {
    return Array.from(document.querySelectorAll("a[href]")).filter((anchor) => {
      if (!normalizeMarketplaceTaskHref(anchor)) return false;
      return !anchor.closest?.("nav, header, footer, [data-task-history], [aria-label*='历史']");
    });
  }

  function normalizeMarketplaceTaskHref(anchor) {
    try {
      const url = new URL(anchor?.getAttribute?.("href") || anchor?.href || "", location.href);
      if (url.origin !== location.origin || !/^\/tasks\/[^/?#]+$/.test(url.pathname)) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function isCandidateBlocked(text) {
    return /当前等级不可接取|当前等级无席位|无席位|已满|已接取|进行中|待复核|额度不足|接单额度不足|今日接单.*上限|已达.*上限/.test(text);
  }

  function meetsMinimumBounty(task, minimum) {
    if (minimum <= 0) return true;
    // The list sometimes renders the estimate as "-- KX" even for a task
    // that can be claimed.  Do not invent a value to satisfy a positive filter.
    return task.bounty > 0 && task.bounty + 0.000001 >= minimum;
  }

  function isClaimWindowCandidate(task) {
    return Boolean(task && !task.ready && Number(task.cooldownMs) > 0 && Number(task.cooldownMs) <= 5000
      && task.anchor?.getAttribute?.("aria-disabled") !== "true");
  }

  async function openAndClaim(candidate, settings, runId) {
    const claimStartedAt = Date.now();
    report(`已点击薪火任务入口：${candidate.title || candidate.handle || candidate.taskKey}，等待详情页加载`);
    candidate.anchor.click();
    await waitFor(() => location.pathname === new URL(candidate.href).pathname, 15000, "打开薪火任务详情超时");
    await waitForClaimButtonAfterHydration(settings, runId);
    report("薪火任务详情已打开，正在定位接取按钮");
    assertActive(runId);

    return claimCurrentDetail(candidate, settings, runId, claimStartedAt);
  }

  // A detail page can expose a release countdown before the claim button.
  // Stay on the page and poll faster during the final second to catch the
  // newly released seat instead of treating the countdown as a failure.
  async function waitForClaimButtonAfterHydration(settings, runId) {
    const timeoutMs = Math.max(15000, Number(settings.lockSeatTimeoutMs) || 60000);
    const pollMs = Math.min(Math.max(Number(settings.cooldownPollMs) || 500, 250), 500);
    const started = Date.now();
    let lastReportAt = 0;
    let lastCountdown = null;
    while (Date.now() - started < timeoutMs) {
      assertActive(runId);
      if (hasAlreadyClaimed() || findClaimButton()) return;

      const text = normalize(document.body.innerText || "");
      const remainingMs = parseDetailReleaseCountdownMs(text);
      if (remainingMs !== null) {
        if (remainingMs > 1000) {
          if (remainingMs !== lastCountdown && Date.now() - lastReportAt > 1000) {
            lastCountdown = remainingMs;
            lastReportAt = Date.now();
            report(`详情页放号倒计时：${formatDuration(remainingMs)}，最后 1 秒进入抢单窗口`);
          }
          await wait(Math.min(Math.max(250, remainingMs - 1000), 5000));
          continue;
        }
        if (Date.now() - lastReportAt > 1000) {
          lastReportAt = Date.now();
          report(`详情页进入最后 1 秒抢单窗口：${formatDuration(Math.max(0, remainingMs))}`);
        }
        await wait(50);
        continue;
      }

      if (Date.now() - lastReportAt > 1500) {
        lastReportAt = Date.now();
        report("等待薪火详情页接取按钮可用");
      }
      await wait(pollMs);
    }
    throw new Error("薪火任务详情未显示接取状态");
  }

  function parseDetailReleaseCountdownMs(text) {
    const value = normalize(text);
    const seconds = value.match(/等待\s*(\d+)\s*秒(?:释放|开放)?(?:下一个)?席位?/i);
    if (seconds) return Number(seconds[1]) * 1000;
    const clock = value.match(/等待\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
    if (!clock) return null;
    const hasHours = Boolean(clock[3]);
    const hours = hasHours ? Number(clock[1]) : 0;
    const minutes = hasHours ? Number(clock[2]) : Number(clock[1]);
    const secondsPart = hasHours ? Number(clock[3]) : Number(clock[2]);
    return (hours * 3600 + minutes * 60 + secondsPart) * 1000;
  }

  async function claimCurrentDetail(candidate, settings, runId, claimStartedAt) {
    const claimButton = findClaimButton();
    if (claimButton) {
      claimButton.click();
      await waitFor(
        () => findClaimRiskConfirmButton() || hasAlreadyClaimed(),
        Math.min(15000, Math.max(5000, Number(settings.lockSeatTimeoutMs) || 60000)),
        "接取薪火任务后未显示风险确认或锁定状态"
      );
      assertActive(runId);
      const riskConfirmButton = findClaimRiskConfirmButton();
      if (riskConfirmButton) {
        report("检测到薪火接取前安全提醒，正在确认继续接取");
        riskConfirmButton.click();
      }
      const claimOutcome = await waitForClaimOutcome(settings, runId);
      if (!claimOutcome.claimed) {
        const task = {
          source: "xinhuo_claim_not_acquired",
          taskKey: candidate.taskKey,
          taskType: candidate.taskType,
          bounty: candidate.bounty,
          handle: candidate.handle,
          candidateTitle: candidate.title
        };
        report(`薪火未接到任务：${claimOutcome.reason}，立即返回任务广场继续扫描`);
        return {
          ok: false,
          retryable: true,
          returnToMarketplace: true,
          message: `薪火未接到任务：${claimOutcome.reason}`,
          task
        };
      }
    }

    const task = buildClaimedTask({
      claimStartedAt,
      source: "xinhuo_task_detail",
      taskKey: candidate.taskKey,
      taskType: candidate.taskType,
      bounty: candidate.bounty,
      handle: candidate.handle,
      candidateTitle: candidate.title
    });
    report(`已接取薪火 ${task.taskType} 任务：${task.bounty.toFixed(3)} KX，等待薪火网站打开目标 X`);
    return { ok: true, task };
  }

  function getManuallyClaimedTask(openedTask = {}) {
    const overrides = {
      source: "xinhuo_manual_claim",
      taskKey: location.pathname,
      candidateTitle: openedTask.candidateTitle || "手动接取的薪火任务"
    };
    if (openedTask.taskType) overrides.taskType = openedTask.taskType;
    if (Number(openedTask.bounty) > 0) overrides.bounty = Number(openedTask.bounty);
    if (openedTask.handle) overrides.handle = openedTask.handle;
    const task = buildClaimedTask(overrides);
    report(`检测到你已手动接取薪火 ${task.taskType} 任务，自动接管回复流程`);
    return { ok: true, task };
  }

  function buildClaimedTask(overrides = {}) {
    const detailText = normalize(document.body.innerText || "");
    if (/当前等级不可接取|当前等级无席位|无席位|接取失败|任务已满/.test(detailText)) {
      throw new Error("薪火任务不可接取：" + extractUnavailableReason(detailText));
    }
    const tweetUrl = Array.from(document.querySelectorAll('a[href*="x.com/"][href*="/status/"]'))
      .map((link) => link.href)
      .find(Boolean);
    if (!tweetUrl) throw new Error("薪火任务详情未找到目标 X 推文链接");
    return {
      platform: "xinhuo",
      claimed: true,
      detailPath: location.pathname,
      source: "xinhuo_task_detail",
      taskKey: location.pathname,
      taskType: /评论\+点赞/.test(detailText) ? "评论+点赞" : (/评论/.test(detailText) ? "评论" : (/点赞/.test(detailText) ? "点赞" : "")),
      bounty: parseBounty(detailText),
      tweetUrl,
      detailText: detailText.slice(0, 1000),
      minReplyChineseChars: 10,
      ...overrides
    };
  }

  function assertCurrentClaimedTask(task) {
    const expectedPath = String(task?.detailPath || task?.claimedDetailPath || "").trim();
    if (expectedPath && location.pathname !== expectedPath) {
      throw new Error(`薪火订单详情已变化：期望 ${expectedPath}，当前 ${location.pathname}`);
    }
    if (!/^\/tasks\/[^/?#]+$/.test(location.pathname)) {
      throw new Error(`当前不是已接取的薪火订单详情：${location.pathname}`);
    }
  }

  async function submitVerification(settings, task = {}) {
    const runId = activeRunId;
    assertActive(runId);
    assertCurrentClaimedTask(task);
    const taskPath = location.pathname;
    const existingState = getSubmissionState();
    if (existingState) return { ok: true, alreadySubmitted: true, state: existingState.kind, final: existingState.final, message: existingState.message };
    const button = findVerificationButton();
    if (!button) throw new Error("薪火详情未找到“提交并使用 X API 核验”按钮");
    button.scrollIntoView({ block: "center", inline: "nearest" });
    report("X 回复完成，正在点击薪火“提交并使用 X API 核验”");
    assertActive(runId);
    button.click();
    await waitFor(() => {
      return hasVerificationBeenSubmitted(taskPath);
    }, Math.max(10000, Number(settings.lockSeatTimeoutMs) || 60000), "薪火提交核验后未确认状态变化");
    return { ok: true, message: "薪火已提交 X API 核验" };
  }

  async function confirmAndWaitVerification(settings, task = {}) {
    assertCurrentClaimedTask(task);
    const existingState = getSubmissionState();
    if (existingState) return { ok: true, alreadySubmitted: true, state: existingState.kind, final: existingState.final, message: existingState.message };
    const submit = await submitVerification(settings, task);
    const result = await waitForSubmissionResult(settings, task);
    return { ...submit, ...result, message: result.message || submit.message };
  }

  async function waitForSubmissionResult(settings, task = {}) {
    const runId = activeRunId;
    assertCurrentClaimedTask(task);
    const timeoutMs = Math.max(15000, Number(settings.lockSeatTimeoutMs) || 60000);
    await waitFor(() => {
      assertActive(runId);
      assertCurrentClaimedTask(task);
      return getSubmissionState();
    }, timeoutMs, "薪火未显示任务已提交、待复核或核验成功状态");
    const state = getSubmissionState();
    return {
      ok: true,
      state: state.kind,
      final: state.final,
      success: state.success,
      evidence: buildSubmissionEvidence(task, state),
      message: state.message || "薪火已确认任务提交"
    };
  }

  function inspectCurrentTask(expectedTask = {}) {
    assertCurrentClaimedTask(expectedTask);
    const officialState = getSubmissionState();
    if (!hasAlreadyClaimed() && !officialState) {
      return { ok: false, claimed: false, message: "当前薪火详情未显示已接取订单控件或官方提交状态" };
    }
    const task = buildClaimedTask({ source: "xinhuo_interrupted_recovery" });
    return {
      ok: true,
      claimed: true,
      task: { ...task, officialState: officialState ? { ...officialState } : null }
    };
  }

  function buildSubmissionEvidence(task, state) {
    return {
      platform: "xinhuo",
      runId: activeRunId,
      taskKey: String(task?.taskKey || task?.detailPath || location.pathname),
      detailPath: location.pathname,
      tweetUrl: String(task?.tweetUrl || ""),
      state: state?.kind || "",
      success: state?.success !== false,
      message: state?.message || "",
      observedAt: new Date().toISOString()
    };
  }

  function getSubmissionResultText() {
    const text = getCurrentTaskDetailText();
    const state = getSubmissionState(text);
    return state?.message || "";
  }

  function getSubmissionState(text = "") {
    const values = (text || getCurrentTaskDetailText()).split("\n").map(normalize);
    for (const value of values) {
      if (/^(?:核验成功|任务通过|奖励已到账|已到账奖励|该任务已完成|任务核验已通过，奖励已结算)[。！!]?$/u.test(value)) {
        return { kind: "confirmed", final: true, success: true, message: `薪火状态已更新：${value}` };
      }
    }
    for (const value of values) {
      if (/^(?:待复核|审核中|核验中|提交成功|已提交任务|任务已提交|提交完成|平台处理中|任务核验已提交，等待平台处理|任务已提交，等待系统按计划核验|自动核验未能确认，现已转人工复核|X API 补验已结束，未能自动确认，现已转人工复核)[。！!]?$/u.test(value)) {
        return { kind: "pending", final: false, message: `薪火状态已更新：${value}` };
      }
    }
    for (const value of values) {
      if (/^(?:核验失败|任务未通过|任务失败|订单已取消|任务已取消|任务已过期|订单已过期|任务已失效)[。！!]?$/u.test(value)) {
        return { kind: "failed", final: true, success: false, message: `薪火状态已更新：${value}` };
      }
    }
    return null;
  }

  function findVerificationButton() {
    return Array.from(document.querySelectorAll("button, [role=\"button\"]"))
      .find((node) => /提交并使用 X API 核验/.test(normalize(node.innerText || "")) && !node.disabled) || null;
  }

  function hasVerificationBeenSubmitted(taskPath) {
    if (location.pathname !== taskPath) return false;
    if (getSubmissionState()?.final || getSubmissionState()?.kind === "pending") return true;
    const text = getCurrentTaskDetailText();
    return !findVerificationButton() && /已提交任务|任务已提交|提交完成|平台处理中/.test(text);
  }

  function getCurrentTaskDetailText() {
    if (!/^\/tasks\/[^/?#]+$/.test(location.pathname)) return "";
    const panel = document.querySelector("aside.reward-panel, [data-task-reward-panel], [data-reward-panel]");
    if (!panel) return "";
    return Array.from(panel.querySelectorAll(".reward-label,.message,.reviewing,.approved,.rejected,[role='status'],p,span,div"))
      .filter((node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
      .map((node) => normalize(node.innerText || ""))
      .filter((text) => text && text.length <= 160)
      .filter((text, index, values) => values.indexOf(text) === index)
      .join("\n");
  }

  function findClaimButton() {
    return Array.from(document.querySelectorAll("button"))
      .find((node) => /接取(?:评论|点赞|互动)?.*任务/.test(normalize(node.innerText || "")) && !node.disabled) || null;
  }

  function findClaimRiskConfirmButton() {
    return Array.from(document.querySelectorAll("button, [role=\"button\"]"))
      .find((node) => /我已了解.*继续接取|继续接取/.test(normalize(node.innerText || "")) && !node.disabled) || null;
  }

  function hasAlreadyClaimed() {
    return /提交并使用 X API 核验|放弃订单/.test(normalize(document.body.innerText || ""));
  }

  async function waitForClaimOutcome(settings, runId) {
    const timeoutMs = Math.max(15000, Number(settings.lockSeatTimeoutMs) || 60000);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      assertActive(runId);
      if (hasAlreadyClaimed()) return { claimed: true, reason: "" };
      const reason = getClaimFailureReason();
      if (reason) return { claimed: false, reason };
      await wait(250);
    }
    return { claimed: false, reason: "接取后未确认锁定成功" };
  }

  function getClaimFailureReason() {
    const text = normalize(document.body.innerText || "");
    const match = text.match(/接取失败[:：]?[^。！？\n]*|这个时段的名额刚被其他用户接取|下一个名额尚未释放|等待\s*\d+\s*秒释放下一个席位|当前等级不可接取|当前等级无席位|无席位|任务已满/);
    return match ? match[0] : "";
  }

  async function ensureTasksPage(settings) {
    const isTaskDetail = /^\/tasks\/[^/?#]+/.test(location.pathname);
    if (isTaskDetail && hasAlreadyClaimed()) return;
    if (location.pathname !== "/tasks") location.href = "https://xinhuo123.com/tasks";
    await waitFor(() => location.pathname === "/tasks", Math.max(10000, Number(settings.lockSeatTimeoutMs) || 60000), "等待薪火任务广场超时");
    await waitFor(() => findMarketplaceTaskAnchors().length > 0 || /暂无|共\s*\d+\s*个任务/.test(document.body.innerText || ""), 15000, "薪火任务列表未加载");
  }

  function parseBounty(text) {
    const match = normalize(text).match(/([0-9]+(?:\.[0-9]+)?)\s*KX\b/i);
    return match ? Number(match[1]) : 0;
  }

  function parseCooldownMs(text) {
    const value = normalize(text);
    const match = value.match(/等待\s*(\d+)\s*秒/);
    if (match) return Number(match[1]) * 1000;
    const clock = value.match(/(\d{1,2}):(\d{2})/);
    return clock ? (Number(clock[1]) * 60 + Number(clock[2])) * 1000 : 0;
  }

  function extractUnavailableReason(text) {
    return (text.match(/接取失败[:：]?[^。！？\n]*|这个时段的名额刚被其他用户接取|下一个名额尚未释放|等待\s*\d+\s*秒释放下一个席位|当前等级不可接取|当前等级无席位|无席位|任务已满/) || ["任务状态不允许接取"])[0];
  }

  function report(text, level = "info", phase = "") {
    // The debug panel labels every entry by page phase; derive a real one from
    // the URL instead of stamping a constant "xinhuo" on all logs.
    const resolved = phase
      || (/^\/tasks\/[^/?#]+/.test(location.pathname) ? "detail" : (location.pathname === "/tasks" ? "marketplace" : "xinhuo"));
    chrome.runtime.sendMessage({ type: "CONTENT_LOG", runId: activeRunId, level, text, page: { phase: resolved } });
  }

  function assertActive(runId) {
    if (!runId || cancelledRunIds.has(runId) || runId !== activeRunId) throw new Error("薪火流程已停止");
  }

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, timeoutMs, message) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await wait(250);
    }
    throw new Error(message);
  }
})();

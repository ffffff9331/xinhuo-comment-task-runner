"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TWEET = "https://x.com/test/status/123";
const DETAIL = "/tasks/test-order";
const TASK = { taskKey: DETAIL, detailPath: DETAIL, tweetUrl: TWEET };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

// Full production listener and functions; only the particular async I/O
// boundary under test is replaced by a controlled promise. No real browser.
function harness(kind, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, `../src/content/${kind}.js`), "utf8");
  let listener;
  const calls = { messages: [], clicks: 0, scrolls: 0, actions: 0 };
  const node = { click() { calls.clicks++; }, scrollIntoView() { calls.scrolls++; },
    focus() { calls.actions++; }, blur() { calls.actions++; }, contains() { return true; },
    dispatchEvent() { calls.actions++; }, getAttribute() { return null; },
    getBoundingClientRect() { return { width: 100, height: 30 }; } };
  const runtime = { id: "stop-reset-test", getURL: () => "chrome-extension://stop-reset-test/",
    onMessage: { addListener(fn) { listener = fn; }, hasListener(fn) { return fn === listener; }, removeListener() {} },
    async sendMessage(message) { calls.messages.push(message); return { ok: true, replyText: "test reply" }; } };
  const document = { body: { innerText: "", focus: node.focus }, activeElement: node,
    querySelector() { return null; }, querySelectorAll() { return []; }, execCommand() { calls.actions++; } };
  const c = vm.createContext({ console, URL, Date, setTimeout, clearTimeout, location: { href: kind === "x" ? TWEET : `https://xinhuo123.com${DETAIL}`, pathname: DETAIL },
    document, chrome: { runtime }, window: {}, hooks: overrides, getComputedStyle: () => ({ display: "block", visibility: "visible" }) });
  const api = kind === "x" ? `{
    seed(runId) { activeRunId=runId; activeTargetUrl=${JSON.stringify(TWEET)}; },
    read() { return { runId:activeRunId, target:activeTargetUrl, key:activeStepKey, name:activeStepName, started:activeStepStartedAt, cache:stepResults.size, lock:globalThis[RUN_LOCK_KEY] }; },
    execute: executeXStep, runReply, clickElement, openReplyComposer, fillReplyText, activateReplyInput,
    clearReplyBoxIfNeeded, pasteTextLikeUser, setReplyComposerTextNatively, insertReplyTextViaCharacterPaste,
    detectExistingReplyBeforeWriting, completeTaskWidgetLifecycle, assertActiveRun,
    replace() { globalThis[SINGLETON_KEY] = { active:true, instanceId:"replacement" }; }
  }` : `{
    seed(runId, pending) { activeRunId=runId; claimActionStarted=true; if(pending) claimOperation={ runId, promise:pending }; },
    read() { return { runId:activeRunId, operation:claimOperation, actionStarted:claimActionStarted }; },
    claimCurrentDetail, openAndClaim, confirmAndWaitVerification, waitForSubmissionResult, report, waitFor,
    replace() { instance.active=false; }
  }`;
  const adapter = `globalThis.testApi=${api};\n` + Object.keys(overrides).map(name => `${name}=hooks[${JSON.stringify(name)}];`).join("\n");
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapter + source.slice(end), c);
  const send = message => new Promise(resolve => listener(message, {}, resolve));
  const stop = (runId = "old") => send({ type: kind === "x" ? "CANCEL_X_RUN" : "CANCEL_XINHUO_RUN", runId, reset: true });
  return { c, api: c.testApi, send, stop, calls, node, runtime, document };
}
const xMessage = (runId = "old") => ({ type: "RUN_X_REPLY", platform: "xinhuo", runId, task: TASK, settings: {} });
const stopped = /停止|取消|失效|替换/;

for (const type of ["XINHUO_SELECT_AND_CLAIM", "DEBUG_XINHUO_OPEN_FIRST_TASK", "DEBUG_XINHUO_CLAIM_CURRENT_TASK"]) {
  test(`STOP before queued ${type} prevents entering any old action`, async () => {
    let actions = 0;
    const action = () => { actions++; return { ok:true }; };
    const p = harness("xinhuo", { selectAndClaim:action, openFirstReadyTask:action, claimCurrentTask:action });
    const result = p.send({ type, runId:"old" });
    await p.stop();
    assert.equal((await result).ok, false);
    assert.equal(actions, 0);
  });
}

test("Xinhuo reset clears actual active claim state even when cancel carries another run", async () => {
  const p = harness("xinhuo"); const hold = deferred();
  p.api.seed("actual-old", hold.promise);
  await p.stop("reported-old");
  assert.equal(p.api.read().operation, null);
  assert.equal(p.api.read().actionStarted, false);
  assert.equal(p.api.read().runId, "");
  for (const runId of ["actual-old", "reported-old"]) {
    const result = await p.send({ type:"DEBUG_XINHUO_CLAIM_CURRENT_TASK", runId });
    assert.equal(result.cancelled, true);
  }
});

test("ordinary cancellation of an unrelated old run does not stop the current claim", async () => {
  const p = harness("xinhuo"); const hold = deferred(); p.api.seed("current", hold.promise);
  await p.send({ type:"CANCEL_XINHUO_RUN", runId:"older" });
  assert.equal(p.api.read().runId, "current");
  assert.equal(p.api.read().operation.runId, "current");
});

test("Xinhuo fresh explicit run starts before old promise settles and old finally cannot erase it", async () => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const p = harness("xinhuo", { selectAndClaim:() => (++calls === 1 ? old.promise : fresh.promise) });
  const first = p.send({ type:"XINHUO_SELECT_AND_CLAIM", runId:"old" }); await flush();
  await p.stop();
  const next = p.send({ type:"XINHUO_SELECT_AND_CLAIM", runId:"fresh" }); await flush();
  assert.equal(calls, 2, "old promise must not block a new explicit run");
  old.resolve({ ok:true }); await first;
  assert.equal(p.api.read().operation.runId, "fresh");
  fresh.resolve({ ok:true }); assert.equal((await next).ok, true);
});

test("untagged old claim messages cannot restart after hard reset", async () => {
  let actions=0; const p=harness("xinhuo", { selectAndClaim:() => { actions++; return {ok:true}; } });
  p.api.seed("old"); await p.stop();
  const result=await p.send({type:"XINHUO_SELECT_AND_CLAIM"});
  assert.equal(result.ok,false); assert.equal(actions,0);
});

test("STOP while claim authorization is pending prevents clicking the claim control", async () => {
  const intent=deferred(); const p=harness("xinhuo", { findClaimButton:() => p.node, buildOpenedTask:() => TASK });
  p.runtime.sendMessage=() => intent.promise; p.api.seed("old");
  const claim=p.api.claimCurrentDetail(TASK,{},"old",Date.now());
  await p.stop(); intent.resolve({ok:true,taskKey:DETAIL});
  await assert.rejects(claim,stopped); assert.equal(p.calls.clicks,0);
});

test("STOP during claim outcome cannot log or return a late claimed result under a new run", async () => {
  const outcome=deferred(); const p=harness("xinhuo", { findClaimButton:() => p.node,
    buildOpenedTask:() => TASK, waitFor:async()=>true, findClaimRiskConfirmButton:()=>null,
    waitForClaimOutcome:()=>outcome.promise, buildClaimedTask:()=>({...TASK,bounty:1,taskType:"点赞"}) });
  p.api.seed("old"); const claim=p.api.claimCurrentDetail(TASK,{},"old",Date.now()); await flush();
  await p.stop(); p.api.seed("fresh"); const before=p.calls.messages.length;
  outcome.resolve({claimed:true}); await assert.rejects(claim,stopped);
  assert.equal(p.calls.messages.length,before);
});

test("STOP during detail hydration cannot emit a late log or continue into claim", async () => {
  const hydration=deferred(); let claims=0;
  const p=harness("xinhuo", { waitFor:async()=>true, waitForClaimButtonAfterHydration:()=>hydration.promise,
    claimCurrentDetail:()=>{claims++;return {ok:true};} });
  p.api.seed("old"); const operation=p.api.openAndClaim({...TASK,href:`https://xinhuo123.com${DETAIL}`,anchor:p.node},{},"old");
  await flush(); await p.stop(); p.api.seed("fresh"); const before=p.calls.messages.length;
  hydration.resolve(); await assert.rejects(operation,stopped);
  assert.equal(claims,0); assert.equal(p.calls.messages.length,before);
});

test("STOP prevents confirmation from chaining a pending submission into a fresh wait", async () => {
  const submitted=deferred(); let waits=0; const p=harness("xinhuo", { assertCurrentClaimedTask:()=>{},
    getSubmissionState:()=>null, submitVerification:()=>submitted.promise,
    waitForSubmissionResult:()=>{waits++;return {ok:true};} });
  p.api.seed("old"); const operation=p.api.confirmAndWaitVerification({},TASK);
  await p.stop(); p.api.seed("fresh"); submitted.resolve({ok:true});
  await assert.rejects(operation,stopped); assert.equal(waits,0);
});

test("Xinhuo old polling promise cannot run its predicate after reset and a new run", async () => {
  const tick=deferred(); let predicates=0; const p=harness("xinhuo",{wait:()=>tick.promise});
  p.api.seed("old"); const polling=p.api.waitFor(()=>++predicates>1,10000,"timeout");
  await p.stop(); p.api.seed("fresh"); tick.resolve();
  await assert.rejects(polling,stopped); assert.equal(predicates,1);
});

test("stopped Xinhuo content does not emit a new log", async () => {
  const p=harness("xinhuo"); p.api.seed("old"); await p.stop(); p.api.report("late log");
  assert.equal(p.calls.messages.length,0);
});

test("read-only task inspection stays available after STOP", async () => {
  const p=harness("xinhuo",{inspectCurrentTask:()=>({ok:true,inspectionState:"unclaimed"})});
  p.api.seed("old"); await p.stop();
  assert.equal((await p.send({type:"XINHUO_INSPECT_CURRENT_TASK",runId:"old",task:TASK})).inspectionState,"unclaimed");
  assert.equal(p.calls.clicks,0); assert.equal(p.calls.messages.length,0);
});

test("X normal explicit run executes once and duplicate message shares its promise", async () => {
  const hold=deferred(); let actions=0; const p=harness("x",{runReply:()=>{actions++;return hold.promise;}});
  const first=p.send(xMessage()); const duplicate=p.send(xMessage()); await flush(); assert.equal(actions,1);
  hold.resolve({ok:true}); assert.equal((await first).ok,true); assert.equal((await duplicate).ok,true);
});

test("X reset clears runtime, cache and actual active lock despite a mismatched supplied run", async () => {
  const hold=deferred(); const p=harness("x",{runReply:()=>hold.promise});
  const old=p.send(xMessage("actual-old")); await flush(); await p.stop("reported-old");
  const state=p.api.read(); assert.equal(state.runId,""); assert.equal(state.target,""); assert.equal(state.key,"");
  assert.equal(state.name,""); assert.equal(state.started,0); assert.equal(state.cache,0); assert.equal(Boolean(state.lock?.active),false);
  for(const runId of ["actual-old","reported-old"]) assert.equal((await p.send(xMessage(runId))).cancelled,true);
  hold.resolve({ok:true}); assert.equal((await old).ok,false);
});

test("X old finally cannot release the new run lock or permit a concurrent third run", async () => {
  const old=deferred(), fresh=deferred(); let calls=0; const p=harness("x",{runReply:()=>++calls===1?old.promise:fresh.promise});
  const first=p.send(xMessage()); await flush(); await p.stop();
  const next=p.send(xMessage("fresh")); await flush(); assert.equal(calls,2);
  old.resolve({ok:true}); assert.equal((await first).ok,false);
  assert.equal(p.api.read().lock.active,true); assert.equal(p.api.read().lock.runId,"fresh"); assert.ok(p.api.read().key);
  assert.equal((await p.send(xMessage("third"))).conflict,true);
  fresh.resolve({ok:true}); assert.equal((await next).ok,true);
});

test("ordinary X cancellation of an unrelated old run preserves current execution", async () => {
  const hold=deferred(); const p=harness("x",{runReply:()=>hold.promise});
  const current=p.send(xMessage("current")); await flush();
  await p.send({type:"CANCEL_X_RUN",runId:"older"}); assert.equal(p.api.read().runId,"current");
  hold.resolve({ok:true}); assert.equal((await current).ok,true);
});

test("X replaced singleton cannot finish or continue an old callback", async () => {
  const hold=deferred(); const p=harness("x",{runReply:()=>hold.promise});
  const old=p.send(xMessage()); await flush(); p.api.replace(); hold.resolve({ok:true});
  assert.equal((await old).ok,false);
});

for(const boundary of ["follow","like","dedupe","composer","fill","bridge"]) {
  test(`X STOP during ${boundary} blocks every later reply phase after a new run starts`, async () => {
    const hold=deferred(); const later=[]; let reached=false;
    const phase=(name,value)=>()=>{if(name===boundary){reached=true;return hold.promise;}if(reached)later.push(name);return value;};
    const p=harness("x",{waitForPageReady:async()=>{},assertNotLoginWall:()=>{},scrapeCurrentTweet:()=>({url:TWEET}),
      simulateReadingBeforeReply:async()=>{},inferTaskActions:()=>({needsFollow:true,needsLike:true,needsComment:true}),
      followCurrentTweetAuthorIfNeeded:phase("follow",{ok:true}),likeCurrentTweetIfNeeded:phase("like",{ok:true}),
      detectExistingReplyBeforeWriting:phase("dedupe",{replied:false}),trySolaBridge:phase("bridge",{ok:false}),
      openReplyComposer:phase("composer",undefined),fillReplyText:phase("fill",undefined),
      clickPostButtonAndVerify:phase("post",{ok:true})});
    p.api.seed("old"); const action=p.api.runReply(TASK,{replyProvider:boundary==="bridge"?"sola_bridge":"native"}); await flush();
    assert.equal(reached,true); await p.stop(); p.api.seed("fresh");
    hold.resolve(boundary==="dedupe"?{replied:false}:{ok:true});
    await assert.rejects(action,stopped); assert.deepEqual(later,[]);
  });
}

test("X click delay cannot click or scroll after STOP even if the awaited delay already resolved", async () => {
  const delay=deferred(); const p=harness("x",{randomClickDelay:()=>delay.promise}); p.api.seed("old");
  const action=p.api.clickElement(p.node); delay.resolve(); await p.stop(); p.api.seed("fresh");
  await assert.rejects(action,stopped); assert.equal(p.calls.clicks,0); assert.equal(p.calls.scrolls,0);
});

test("X dedupe callback cannot begin another scan after STOP", async () => {
  const local=deferred(); let scans=0; const p=harness("x",{queryLocalReplyHistory:()=>local.promise,
    findExistingOwnReplyOnPage:()=>{scans++;return {replied:false};}}); p.api.seed("old");
  const action=p.api.detectExistingReplyBeforeWriting({url:TWEET},TASK,{}); await p.stop(); p.api.seed("fresh");
  local.resolve({replied:false}); await assert.rejects(action,stopped); assert.equal(scans,0);
});

test("X soft composer lookup cannot continue to scroll or open composer after STOP", async () => {
  const box=deferred(); let searches=0; const p=harness("x",{findReplyBox:()=>box.promise,
    waitFor:()=>{searches++;return p.node;},wait:async()=>{},clickElement:async()=>{}}); p.api.seed("old");
  const action=p.api.openReplyComposer({actionDelayMs:0}); await p.stop(); p.api.seed("fresh"); box.resolve(null);
  await assert.rejects(action,stopped); assert.equal(searches,0); assert.equal(p.calls.scrolls,0);
});

test("X input activation cannot focus after STOP during a click", async () => {
  const clicked=deferred(); const p=harness("x",{clickElement:()=>clicked.promise}); p.api.seed("old");
  const action=p.api.activateReplyInput(p.node); await p.stop(); p.api.seed("fresh"); const before=p.calls.actions;
  clicked.resolve(); await assert.rejects(action,stopped); assert.equal(p.calls.actions,before);
});

test("X failed whole paste cannot clear or fall back to character writes after STOP", async () => {
  const paste=deferred(); let writes=0; const p=harness("x",{getReplyComposerText:()=>"",tryWholeTextPasteOnce:()=>paste.promise,
    clearReplyBoxIfNeeded:async()=>{writes++;},insertReplyTextViaCharacterPaste:async()=>{writes++;return {success:false};}}); p.api.seed("old");
  const action=p.api.setReplyComposerTextNatively(p.node,"hello"); await p.stop(); p.api.seed("fresh"); paste.resolve({success:false});
  await assert.rejects(action,stopped); assert.equal(writes,0);
});

test("X character paste cannot dispatch its first character after STOP during input activation", async () => {
  const activated=deferred(); let writes=0; const p=harness("x",{activateReplyInput:()=>activated.promise,wait:async()=>{},getReplyComposerText:()=>"",
    dispatchReplyPasteText:()=>{writes++;return {success:false};}}); p.api.seed("old");
  const action=p.api.insertReplyTextViaCharacterPaste(p.node,"hello"); await p.stop(); p.api.seed("fresh"); activated.resolve(true);
  await assert.rejects(action,stopped); assert.equal(writes,0);
});

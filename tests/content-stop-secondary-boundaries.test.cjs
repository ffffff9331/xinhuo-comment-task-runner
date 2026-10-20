"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
// Reuse the immutable full-production harness without registering its tests.
const fixture = path.join(__dirname, "content-stop-reset.test.cjs");
const source = fs.readFileSync(fixture, "utf8");
const loaded = new Module(fixture, module);
loaded.filename = fixture;
loaded._compile(source.slice(0, source.indexOf("for (const type of")) + "\nmodule.exports={harness,deferred,flush,stopped,TASK};", fixture);
const { harness, deferred, flush, stopped, TASK } = loaded.exports;

test("X STOP during widget submit does not start a fresh submission polling operation", async () => {
  const submit=deferred(); let polls=0;
  const p=harness("x",{findXinhuoTaskWidget:()=>({}),findXinhuoSubmitButton:()=>p.node,
    getNodeActionText:()=>"提交任务",activateXinhuoSubmitButton:()=>submit.promise,
    waitForXinhuoTaskWidgetSubmission:()=>{polls++;return "已提交任务";}});
  p.api.seed("old"); const operation=p.api.completeTaskWidgetLifecycle({}); await flush();
  await p.stop(); p.api.seed("fresh"); submit.resolve();
  await assert.rejects(operation,stopped); assert.equal(polls,0);
});

test("X STOP while clear-input activation is pending prevents deletion and input events", async () => {
  const activated=deferred(); let writes=0;
  const p=harness("x",{activateReplyInput:()=>activated.promise,getReplyComposerText:()=>"",
    dispatchReplyComposerInputEvents:()=>{writes++;}});
  p.api.seed("old"); const operation=p.api.clearReplyBoxIfNeeded(p.node);
  await p.stop(); p.api.seed("fresh"); activated.resolve(true);
  await assert.rejects(operation,stopped); assert.equal(writes,0); assert.equal(p.calls.actions,0);
});

test("X STOP while paste-input activation is pending prevents any new write", async () => {
  const activated=deferred(); let writes=0;
  const p=harness("x",{activateReplyInput:()=>activated.promise,wait:async()=>{},getReplyComposerText:()=>"",
    writeReplyTextOnce:()=>{writes++;return {success:false};}});
  p.api.seed("old"); const operation=p.api.pasteTextLikeUser("hello",p.node);
  await p.stop(); p.api.seed("fresh"); activated.resolve(true);
  await assert.rejects(operation,stopped); assert.equal(writes,0);
});

test("X STOP while fill-input lookup is pending prevents activating the composer", async () => {
  const box=deferred(); let activations=0;
  const p=harness("x",{findReplyBox:()=>box.promise,activateReplyInput:()=>{activations++;return true;},
    wait:async()=>{},clearReplyBoxIfNeeded:async()=>{},pasteTextLikeUser:async()=>{},waitForReplyBoxContentStable:()=>true});
  p.api.seed("old"); const operation=p.api.fillReplyText("hello",{actionDelayMs:0});
  await p.stop(); p.api.seed("fresh"); box.resolve(p.node);
  await assert.rejects(operation,stopped); assert.equal(activations,0);
});

test("X STOP in fill-only mode cannot return a successful completed fill result", async () => {
  const fill=deferred(); const p=harness("x",{waitForPageReady:async()=>{},assertNotLoginWall:()=>{},
    scrapeCurrentTweet:()=>({url:TASK.tweetUrl}),simulateReadingBeforeReply:async()=>{},
    inferTaskActions:()=>({needsComment:true}),detectExistingReplyBeforeWriting:async()=>({replied:false}),
    openReplyComposer:async()=>{},fillReplyText:()=>fill.promise});
  p.api.seed("old"); const operation=p.api.runReply(TASK,{replyMode:"fill"}); await flush();
  await p.stop(); p.api.seed("fresh"); fill.resolve(); await assert.rejects(operation,stopped);
});

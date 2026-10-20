"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path"), Module=require("node:module");
const fixture=path.join(__dirname,"content-stop-reset.test.cjs"), source=fs.readFileSync(fixture,"utf8");
const loaded=new Module(fixture,module); loaded.filename=fixture;
loaded._compile(source.slice(0,source.indexOf("for (const type of"))+"\nmodule.exports={harness,deferred,flush,stopped,TASK};",fixture);
const {harness,deferred,flush,stopped,TASK}=loaded.exports;

test("STOP during the visible-reply scan prevents another scroll after a fresh run starts",async()=>{
  const tick=deferred(); let scrolls=0;
  const p=harness("x",{queryLocalReplyHistory:async()=>({replied:false}),getCurrentAccountHandle:()=>"@me",
    findMainTweetArticle:()=>null,findVisibleOwnReplyArticle:()=>null,wait:()=>tick.promise});
  p.c.window.scrollBy=()=>{scrolls++;}; p.c.window.innerHeight=1000;
  p.api.seed("old"); const operation=p.api.detectExistingReplyBeforeWriting({url:TASK.tweetUrl},TASK,{});
  await flush(); assert.equal(scrolls,1); await p.stop(); p.api.seed("fresh"); tick.resolve();
  await assert.rejects(operation,stopped); assert.equal(scrolls,1);
});

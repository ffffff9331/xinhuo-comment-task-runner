import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
const baseline = process.env.XINHUO_TEST_BASELINE === '1';
const read = (file) => baseline ? execFileSync('git', ['show', `HEAD:${file}`], {encoding:'utf8'}) : readFileSync(new URL(`../${file}`, import.meta.url),'utf8');
const background = read('src/background.js');
const page = read('src/content/xinhuo.js');
let passed=0, failed=0;
async function test(name, fn) { try { await fn(); passed++; console.log(`PASS ${name}`); } catch(e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } }
function declaration(source,name) {
  const m=new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`,'m').exec(source);
  assert.ok(m,`Missing function ${name}`);
  const re=new RegExp(`^${m[1]}(?:async )?function \\w+\\(`,'gm'); re.lastIndex=m.index+m[0].length;
  const end=re.exec(source)?.index ?? source.lastIndexOf('})();');
  return source.slice(m.index,end > m.index ? end : source.length);
}
function context(source,names,globals={}) {
  const c=vm.createContext({URL,console,setTimeout,clearTimeout,...globals});
  names.forEach(n=>vm.runInContext(declaration(source,n),c));return c;
}
function messaging(send) {
  const state={running:true,mode:'auto',stage:'selecting_task',runId:'r',xinhuoTabId:1};
  let injections=0, saves=0;
  const c=context(background,['sendToTab','isMissingReceiver'],{
    runtimeState:state,chrome:{tabs:{sendMessage:send}},
    ensureXinhuoContentReady:async()=>({ok:true}),
    toContentSettings:s=>s, delay:async()=>{}, log(){},
    setStage:s=>{state.stage=s;},
    persistRuntimeState:async()=>{saves++;},
    injectContentScript:async()=>{injections++;return true;},
    mergeXinhuoTask:(a,b)=>({...a,...b}),getXinhuoTaskIdentity:t=>t?.taskKey || ''
  });return {c,state,injections:()=>injections,saves:()=>saves};
}
await test('waiting for a candidate never persists an unknown claim',async()=>{
  let finish,sent;const entered=new Promise(r=>{sent=r;});
  const h=messaging(()=>{sent();return new Promise(r=>{finish=r;});});
  const operation=h.c.sendToTab(1,{type:'XINHUO_SELECT_AND_CLAIM',runId:'r'});
  await entered;
  try {assert.equal(h.state.uncertainAction,undefined);} finally {
    h.state.running=false;finish({ok:false,cancelled:true});await operation;
  }
});
await test('stop on a missing receiver neither reinjects nor retries',async()=>{
  let sends=0;const h=messaging(async()=>{sends++;throw new Error('Could not establish connection. Receiving end does not exist.');});
  const result=await h.c.sendToTab(1,{type:'CANCEL_XINHUO_RUN',runId:'r'});
  assert.equal(sends,1);assert.equal(h.injections(),0);assert.equal(result.ok,true);
});
await test('claim timeout preserves uncertainty instead of reporting unclaimed',async()=>{
  let now=0;const c=context(page,['waitForClaimOutcome'],{
    Date:{now:()=>now},assertActive(){},hasAlreadyClaimed:()=>false,getClaimFailureReason:()=>'',
    wait:async(ms)=>{now+=ms;}
  });
  await assert.rejects(c.waitForClaimOutcome({lockSeatTimeoutMs:15000},'r'),/未确认锁定结果/);
});
function runtime() {
  const listeners=new Set();return {id:'test',getURL:()=> 'chrome-extension://test/',
    onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),hasListener:fn=>listeners.has(fn)},listeners};
}
await test('same-version reinjection recovers a dead extension context',()=>{
  const old=runtime();const c=vm.createContext({chrome:{runtime:old},URL,console});
  vm.runInContext(page,c);old.id=undefined;old.listeners.clear();
  const fresh=runtime();c.chrome.runtime=fresh;vm.runInContext(page,c);
  assert.equal(fresh.listeners.size,1);
});
await test('healthy same-version injection has exactly one receiver',()=>{
  const rt=runtime();const c=vm.createContext({chrome:{runtime:rt},URL,console});
  vm.runInContext(page,c);vm.runInContext(page,c);assert.equal(rt.listeners.size,1);
});
if(!baseline) {
await test('scan disconnection before any claim is safely recoverable',async()=>{
  let sends=0;const h=messaging(async()=>{sends++;throw new Error('The message port closed before a response was received.');});
  const r=await h.c.sendToTab(1,{type:'XINHUO_SELECT_AND_CLAIM',runId:'r'});
  assert.equal(r.retryable,true);assert.equal(r.task.claimed,false);assert.equal(h.state.uncertainAction,undefined);assert.equal(sends,1);
});
await test('lost response after claim intent is retained and never replayed',async()=>{
  let sends=0;let h;h=messaging(async()=>{sends++;h.state.uncertainAction={type:'XINHUO_CLAIM',protocol:1,runId:'r',tabId:1,taskKey:'/tasks/a'};throw new Error('The message port closed.');});
  const r=await h.c.sendToTab(1,{type:'XINHUO_SELECT_AND_CLAIM',runId:'r'});
  assert.equal(r.uncertain,true);assert.equal(h.state.running,false);assert.equal(h.state.uncertainAction.taskKey,'/tasks/a');assert.equal(sends,1);assert.ok(h.saves()>0);
});
await test('explicit seat-race failure releases only its own claim intent',async()=>{
  let h;h=messaging(async()=>{h.state.uncertainAction={type:'XINHUO_CLAIM',protocol:1,runId:'r',tabId:1,taskKey:'/tasks/a'};return {ok:false,retryable:true,returnToMarketplace:true,task:{claimed:false,taskKey:'/tasks/a'}};});
  await h.c.sendToTab(1,{type:'XINHUO_SELECT_AND_CLAIM',runId:'r'});
  assert.equal(h.state.uncertainAction,undefined);assert.equal(h.state.running,true);
});
await test('claim intent is acknowledged only after durable identity and rejects wrong tabs',async()=>{
  let stored,release,entered;const saving=new Promise(resolve=>{entered=resolve;});const state={running:true,runId:'r',xinhuoTabId:1};
  const c=context(background,['recordXinhuoClaimIntent','getXinhuoTaskIdentity','normalizeXinhuoTaskPath','normalizeTweetUrl'],{
    runtimeState:state,XINHUO_TASKS_URL:'https://xinhuo123.com/tasks',setStage(){},log(){},getSettings:async()=>({aiApiKey:'fixture-key'}),
    chrome:{tabs:{get:async()=>({url:'https://xinhuo123.com/tasks/a'}),sendMessage:async()=>({ok:true,path:'/tasks/a',claimProtocol:1})}},
    persistRuntimeState:()=>{stored=JSON.parse(JSON.stringify(state));entered();return new Promise(r=>{release=r;});}
  });
  const msg={runId:'r',task:{taskKey:'/tasks/a',tweetUrl:'https://x.com/a/status/123'}};
  assert.equal((await c.recordXinhuoClaimIntent(msg,{url:'https://xinhuo123.com/tasks/a',tab:{id:2}})).ok,false);
  let acknowledged=false;const pending=c.recordXinhuoClaimIntent(msg,{url:'https://xinhuo123.com/tasks/a',tab:{id:1}}).then(r=>{acknowledged=r.ok;});
  await saving;assert.equal(acknowledged,false);assert.equal(stored.uncertainAction.taskKey,'/tasks/a');assert.equal(stored.currentTask.tweetUrl,msg.task.tweetUrl);
  release();await pending;assert.equal(acknowledged,true);
});
await test('a task detail can authorize its identity before the target tweet link is revealed',async()=>{
  const state={running:true,runId:'r',xinhuoTabId:1};
  const c=context(background,['recordXinhuoClaimIntent','getXinhuoTaskIdentity','normalizeXinhuoTaskPath'],{
    runtimeState:state,XINHUO_TASKS_URL:'https://xinhuo123.com/tasks',setStage(){},log(){},persistRuntimeState:async()=>{},getSettings:async()=>({aiApiKey:'fixture-key'}),
    chrome:{tabs:{get:async()=>({url:'https://xinhuo123.com/tasks/a'}),sendMessage:async()=>({ok:true,path:'/tasks/a',claimProtocol:1})}}
  });
  const result=await c.recordXinhuoClaimIntent({runId:'r',task:{taskKey:'/tasks/a',tweetUrl:''}},{url:'https://xinhuo123.com/tasks/a',tab:{id:1}});
  assert.equal(result.ok,true);assert.equal(state.uncertainAction.taskKey,'/tasks/a');
});
function claimIdentity(overrides={}) {
  const state={running:true,runId:'r',xinhuoTabId:1};let saved=0,target;
  const c=context(background,['recordXinhuoClaimIntent','getXinhuoTaskIdentity','normalizeXinhuoTaskPath'],{
    runtimeState:state,XINHUO_TASKS_URL:'https://xinhuo123.com/tasks',setStage(){},log(){},persistRuntimeState:async()=>{saved++;},getSettings:async()=>({aiApiKey:'fixture-key'}),
    chrome:{tabs:{get:overrides.get || (async()=>({url:overrides.tabUrl || 'https://xinhuo123.com/tasks/a'})),
      sendMessage:async(_id,_message,options)=>{target=options;return overrides.snapshot || {ok:true,claimProtocol:1,path:'/tasks/a'};}}}
  });
  const message={runId:'r',task:{taskKey:'/tasks/a'}};
  const sender={url:'https://xinhuo123.com/tasks',documentId:'originating-document',frameId:0,documentLifecycle:'active',tab:{id:1}};
  return {c,state,message,sender,saved:()=>saved,target:()=>target};
}
await test('SPA claims validate the current tab and target the originating document',async()=>{
  const h=claimIdentity();const r=await h.c.recordXinhuoClaimIntent(h.message,h.sender);
  assert.equal(r.ok,true);assert.equal(h.target().documentId,'originating-document');assert.equal(h.saved(),1);
});
await test('matching historical sender URL cannot authorize a different live tab or origin',async()=>{
  for(const tabUrl of ['https://xinhuo123.com/tasks/b','https://example.com/tasks/a']) {
    const h=claimIdentity({tabUrl});h.sender.url='https://xinhuo123.com/tasks/a';
    const r=await h.c.recordXinhuoClaimIntent(h.message,h.sender);assert.equal(r.ok,false);assert.equal(h.saved(),0);assert.equal(h.state.uncertainAction,undefined);
  }
});
await test('a document that has left the expected detail cannot authorize a claim',async()=>{
  const h=claimIdentity({snapshot:{ok:true,claimProtocol:1,path:'/tasks/b'}});
  const r=await h.c.recordXinhuoClaimIntent(h.message,h.sender);assert.equal(r.ok,false);assert.equal(h.saved(),0);
});
await test('stop while resolving the live tab prevents persistence and authorization',async()=>{
  let release;const h=claimIdentity({get:()=>new Promise(resolve=>{release=resolve;})});
  const pending=h.c.recordXinhuoClaimIntent(h.message,h.sender);h.state.running=false;release({url:'https://xinhuo123.com/tasks/a'});
  assert.equal((await pending).ok,false);assert.equal(h.saved(),0);
});
await test('concurrent claim intents can authorize only one click',async()=>{
  const h=claimIdentity();const results=await Promise.all([h.c.recordXinhuoClaimIntent(h.message,h.sender),h.c.recordXinhuoClaimIntent(h.message,h.sender)]);
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(h.saved(),1);
});
await test('navigation during durable claim authorization never clicks the new page',async()=>{
  let clicks=0;const location={pathname:'/tasks/a'};
  const c=context(page,['claimCurrentDetail'],{location,findClaimButton:()=>({click(){clicks++;}}),hasAlreadyClaimed:()=>false,assertActive(){},
    contextRuntime:{sendMessage:async()=>{location.pathname='/tasks/b';return {ok:true,taskKey:'/tasks/a'};}},buildOpenedTask:()=>({taskKey:'/tasks/a'})});
  await assert.rejects(c.claimCurrentDetail({}, {},'r',Date.now()),/页面已切换/);assert.equal(clicks,0);
});
await test('claim guard errors stop selection instead of cycling through all candidates',async()=>{
  const c=context(page,['selectAndClaim'],{activeRunId:'r',claimActionStarted:false,ensureTasksPage:async()=>{},assertActive(){},
    normalizeAttemptedTaskRecords:()=>[],getActiveAttemptedTaskKeys:()=>new Set(),hasAlreadyClaimed:()=>false,meetsMinimumBounty:()=>true,
    collectCandidates:()=>[{ready:true,taskKey:'/tasks/a',href:'https://xinhuo123.com/tasks/a'}],isClaimWindowCandidate:()=>false,report(){},
    openAndClaim:async()=>{throw Object.assign(new Error('claim guard failed'),{failureType:'claim_guard_rejected'});}});
  const result=await c.selectAndClaim({},[]);assert.equal(result.ok,false);assert.equal(result.retryable,false);assert.equal(result.returnToMarketplace,false);
});
await test('claim button is never clicked when persistence is rejected',async()=>{
  let clicks=0;const c=context(page,['claimCurrentDetail'],{
    findClaimButton:()=>({click(){clicks++;}}),hasAlreadyClaimed:()=>false,assertActive(){},
    contextRuntime:{sendMessage:async()=>({ok:false,error:'storage unavailable'})},buildOpenedTask:()=>({})
  });
  await assert.rejects(c.claimCurrentDetail({}, {},'r',Date.now()),/storage unavailable/);assert.equal(clicks,0);
});
await test('watchdog never refreshes a task after a claim has been authorized',()=>{
  const c=context(background,['shouldRestartXinhuoRunAfterNoClaim'],{runtimeState:{mode:'auto',stage:'selecting_task',marketplaceNoClaimSince:1,uncertainAction:{type:'XINHUO_CLAIM'}},XINHUO_MARKETPLACE_IDLE_REFRESH_MS:300000});
  assert.equal(c.shouldRestartXinhuoRunAfterNoClaim(999999),false);
});
function diagnosis(snapshot,changes={}) {
  const state={running:false,runId:'old',uncertainAction:{type:'XINHUO_SELECT_AND_CLAIM',runId:'old',tabId:99,taskKey:''},...changes};
  let reloads=0;const c=context(background,['checkXinhuoConnection'],{
    runtimeState:state,toContentSettings:s=>s,getSettings:async()=>({}),
    chrome:{tabs:{query:async()=>[{id:1,windowId:2,url:'https://xinhuo123.com/tasks',active:true}],get:async()=>{throw new Error('No tab');},reload:async()=>{reloads++;}}},
    isXinhuoMarketplaceUrl:url=>url==='https://xinhuo123.com/tasks',waitForTabComplete:async()=>true,
    ensureXinhuoContentReady:async()=>typeof snapshot==='function'?snapshot():snapshot,persistRuntimeState:async()=>{},log(){},delay:async()=>{}
  });return {c,state,reloads:()=>reloads};
}
await test('legacy scan lock is released only after a fresh official zero-order snapshot',async()=>{
  const h=diagnosis({ok:true,version:'0.1.41',accountReady:true,total:18,ready:3,eligible:3,cooling:3,ongoing:0,review:0,verifying:0,idleConfirmed:true});
  const r=await h.c.checkXinhuoConnection(2);assert.equal(r.ok,true);assert.equal(h.reloads(),1);assert.equal(h.state.uncertainAction,undefined);assert.equal(h.state.running,false);assert.ok(h.state.lastScanRecovery);
});
await test('active, pending, or unrecognized official counters retain a legacy lock',async()=>{
  for(const snapshot of [{ongoing:1},{ongoing:0,review:1},{ongoing:null}]) {
    const h=diagnosis({...snapshot,idleConfirmed:false});const r=await h.c.checkXinhuoConnection(2);assert.equal(r.ok,false);assert.ok(h.state.uncertainAction);
  }
});
await test('loading placeholder zeroes cannot release a legacy lock before active orders load',async()=>{
  let reads=0;
  const h=diagnosis(()=>++reads<3
    ? {accountReady:false,ongoing:0,review:0,verifying:0,idleConfirmed:false}
    : {accountReady:true,ongoing:1,review:0,verifying:0,idleConfirmed:false});
  const r=await h.c.checkXinhuoConnection(2);
  assert.equal(r.ok,false);assert.equal(reads,3);assert.ok(h.state.uncertainAction);assert.equal(h.state.lastScanRecovery,undefined);
});
await test('diagnostics wait for hydrated account data and return its task counts',async()=>{
  let reads=0;
  const h=diagnosis(()=>++reads<3
    ? {accountReady:false,total:29,ongoing:0,review:0,verifying:0,idleConfirmed:false}
    : {accountReady:true,total:19,ready:4,eligible:4,cooling:3,ongoing:0,review:0,verifying:0,idleConfirmed:true});
  const r=await h.c.checkXinhuoConnection(2);
  assert.equal(r.ok,true);assert.equal(reads,3);assert.equal(r.snapshot.total,19);assert.equal(h.state.uncertainAction,undefined);
});
await test('unloaded account data reports an error even with no legacy lock',async()=>{
  const h=diagnosis({accountReady:false,ongoing:0,review:0,verifying:0,idleConfirmed:false},{uncertainAction:undefined});
  const r=await h.c.checkXinhuoConnection(2);assert.equal(r.ok,false);assert.match(r.error,/账号数据尚未加载/);
});
await test('new-protocol unknown claims and identified legacy claims cannot use scan migration',async()=>{
  for(const intent of [{type:'XINHUO_CLAIM',protocol:1,taskKey:'/tasks/a'},{type:'XINHUO_SELECT_AND_CLAIM',taskKey:'/tasks/a'}]) {
    const h=diagnosis({idleConfirmed:true},{uncertainAction:intent});const r=await h.c.checkXinhuoConnection(2);assert.equal(r.ok,false);assert.equal(h.reloads(),0);assert.equal(h.state.uncertainAction,intent);
  }
});
await test('real marketplace card texts parse and diagnostics have zero click side effects',()=>{
  const texts=[
    '可立即接取\n3 天接单期\nvintcessun\n@vintcessun\n评论+点赞\n接单等级\nE\n预计到账 · E 星尘\n0.135 KX\n可立即接取\n19/20 席',
    '可立即接取\n3 天接单期\nViewMing82\n@ViewMing82\n评论\n接单等级\nE\n预计到账 · E 星尘\n0.090 KX\n可立即接取\n8/50 席',
    '等待释放 3 天接单期 yeyoucao @yeyoucao 评论+点赞 接单等级 E 预计到账 · E 星尘 0.135 KX 等待 70 秒 10/25 席',
    '任务状态 3 天接单期 OKX @zzwinwinwin 评论 接单等级 D 预计到账 -- KX 当前等级不可接取 16/20 席'
  ];
  const anchors=texts.map((innerText,i)=>({innerText,closest:()=>null,getAttribute:key=>key==='href'?`/tasks/${i}`:key==='aria-disabled'?(i===2?'true':'false'):'',click(){throw new Error('diagnostic clicked');}}));
  let summary='普通进行中 0 待复核 0 当前等级 E 星尘 验证中 0';
  const c=context(page,['inspectMarketplace','collectCandidates','findMarketplaceTaskAnchors','normalizeMarketplaceTaskHref','isCandidateBlocked','parseCooldownMs','parseBounty','meetsMinimumBounty','normalize'],{
    location:{pathname:'/tasks',href:'https://xinhuo123.com/tasks',origin:'https://xinhuo123.com'},
    document:{querySelector:()=>({innerText:summary}),querySelectorAll:()=>anchors}
  });
  const s=c.inspectMarketplace({xinhuoMinTaskBounty:0.1});assert.equal(s.total,4);assert.equal(s.ready,2);assert.equal(s.eligible,1);assert.equal(s.cooling,1);assert.equal(s.idleConfirmed,true);
  summary='普通进行中 0 待复核 0 当前等级 -- 验证中 0';assert.equal(c.inspectMarketplace({}).idleConfirmed,false);assert.equal(c.inspectMarketplace({}).accountReady,false);
  summary='普通进行中 0 待复核';assert.equal(c.inspectMarketplace({}).idleConfirmed,false);
});
await test('full content-to-worker claim flow persists before exactly one click',async()=>{
  const rt=runtime();let clicks=0,storedBeforeClick=false;
  const taskPath='/tasks/fixture';
  const state={running:true,mode:'auto',stage:'selecting_task',runId:'r',xinhuoTabId:1};
  const location={href:'https://xinhuo123.com/tasks',origin:'https://xinhuo123.com',pathname:'/tasks'};
  let body='普通进行中 0 待复核 0 验证中 0';
  const card={innerText:'可立即接取 @test 评论+点赞 0.135 KX',getAttribute:k=>k==='href'?taskPath:k==='aria-disabled'?'false':'',closest:()=>null,click(){location.pathname=taskPath;location.href=location.origin+taskPath;body='评论+点赞 0.135 KX 接取评论任务';}};
  const claim={innerText:'接取评论任务',disabled:false,click(){assert.ok(storedBeforeClick);clicks++;body='评论+点赞 0.135 KX 放弃订单';}};
  const document={body:{get innerText(){return body;}},querySelector:()=>({innerText:body}),querySelectorAll(selector){
    if(selector==='a[href]')return location.pathname==='/tasks'?[card]:[];
    if(selector.includes('x.com/'))return [{href:'https://x.com/test/status/123'}];
    if(selector==='button'||selector.startsWith('button,'))return location.pathname===taskPath && clicks===0?[claim]:[];
    return [];
  }};
  let worker;
  rt.sendMessage=async message=>message.type==='XINHUO_CLAIM_INTENT'
    ? worker.recordXinhuoClaimIntent(message,{url:'https://xinhuo123.com/tasks',documentId:'document-a',tab:{id:1}}):{ok:true};
  const content=vm.createContext({URL,console,chrome:{runtime:rt},location,document,setTimeout,clearTimeout});
  vm.runInContext(page,content);
  const send=(_id,message)=>new Promise(resolve=>{for(const listener of rt.listeners)listener(message,{},resolve);});
  worker=context(background,['sendToTab','recordXinhuoClaimIntent','ensureXinhuoContentReady','getXinhuoTaskIdentity','normalizeXinhuoTaskPath','normalizeTweetUrl','mergeXinhuoTask','isMissingReceiver'],{
    runtimeState:state,XINHUO_TASKS_URL:'https://xinhuo123.com/tasks',chrome:{runtime:{getManifest:()=>({version:JSON.parse(read('manifest.json')).version})},tabs:{get:async()=>({url:location.href}),sendMessage:send}},
    setStage:stage=>{state.stage=stage;},log(){},toContentSettings:s=>s,getSettings:async()=>({aiApiKey:'fixture-key'}),
    persistRuntimeState:async()=>{if(state.uncertainAction){assert.equal(clicks,0);assert.equal(state.currentTask.taskKey,taskPath);storedBeforeClick=true;}},
    injectContentScript:async()=>{throw new Error('unnecessary injection');},delay:async()=>{}
  });
  const result=await worker.sendToTab(1,{type:'XINHUO_SELECT_AND_CLAIM',runId:'r',settings:{}});
  assert.equal(result.ok,true);assert.equal(clicks,1);assert.equal(state.uncertainAction,undefined);assert.equal(state.currentTask.claimed,true);
});
await test('receiver error after an authorized claim cannot cause a second dispatch',async()=>{
  let h,sends=0;h=messaging(async()=>{sends++;h.state.uncertainAction={type:'XINHUO_CLAIM',protocol:1,runId:'r',tabId:1,taskKey:'/tasks/a'};throw new Error('Could not establish connection. Receiving end does not exist.');});
  const result=await h.c.sendToTab(1,{type:'XINHUO_SELECT_AND_CLAIM',runId:'r'});
  assert.equal(result.uncertain,true);assert.equal(sends,1);assert.equal(h.injections(),0);
});
await test('sidebar reports an immediate rejected start instead of swallowing it',async()=>{
  const debug=read('src/debug/debug.js');let status='';
  const c=context(debug,['startRun'],{commandGeneration:0,commandQueueRunning:false,saveSettings:async()=>true,startBtn:{},withClientWindowId:async p=>p,chrome:{runtime:{sendMessage:async()=>({ok:false,error:'旧动作结果未知'})}},showCommandStatus:s=>{status=s;},loadState:async()=>{},setTimeout:fn=>fn()});
  await c.startRun();await Promise.resolve();assert.equal(status,'旧动作结果未知');
});
function verification(mode='debug',options={}) {
  const state={running:true,mode,runId:'verify',currentTask:{taskKey:'/tasks/a'}};let reads=0,latches=0;
  const confirmed={ok:true,final:true,state:'confirmed',message:'薪火状态已更新：已到账奖励',evidence:{runId:'verify'}};
  const c=context(background,['waitForXinhuoFinalVerification','isActiveRun'],{
    runtimeState:state,XINHUO_VERIFICATION_POLL_MS:1,
    delay:async()=>{options.onDelay?.(state);},log(){},chrome:{tabs:{reload:async()=>{}}},waitForTabComplete:async()=>{},
    sendToTab:async()=>{reads++;return confirmed;},toContentSettings:s=>s,latchXinhuoCompletion:()=>{latches++;return true;}
  });return {c,state,confirmed,reads:()=>reads,latches:()=>latches};
}
await test('official paid evidence is accepted in both auto and debug flows',async()=>{
  for(const mode of ['auto','debug']) {
    const h=verification(mode);const r=await h.c.waitForXinhuoFinalVerification(1,'verify',{},h.confirmed);
    assert.equal(r.ok,true);assert.equal(h.latches(),1);
  }
});
await test('debug verification polls a pending order through to the official final result',async()=>{
  const h=verification();const r=await h.c.waitForXinhuoFinalVerification(1,'verify',{}, {ok:true,final:false});
  assert.equal(r.ok,true);assert.equal(h.reads(),1);
});
await test('a debug verification cannot adopt results after its run is replaced',async()=>{
  const h=verification('debug',{onDelay:state=>{state.runId='new-run';}});
  const r=await h.c.waitForXinhuoFinalVerification(1,'verify',{}, {ok:true,final:false});
  assert.equal(r.ok,false);assert.equal(h.reads(),0);assert.equal(h.latches(),0);
});
await test('automatic task scheduling still excludes debug execution',()=>{
  const h=verification();assert.equal(h.c.isActiveRun('verify'),false);
});
function completionFlow(limit=9999,settingsOverrides={}) {
  const state={running:true,mode:'debug',runId:'done',completed:0,failed:0,currentTask:{claimed:true,taskKey:'/tasks/a',detailPath:'/tasks/a',tweetUrl:'https://x.com/a/status/1'}};
  const settings={replyMode:'post',autoSubmitXinhuo:true,aiApiKey:'fixture',maxTasksPerRun:limit,actionDelayMs:0,...settingsOverrides};
  let scans=0;const destinations=[];
  const functions=['debugWaitXinhuoCompletionAndReturn','waitForXinhuoFinalVerification','finishXinhuoOfficialResult','resumeXinhuoAutoAfterDebug',
    'clearCompletedXinhuoTaskState','latchXinhuoCompletion','hasLatchedXinhuoCompletion','buildXinhuoCompletionEvidence','getXinhuoTaskIdentity',
    'normalizeXinhuoTaskPath','normalizeTweetUrl','isActiveRun','finishRun'];
  if(limit===1)functions.push('runNextXinhuoTask','isLimitReached');
  const c=context(background,functions,{
    runtimeState:state,XINHUO_TASKS_URL:'https://xinhuo123.com/tasks',getSettings:async()=>settings,getCurrentXinhuoTaskTab:async()=>({id:1}),
    chrome:{tabs:{update:async(_id,change)=>{if(change.url)destinations.push(change.url);return {id:1};},reload:async()=>{}}},
    waitForTabComplete:async()=>{},toContentSettings:s=>s,sendToTab:async()=>({ok:true,final:true,state:'confirmed',success:true,message:'已到账奖励'}),
    log(){},touchRunState(){},setStage:s=>{state.stage=s;},clearXinhuoXSubmission(){},clearXinhuoXOpenWatch(){},releaseXinhuoAttemptedTask(){},
    delay:async()=>{},persistRuntimeState:async()=>{},ensureXinhuoKeepalive:async()=>{},getScheduleState:()=>({inWindow:true}),
    stopWithFailure:async message=>{throw new Error(message);},
    runNextXinhuoTask:async()=>{assert.equal(state.mode,'auto');assert.equal(state.currentTask,null);scans++;return {ok:true};},
    ensureXinhuoMarketplaceTab:async()=>{throw new Error('one-task cap scanned for another order');}
  });return {c,state,destinations,scans:()=>scans};
}
await test('debug completion returns to marketplace and hands off exactly one next loop',async()=>{
  const h=completionFlow();const r=await h.c.debugWaitXinhuoCompletionAndReturn();
  assert.equal(r.ok,true);assert.equal(r.queueFinished,true);assert.equal(h.state.completed,1);assert.equal(h.state.mode,'auto');
  assert.deepEqual(h.destinations,['https://xinhuo123.com/tasks']);assert.equal(h.scans(),1);
});
await test('the real next-loop scheduler honors the one-task cap after debug completion',async()=>{
  const h=completionFlow(1);const r=await h.c.debugWaitXinhuoCompletionAndReturn();await Promise.resolve();
  assert.equal(r.ok,true);assert.equal(h.state.completed,1);assert.equal(h.state.running,false);assert.equal(h.state.stage,'finished');
});
await test('debug completion does not start automatic publishing when it is disabled',async()=>{
  const h=completionFlow(9999,{replyMode:'draft'});const r=await h.c.debugWaitXinhuoCompletionAndReturn();
  assert.equal(r.ok,true);assert.equal(r.queueFinished,true);assert.equal(h.state.running,false);assert.equal(h.scans(),0);
});
await test('sidebar stops the old step queue once background resumes automatic scanning',async()=>{
  const commands=[];const debug=read('src/debug/debug.js');
  const c=context(debug,['runStepQueue'],{
    commandGeneration:0,commandQueueRunning:false,startBtn:{},stepButtons:['verify','return'].map(command=>({dataset:{command},querySelector:()=>({textContent:command})})),
    saveSettings:async()=>true,setStepButtonsDisabled(){},setButtonRunning(){},showCommandStatus(){},loadState:async()=>{},
    sendCommandAndWaitForStage:async command=>{commands.push(command);return {ok:true,queueFinished:true};}
  });
  await c.runStepQueue(0);assert.deepEqual(commands,['verify']);assert.equal(c.commandQueueRunning,false);
});
await test('a handed-off command does not wait for an obsolete debug stage',async()=>{
  const debug=read('src/debug/debug.js');const c=context(debug,['sendCommandAndWaitForStage'],{
    commandGeneration:0,withClientWindowId:async p=>p,chrome:{runtime:{sendMessage:async()=>({ok:true,queueFinished:true})}},
    STEP_COMPLETION_STAGES:{verify:['old-stage']},waitForStateStage:async()=>{throw new Error('waited for obsolete stage');}
  });assert.equal((await c.sendCommandAndWaitForStage('verify')).queueFinished,true);
});
}
console.log(`Lifecycle checks: ${passed} passed, ${failed} failed${baseline?' (original version)':''}.`);
if(failed) process.exitCode=1;

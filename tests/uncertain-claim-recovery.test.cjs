const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'src/background.js'), 'utf8');

function declaration(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  if (!match) return '';
  const next = /^(?:async )?function \w+\(/gm;
  next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.length);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options = {}) {
  const task = { taskKey: '/tasks/order-a', detailPath: '/tasks/order-a',
    tweetUrl: 'https://x.com/person/status/123', claimed: false };
  const intent = { type: options.type || 'XINHUO_SELECT_AND_CLAIM', runId: 'claim-run',
    tabId: 7, taskKey: task.taskKey, ...(options.type === 'XINHUO_CLAIM' ? { protocol: 1 } : { task: { ...task } }) };
  const state = { running: false, mode: 'idle', stage: 'action_result_unknown', runId: 'restored-run',
    windowId: 3, xinhuoTabId: 7, currentTask: { ...task }, uncertainAction: intent, logs: [] };
  const actions = [], logs = [], saved = [];
  const hooks = new Map();
  let inspectionReads = 0, scans = 0, sequence = 0, h;
  let stored = JSON.parse(JSON.stringify(state));
  const tab = { id: 7, windowId: 3, url: 'https://xinhuo123.com/tasks/order-a', status: 'complete' };
  const terminal = { ok: true, inspectionState: options.outcome || 'unclaimed',
    task: { ...task, claimed: options.outcome === 'completed' } };
  const step = async name => {
    actions.push(name);
    const hook = hooks.get(name);
    if (hook) { hooks.delete(name); await hook(h); }
  };
  const c = vm.createContext({
    URL, Date, console, runtimeState: state, runtimeStateWriteTail: Promise.resolve(),
    XINHUO_TASKS_URL: 'https://xinhuo123.com/tasks', RUN_STATE_KEY: 'state', activeAIRequests: new Set(),
    directXinhuoXOpen: null, xinhuoMarketplaceTabPromise: null, manualDebugCommandTail: Promise.resolve(), stopXinhuoRunPromise: null,
    chrome: {
      storage: { local: { set: async value => {
        const snapshot = JSON.parse(JSON.stringify(value.state));
        await step(snapshot.uncertainAction ? 'save-protected' : 'save-recovered');
        if (options.saveFailure && !snapshot.uncertainAction) throw new Error('storage unavailable');
        stored = snapshot; saved.push(snapshot);
      } } },
      tabs: {
        get: async () => { await step('get-tab'); return { ...tab }; },
        reload: async () => { await step('reload'); },
        update: async (_id, props) => { await step('navigate'); tab.url = props.url || tab.url; return { ...tab }; },
        sendMessage: async (_id, message) => {
          if (message.type === 'CANCEL_XINHUO_RUN') {
            assert.equal(message.runId, intent.runId);
            await step('cancel-old'); return { ok: !options.cancelFailure };
          }
          assert.equal(message.type, 'XINHUO_INSPECT_CURRENT_TASK');
          assert.equal(message.runId, undefined, 'stopped inspection must not activate the old run');
          assert.equal(message.task.detailPath, task.detailPath);
          inspectionReads++;
          await step('inspect');
          return options.responses?.shift() || terminal;
        }
      }
    },
    waitForTabComplete: async () => { await step('ready'); return true; },
    delay: async () => { await step('loading-delay'); },
    createRunId: () => `new-run-${++sequence}`,
    createInitialState: () => ({ running: false, mode: 'idle', logs: [], completed: 0, failed: 0 }),
    getSettings: async () => { await step('settings'); return { replyMode: 'post', autoSubmitXinhuo: true, aiApiKey: 'test' }; },
    getScheduleState: () => ({ inWindow: true }), getRecoverableInterruptedTask: () => null,
    ensureXinhuoKeepalive: async () => {}, clearXinhuoKeepalive: async () => {},
    clearXinhuoXOpenWatch() {}, clearXinhuoXSubmission() {},
    sendToTab: async (_id, message) => { await step('stop-cancel'); return { ok: true }; },
    setStage: stage => { c.runtimeState.stage = stage; }, log: (level, text) => { logs.push({ level, text }); },
    runNextXinhuoTask: async () => { scans++; await step('scan'); return { ok: true, state: c.runtimeState }; }
  });
  for (const name of ['startXinhuoRun', 'stopXinhuoRun', 'reconcileUncertainXinhuoClaim',
    'normalizeXinhuoTaskPath', 'normalizeTweetUrl', 'getXinhuoTaskIdentity', 'createInitialState', 'persistRuntimeState']) {
    const code = declaration(name); if (code) vm.runInContext(code, c);
  }
  h = { c, state, task, intent, tab, terminal, actions, logs, saved, hooks,
    reads: () => inspectionReads, scans: () => scans, stored: () => stored,
    start: () => c.startXinhuoRun(3), stop: () => c.stopXinhuoRun() };
  return h;
}

for (const type of ['XINHUO_SELECT_AND_CLAIM', 'DEBUG_XINHUO_CLAIM_CURRENT_TASK', 'XINHUO_CLAIM']) {
  for (const outcome of ['unclaimed', 'completed', 'failed']) {
    test(`${type}: matching explicit ${outcome} is saved before a single new scan`, async () => {
      const h = fixture({ type, outcome });
      const result = await h.start();
      assert.equal(result.ok, true);
      assert.equal(h.reads(), 1);
      assert.equal(h.scans(), 1);
      assert.equal(h.state.uncertainAction, undefined);
      assert.ok(h.actions.indexOf('cancel-old') < h.actions.indexOf('inspect'));
      assert.ok(h.actions.indexOf('save-recovered') < h.actions.indexOf('scan'));
      assert.equal(h.saved[0].uncertainAction, undefined);
    });
  }
}

for (const outcome of ['claimed', 'unknown']) {
  test(`${outcome} evidence retains the identified order without scanning`, async () => {
    const h = fixture({ outcome });
    assert.equal((await h.start()).ok, false);
    assert.equal(h.reads(), 1);
    assert.equal(h.state.uncertainAction, h.intent);
    assert.equal(h.scans(), 0);
  });
}
test('a bare claimed:false receipt cannot release the unknown order', async () => {
  const h = fixture();
  delete h.terminal.inspectionState; h.terminal.claimed = false;
  assert.equal((await h.start()).ok, false);
  assert.equal(h.reads(), 1);
  assert.equal(h.state.uncertainAction, h.intent);
  assert.equal(h.scans(), 0);
});
test('only a loading unknown may be retried and a later matching outcome can recover', async () => {
  const h = fixture({ responses: [{ ok: false, inspectionState: 'unknown', message: '订单面板尚未加载' }] });
  assert.equal((await h.start()).ok, true);
  assert.equal(h.reads(), 2);
  assert.ok(h.actions.includes('loading-delay'));
});
for (const field of ['detailPath', 'tweetUrl']) {
  test(`a mismatching ${field} receipt retains protection`, async () => {
    const h = fixture(); h.terminal.task[field] = field === 'detailPath' ? '/tasks/order-b' : 'https://x.com/person/status/456';
    assert.equal((await h.start()).ok, false);
    assert.equal(h.reads(), 1);
    assert.equal(h.state.uncertainAction, h.intent);
    assert.equal(h.scans(), 0);
  });
}
for (const type of ['RUN_X_REPLY', 'COMPLETE_X_TASK_WIDGET', 'XINHUO_SUBMIT_VERIFICATION']) {
  test(`${type} uncertainty cannot use claim recovery`, async () => {
    const h = fixture({ type });
    assert.equal((await h.start()).ok, false);
    assert.equal(h.actions.length, 0);
    assert.equal(h.state.uncertainAction, h.intent);
  });
}
test('a protocol 1 intent without a target identity is retained', async () => {
  const h = fixture({ type: 'XINHUO_CLAIM' }); delete h.state.currentTask.tweetUrl;
  assert.equal((await h.start()).ok, false);
  assert.equal(h.actions.length, 0);
  assert.equal(h.state.uncertainAction, h.intent);
});
test('a different initiating window cannot inspect or release this order', async () => {
  const h = fixture();
  assert.equal((await h.c.startXinhuoRun(4)).ok, false);
  assert.equal(h.actions.length, 0);
  assert.equal(h.state.uncertainAction, h.intent);
});
for (const at of ['cancel-old', 'reload', 'ready', 'inspect', 'loading-delay']) {
  test(`STOP during ${at} prevents later recovery actions and scanning`, async () => {
    const h = fixture(at === 'loading-delay' ? { responses: [{ ok: false, inspectionState: 'unknown', message: '订单面板尚未加载' }] } : {});
    h.hooks.set(at, current => current.stop());
    assert.equal((await h.start()).ok, false);
    assert.ok(h.actions.includes(at));
    assert.equal(h.c.runtimeState.uncertainAction, undefined);
    assert.equal(h.scans(), 0);
    assert.equal(h.c.runtimeState.running, false);
    assert.equal(h.stored().uncertainAction, undefined);
    assert.equal(h.stored().currentTask, null);
    assert.equal(h.stored().manuallyStopped, true);
  });
}
for (const replacement of ['run', 'task', 'window', 'intent']) {
  test(`a late receipt after ${replacement} replacement cannot clear new state`, async () => {
    const h = fixture();
    h.hooks.set('inspect', current => {
      if (replacement === 'run') current.state.runId = 'different-run';
      if (replacement === 'task') current.state.currentTask = { ...current.task, taskKey: '/tasks/order-b' };
      if (replacement === 'window') current.state.windowId = 9;
      if (replacement === 'intent') current.state.uncertainAction = { ...current.intent, taskKey: '/tasks/order-b' };
    });
    assert.equal((await h.start()).ok, false);
    assert.equal(h.reads(), 1);
    assert.ok(h.state.uncertainAction);
    assert.equal(h.scans(), 0);
    assert.ok(!h.actions.includes('save-recovered'));
  });
}
test('a tab navigation during the read prevents adopting the old receipt', async () => {
  const h = fixture(); h.hooks.set('inspect', current => { current.tab.pendingUrl = 'https://xinhuo123.com/tasks/order-b'; });
  assert.equal((await h.start()).ok, false);
  assert.equal(h.reads(), 1);
  assert.equal(h.state.uncertainAction, h.intent);
  assert.equal(h.scans(), 0);
});
test('concurrent STARTs cannot run two recoveries or dispatch two new scans', async () => {
  const h = fixture(), entered = deferred(), release = deferred();
  h.hooks.set('inspect', async () => { entered.resolve(); await release.promise; });
  const first = h.start();
  await Promise.race([entered.promise, first]);
  assert.equal(h.reads(), 1);
  const second = await h.start();
  assert.equal(second.ok, false);
  release.resolve();
  assert.equal((await first).ok, true);
  assert.equal(h.reads(), 1);
  assert.equal(h.scans(), 1);
});
test('a failed durable clear retains the unknown action and never starts scanning', async () => {
  const h = fixture({ saveFailure: true });
  assert.equal((await h.start()).ok, false);
  assert.ok(h.actions.includes('save-recovered'));
  assert.equal(h.state.uncertainAction, h.intent);
  assert.equal(h.stored().uncertainAction.taskKey, h.task.taskKey);
  assert.equal(h.scans(), 0);
});
test('STOP during durable clear persists the empty stopped snapshot after a late write', async () => {
  const h = fixture(), entered = deferred(), release = deferred();
  h.hooks.set('save-recovered', async () => { entered.resolve(); await release.promise; });
  const start = h.start();
  await Promise.race([entered.promise, start]);
  assert.ok(h.actions.includes('save-recovered'));
  assert.equal(h.state.uncertainAction, h.intent, 'memory guard stays until the durable write succeeds');
  const stop = h.stop();
  release.resolve();
  await stop;
  assert.equal((await start).ok, false);
  assert.equal(h.scans(), 0);
  assert.equal(h.stored().running, false);
  assert.equal(h.stored().uncertainAction, undefined);
  assert.equal(h.stored().currentTask, null);
  assert.equal(h.stored().manuallyStopped, true);
});

test('a confirmed closed original tab can recover through a current Xinhuo tab in the saved window', async () => {
  const h = fixture();
  h.tab.id = 9; h.tab.url = 'https://xinhuo123.com/tasks';
  h.c.chrome.tabs.get = async id => {
    if (id === 7) throw new Error('No tab with id: 7.');
    return { ...h.tab };
  };
  h.c.chrome.tabs.query = async query => {
    assert.equal(query.windowId, 3);
    return [{ ...h.tab }];
  };
  assert.equal((await h.start()).ok, true);
  assert.equal(h.reads(), 1);
  assert.equal(h.scans(), 1);
  assert.ok(h.actions.includes('navigate'));
});
test('a closed original tab cannot fall back to a Xinhuo tab in a different window', async () => {
  const h = fixture();
  h.c.chrome.tabs.get = async () => { throw new Error('No tab with id: 7.'); };
  h.c.chrome.tabs.query = async () => [{ ...h.tab, id: 9, windowId: 8 }];
  assert.equal((await h.start()).ok, false);
  assert.equal(h.reads(), 0);
  assert.equal(h.state.uncertainAction, h.intent);
  assert.equal(h.scans(), 0);
});
test('an existing original tab on a different order cannot use the closed-tab fallback', async () => {
  const h = fixture(); h.tab.url = 'https://xinhuo123.com/tasks/order-b';
  let queries = 0;
  h.c.chrome.tabs.query = async () => { queries++; return [{ ...h.tab, id: 9, url: 'https://xinhuo123.com/tasks' }]; };
  assert.equal((await h.start()).ok, false);
  assert.ok(h.actions.includes('get-tab'));
  assert.equal(queries, 0);
  assert.equal(h.reads(), 0);
  assert.equal(h.state.uncertainAction, h.intent);
});

test('explicit inspectionLoading retries hydrated page text without depending on its wording', async () => {
  const h = fixture({ responses: [{ ok: false, inspectionState: 'unknown', inspectionLoading: true,
    message: '订单面板仍在加载，保留原订单' }] });
  assert.equal((await h.start()).ok, true);
  assert.equal(h.reads(), 2);
  assert.ok(h.actions.includes('loading-delay'));
});
test('ambiguous multiple panels without inspectionLoading remain unknown without retry', async () => {
  const h = fixture({ responses: [{ ok: false, inspectionState: 'unknown',
    message: '订单面板尚未加载或存在多个面板，不能确认领取状态' }] });
  assert.equal((await h.start()).ok, false);
  assert.equal(h.reads(), 1);
  assert.equal(h.state.uncertainAction, h.intent);
  assert.equal(h.scans(), 0);
  assert.ok(!h.actions.includes('loading-delay'));
});

test('navigation during cancellation cannot reload an unrelated new detail', async () => {
  const h = fixture();
  h.hooks.set('cancel-old', current => { current.tab.url = 'https://xinhuo123.com/tasks/order-b'; });
  assert.equal((await h.start()).ok, false);
  assert.ok(!h.actions.includes('reload'));
  assert.ok(!h.actions.includes('navigate'));
  assert.equal(h.state.uncertainAction, h.intent);
});
test('an in-place change to the current order cannot be cleared by a late old receipt', async () => {
  const h = fixture();
  h.hooks.set('inspect', current => { current.state.currentTask.tweetUrl = 'https://x.com/person/status/456'; });
  assert.equal((await h.start()).ok, false);
  assert.equal(h.state.uncertainAction, h.intent);
  assert.equal(h.scans(), 0);
});
test('a late durable candidate cannot leave storage without a newer protected intent', async () => {
  const h = fixture();
  h.hooks.set('save-recovered', current => {
    current.state.uncertainAction = { ...current.intent, taskKey: '/tasks/order-b' };
  });
  assert.equal((await h.start()).ok, false);
  assert.equal(h.state.uncertainAction.taskKey, '/tasks/order-b');
  assert.equal(h.stored().uncertainAction.taskKey, '/tasks/order-b');
  assert.equal(h.scans(), 0);
});

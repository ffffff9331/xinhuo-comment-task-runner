const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/debug/debug.js'), 'utf8');
function declaration(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, name);
  const next = /^(?:async )?function \w+\(/gm;
  next.lastIndex = start.index + start[0].length;
  return source.slice(start.index, next.exec(source)?.index ?? source.length);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const messages = [], statuses = [], renders = [];
  const steps = ['STEP_A', 'STEP_B'].map(command => ({
    dataset: { command }, disabled: false, running: false,
    querySelector: () => ({ textContent: command }),
    classList: { toggle() {} }, toggleAttribute() {}
  }));
  let send = async message => message.type === 'GET_STATE'
    ? { ok: true, state: { stage: 'idle' }, settings: {} }
    : { ok: true, state: { stage: 'done' } };
  let save = async () => true;
  let withWindow = async value => value;
  let now = 0;
  class ClockDate extends Date { static now() { return now; } }
  const c = vm.createContext({
    console, Date: ClockDate, setTimeout: (callback, ms) => { now += Math.max(1, ms || 1); queueMicrotask(callback); return 1; }, clearTimeout() {},
    commandGeneration: 0, stateReadSequence: 0, commandQueueRunning: false, settingsDirty: true,
    startBtn: { disabled: false }, stopBtn: { disabled: false }, stepButtons: steps,
    STEP_COMPLETION_STAGES: { STEP_A: ['done'], STEP_B: ['done'] },
    chrome: { runtime: { sendMessage: async message => { messages.push(message); return send(message); } } },
    saveSettings: () => save(), withClientWindowId: value => withWindow(value),
    showCommandStatus: (text, kind) => statuses.push({ text, kind }),
    renderSettings() {}, renderState: state => renders.push(state), readSettings: () => ({}),
    getActiveView: () => 'tasks', loadReplyRecords: async () => {},
  });
  for (const name of ['startRun', 'stopRun', 'runStepQueue', 'sendCommandAndWaitForStage',
    'waitForStateStage', 'getStepWaitTimeoutMs', 'setStepButtonsDisabled', 'setButtonRunning', 'loadState']) {
    vm.runInContext(declaration(name), c);
  }
  return { c, messages, statuses, renders, steps,
    onSend: fn => { send = fn; }, onSave: fn => { save = fn; }, onWindow: fn => { withWindow = fn; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('an explicit normal step queue runs each selected step exactly once', async () => {
  const h = fixture();
  await h.c.runStepQueue(0);
  assert.deepEqual(h.messages.filter(m => m.type.startsWith('STEP_')).map(m => m.type), ['STEP_A', 'STEP_B']);
  assert.equal(h.c.commandQueueRunning, false);
  assert.equal(h.statuses.at(-1).text, '后续流程已连续执行完成');
});

test('STOP invalidates a waiting step and a late success cannot dispatch the next step', async () => {
  const h = fixture(), oldStep = deferred();
  h.onSend(message => message.type === 'STEP_A' ? oldStep.promise
    : Promise.resolve({ ok: true, state: { stage: 'stopped', running: false }, settings: {} }));
  const pending = h.c.runStepQueue(0);
  await turn();
  await h.c.stopRun();
  const stoppedStatusCount = h.statuses.length;
  assert.equal(h.c.commandQueueRunning, false);
  oldStep.resolve({ ok: true, state: { stage: 'done' } });
  await pending;
  assert.equal(h.messages.filter(m => m.type === 'STEP_B').length, 0);
  assert.equal(h.statuses.length, stoppedStatusCount, 'late step must not replace the STOP status');
  assert.equal(h.messages.some(m => m.type === 'CLEAR_REPLY_RECORDS'), false);
});

test('a new explicit step queue survives the old queue finally callback after STOP', async () => {
  const h = fixture(), oldStep = deferred(), newStep = deferred();
  let stepCalls = 0;
  h.onSend(message => message.type === 'STEP_A'
    ? (++stepCalls === 1 ? oldStep.promise : newStep.promise)
    : Promise.resolve({ ok: true, state: { stage: 'done' }, settings: {} }));
  const oldQueue = h.c.runStepQueue(0);
  await turn(); await h.c.stopRun();
  const newQueue = h.c.runStepQueue(0);
  await turn();
  assert.equal(stepCalls, 2, 'explicit new queue must not wait for the cancelled queue');
  oldStep.resolve({ ok: true, state: { stage: 'done' } });
  await oldQueue;
  assert.equal(h.c.commandQueueRunning, true, 'old finally cannot unlock the new queue');
  assert.equal(h.steps[0].disabled, true);
  newStep.resolve({ ok: true, state: { stage: 'done' } });
  await newQueue;
  assert.equal(h.messages.filter(m => m.type === 'STEP_B').length, 1);
});

for (const point of ['settings', 'window']) test(`STOP while START awaits ${point} prevents a delayed START_RUN`, async () => {
  const h = fixture(), paused = deferred();
  if (point === 'settings') h.onSave(() => paused.promise);
  else h.onWindow(() => paused.promise);
  const start = h.c.startRun();
  await turn(); await h.c.stopRun();
  paused.resolve(point === 'settings' ? true : { type: 'START_RUN', clientWindowId: 1 });
  await start;
  assert.equal(h.messages.some(m => m.type === 'START_RUN'), false);
});

test('STOP suppresses a late START rejection instead of restoring an old error banner', async () => {
  const h = fixture(), reply = deferred();
  h.onSend(message => message.type === 'START_RUN' ? reply.promise
    : Promise.resolve({ ok: true, state: { stage: 'stopped' }, settings: {} }));
  await h.c.startRun();
  await h.c.stopRun();
  reply.resolve({ ok: false, error: 'OLD ERROR' });
  await turn();
  assert.equal(h.statuses.some(s => s.text === 'OLD ERROR'), false);
});

test('STOP cancels stage polling and a later new-run stage cannot complete the old step', async () => {
  const h = fixture(), stateReply = deferred();
  let reads = 0;
  h.onSend(message => {
    if (message.type === 'STEP_A') return Promise.resolve({ ok: true, state: { stage: 'busy' } });
    if (message.type === 'GET_STATE' && ++reads === 1) return stateReply.promise;
    return Promise.resolve({ ok: true, state: { stage: 'stopped' }, settings: {} });
  });
  const queue = h.c.runStepQueue(0);
  await turn(); await h.c.stopRun();
  stateReply.resolve({ ok: true, state: { stage: 'done', runId: 'new-run' } });
  await queue;
  assert.equal(h.messages.some(m => m.type === 'STEP_B'), false);
});

test('a pre-STOP GET_STATE response cannot redraw cleared old logs', async () => {
  const h = fixture(), oldState = deferred();
  let reads = 0;
  h.onSend(message => message.type === 'GET_STATE' && ++reads === 1 ? oldState.promise
    : Promise.resolve({ ok: true, state: { stage: 'stopped', logs: [] }, settings: {} }));
  const oldRead = h.c.loadState();
  await h.c.stopRun();
  oldState.resolve({ ok: true, state: { stage: 'claiming', logs: ['old log'] }, settings: {} });
  await oldRead;
  assert.equal(h.renders.some(state => state.stage === 'claiming'), false);
});

test('STOP save failure is visible and never leaves the old step queue running', async () => {
  const h = fixture();
  h.c.commandQueueRunning = true;
  h.onSend(async message => message.type === 'STOP_RUN' ? { ok: false, error: 'storage unavailable' }
    : { ok: true, state: { stage: 'stopped' }, settings: {} });
  await h.c.stopRun();
  assert.equal(h.c.commandQueueRunning, false);
  assert.ok(h.statuses.some(s => s.kind === 'error' && s.text.includes('storage unavailable')));
});

test('full detection cannot invalidate and strand an already active manual queue', async () => {
  const h = fixture(), firstStep = deferred();
  h.onSend(message => message.type === 'STEP_A' ? firstStep.promise
    : Promise.resolve({ ok: true, state: { stage: 'done' }, settings: {} }));
  const queue = h.c.runStepQueue(0);
  await turn();
  await h.c.startRun();
  firstStep.resolve({ ok: true, state: { stage: 'done' } });
  await queue;
  assert.equal(h.messages.some(m => m.type === 'START_RUN'), false);
  assert.equal(h.c.commandQueueRunning, false);
});

test('a read begun during STOP cannot overwrite its final cleared snapshot', async () => {
  const h = fixture(), stopReply = deferred(), oldReadReply = deferred();
  let reads = 0;
  h.onSend(message => message.type === 'STOP_RUN' ? stopReply.promise
    : ++reads === 1 ? oldReadReply.promise
    : Promise.resolve({ ok: true, state: { stage: 'stopped', logs: [] }, settings: {} }));
  const stop = h.c.stopRun();
  const oldRead = h.c.loadState();
  stopReply.resolve({ ok: true });
  await stop;
  oldReadReply.resolve({ ok: true, state: { stage: 'claiming', logs: ['old'] }, settings: {} });
  await oldRead;
  assert.equal(h.renders.some(state => state.stage === 'claiming'), false);
});

test('a manual queue taking over a pending START releases the full detection button', async () => {
  const h = fixture(), oldWindow = deferred();
  let windows = 0;
  h.onWindow(value => ++windows === 1 ? oldWindow.promise : Promise.resolve(value));
  const start = h.c.startRun();
  await turn();
  assert.equal(h.c.startBtn.disabled, true);
  await h.c.runStepQueue(0);
  oldWindow.resolve({ type: 'START_RUN', clientWindowId: 1 });
  await start;
  assert.equal(h.messages.some(m => m.type === 'START_RUN'), false);
  assert.equal(h.c.commandQueueRunning, false);
  assert.equal(h.c.startBtn.disabled, false, 'the current queue must release the inherited start-button lock');
});

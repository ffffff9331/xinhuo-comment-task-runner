"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// Keep the existing background fixture and its assertions unchanged. These
// cases exercise the production reconciliation function with raw stored and
// returned identities, before any permissive legacy normalizer can alter them.
const filename = path.join(__dirname, "uncertain-claim-recovery.test.cjs");
const source = fs.readFileSync(filename, "utf8");
const boundary = source.indexOf("for (const type of ['XINHUO_SELECT_AND_CLAIM'");
assert.ok(boundary > 0);
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(__dirname);
loaded._compile(source.slice(0, boundary) + "\nmodule.exports = { fixture };", filename);
const { fixture } = loaded.exports;
const TWEET = "https://x.com/person/status/123";
const ORDER = "/tasks/order-a";
const owners = ["intent task", "current task", "receipt"];
const owner = (h, name) => name === "intent task" ? h.intent.task : name === "current task" ? h.state.currentTask : h.terminal.task;

function retained(h, result, side) {
  assert.equal(result.ok, false, "invalid raw identity must never authorize a new run");
  assert.equal(h.scans(), 0);
  assert.equal(h.state.uncertainAction, h.intent);
  assert.equal(h.saved.some(state => !state.uncertainAction), false, "no invalid identity may be durably cleared");
  if (side !== "receipt") assert.equal(h.reads(), 0, "reject malformed stored identity before contacting the page");
}

for (const side of owners) {
  for (const [name, value] of [
    ["partial numeric status", TWEET + "abc"],
    ["extra status path", TWEET + "/unrelated"],
    ["encoded status suffix", TWEET + "%2Fextra"],
    ["embedded URL in foreign query", "https://foreign.example/?next=" + TWEET],
    ["embedded URL in foreign path", "https://foreign.example/" + TWEET],
    ["X hostname suffix", "https://x.com.foreign.example/person/status/123"],
    ["credentials", "https://someone@x.com/person/status/123"],
    ["nondefault port", "https://x.com:444/person/status/123"],
    ["insecure protocol", "http://x.com/person/status/123"],
    ["extra media suffix", TWEET + "/photo/1/extra"],
  ]) {
    test(`${side}: reject ${name} before clearing the old order`, async () => {
      const h = fixture();
      owner(h, side).tweetUrl = value;
      retained(h, await h.start(), side);
    });
  }
}

const invalidPaths = [
  ["foreign origin", "https://foreign.example" + ORDER],
  ["hostname suffix", "https://xinhuo123.com.foreign.example" + ORDER],
  ["URL credentials", "https://someone@xinhuo123.com" + ORDER],
  ["nondefault port", "https://xinhuo123.com:444" + ORDER],
  ["insecure protocol", "http://xinhuo123.com" + ORDER],
  ["extra detail segment", ORDER + "/extra"],
];
for (const side of owners) {
  for (const field of ["detailPath", "taskKey"]) {
    for (const [name, value] of invalidPaths) {
      test(`${side} ${field}: reject ${name} without extracting its path`, async () => {
        const h = fixture();
        owner(h, side)[field] = value;
        retained(h, await h.start(), side);
      });
    }
  }
}
for (const [name, value] of invalidPaths) {
  test(`recorded intent taskKey rejects ${name}`, async () => {
    const h = fixture();
    h.intent.taskKey = value;
    retained(h, await h.start(), "intent task");
  });
}

for (const value of [TWEET, TWEET + "?s=20#reply", TWEET + "/photo/1", TWEET.replace("x.com", "twitter.com")]) {
  test(`complete legitimate tweet identity still permits recovery: ${value}`, async () => {
    const h = fixture();
    for (const side of owners) owner(h, side).tweetUrl = value;
    assert.equal((await h.start()).ok, true);
    assert.equal(h.scans(), 1);
  });
}

for (const value of [ORDER, "https://xinhuo123.com" + ORDER]) {
  test(`same-site complete order identity remains valid: ${value}`, async () => {
    const h = fixture();
    h.intent.taskKey = value;
    for (const side of owners) Object.assign(owner(h, side), { taskKey: value, detailPath: value });
    assert.equal((await h.start()).ok, true);
    assert.equal(h.scans(), 1);
  });
}

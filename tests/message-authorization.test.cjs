"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
const declaration = source.match(/^function isAuthorizedMessage\(message, sender\) \{[\s\S]*?^\}/m);
assert.ok(declaration, "load the production message authorization function");

// These are Chrome MessageSender fixtures, not values the webpage can supply.
// Exercise only the authorization policy; do not boot the worker or run tasks.
const extensionId = "message-authorization-fixture";
const extensionUrl = `chrome-extension://${extensionId}/src/debug/debug.html`;
const context = vm.createContext({
  chrome: { runtime: { id: extensionId, getURL: value => `chrome-extension://${extensionId}/${value}` } }
});
vm.runInContext(declaration[0], context);
const authorize = (type, sender, extra = {}) => context.isAuthorizedMessage({ type, ...extra }, sender);
const platformUrl = "https://xinhuo123.com/tasks/a";
const platformMessages = ["CONTENT_LOG","XINHUO_CLAIM_INTENT"];
const xMessages = ["GENERATE_AI_REPLY","QUERY_TWEET_REPLY_HISTORY"];
const privilegedMessages = ["GET_STATE", "SAVE_SETTINGS", "START_RUN", "STOP_RUN", "GET_REPLY_RECORDS", "CLEAR_REPLY_RECORDS", "OPEN_DEBUG_PAGE"];
const websiteSender = (url = platformUrl, overrides = {}) => ({
  id: extensionId, url, tab: { id: 7, windowId: 1 }, frameId: 0, ...overrides
});

test("trusted sidebar commands remain authorized without a tab or frameId", () => {
  const sender = { id: extensionId, url: extensionUrl };
  for (const type of privilegedMessages) assert.equal(authorize(type, sender), true, type);
});

test("the extension options page remains authorized in a top-level tab", () => {
  const sender = { id: extensionId, url: extensionUrl, tab: { id: 9 }, frameId: 0 };
  assert.equal(authorize("GET_STATE", sender), true);
  assert.equal(authorize("SAVE_SETTINGS", sender), true);
});

test("Xinhuo top-level content retains its supported message contract", () => {
  for (const type of platformMessages) assert.equal(authorize(type, websiteSender()), true, type);
});

test("X and Twitter top-level content retain their supported messages", () => {
  for (const url of ["https://x.com/example/status/123", "https://twitter.com/example/status/123"]) {
    for (const type of xMessages) assert.equal(authorize(type, websiteSender(url)), true, `${url} ${type}`);
  }
});

test("website iframes cannot use top-level content message privileges", () => {
  for (const [url, messages] of [[platformUrl, platformMessages], ["https://x.com/example/status/123", xMessages], ["https://twitter.com/example/status/123", xMessages]]) {
    for (const frameId of [1, 8]) {
      for (const type of messages) assert.equal(authorize(type, websiteSender(url, { frameId })), false, `${url} ${type} frame=${frameId}`);
    }
  }
});

test("another extension or a missing sender ID cannot inherit trusted access", () => {
  for (const id of ["another-extension", undefined, null]) {
    assert.equal(authorize("SAVE_SETTINGS", { id, url: extensionUrl }), false);
    assert.equal(authorize(platformMessages[0], websiteSender(platformUrl, { id })), false);
  }
  assert.equal(authorize("GET_STATE", undefined), false);
  assert.equal(authorize("GET_STATE", null), false);
});

test("lookalike origins and insecure URLs are rejected", () => {
  const deniedPlatformUrls = ["http://xinhuo123.com/tasks/a","https://xinhuo123.com.attacker.example/tasks/a","https://attacker.xinhuo123.com/tasks/a","https://xinhuo123.com@attacker.example/tasks/a","https://attacker.example/?site=https://xinhuo123.com/tasks/a"];
  for (const url of deniedPlatformUrls) assert.equal(authorize(platformMessages[0], websiteSender(url)), false, url);
  for (const url of ["http://x.com/example/status/123", "https://x.com.attacker.example/post", "https://attacker.x.com/post", "https://twitter.com@attacker.example/post", "https://twitter.com.attacker.example/post"]) {
    assert.equal(authorize("GENERATE_AI_REPLY", websiteSender(url)), false, url);
  }
  assert.equal(authorize("GET_STATE", { id: extensionId, url: `chrome-extension://${extensionId}-other/src/debug/debug.html` }), false);
});

test("websites cannot read full settings, change settings, start, or stop runs", () => {
  for (const url of [platformUrl, "https://x.com/example/status/123", "https://twitter.com/example/status/123"]) {
    for (const type of privilegedMessages) assert.equal(authorize(type, websiteSender(url)), false, `${url} ${type}`);
  }
});

test("platform content cannot inherit X-only message privileges", () => {
  for (const type of ["GENERATE_AI_REPLY","QUERY_TWEET_REPLY_HISTORY","GET_CONTENT_SETTINGS"]) assert.equal(authorize(type, websiteSender()), false, type);
});

test("X content cannot inherit platform-only message privileges", () => {
  for (const type of ["CONTENT_LOG","XINHUO_CLAIM_INTENT"]) assert.equal(authorize(type, websiteSender("https://x.com/example/status/123")), false, type);
});

test("content messages require an actual integer tab identity", () => {
  for (const tab of [undefined, null, {}, { id: "7" }, { id: 1.5 }, { id: NaN }, { id: Infinity }]) {
    assert.equal(authorize(platformMessages[0], websiteSender(platformUrl, { tab })), false);
    assert.equal(authorize("GENERATE_AI_REPLY", websiteSender("https://x.com/example/status/123", { tab })), false);
  }
});

test("missing message types and missing source URLs do not grant web privileges", () => {
  for (const message of [undefined, null, {}, { type: "NOT_A_SUPPORTED_MESSAGE" }]) {
    assert.equal(context.isAuthorizedMessage(message, websiteSender()), false);
    assert.equal(context.isAuthorizedMessage(message, websiteSender("https://x.com/example/status/123")), false);
  }
  for (const url of [undefined, null, ""]) assert.equal(authorize(platformMessages[0], websiteSender(url, { url })), false);
});

test("sender-like fields in the payload cannot override the browser sender", () => {
  const forgedPayload = { sender: { id: extensionId, url: extensionUrl }, frameId: 0, url: extensionUrl };
  assert.equal(authorize("SAVE_SETTINGS", websiteSender(), forgedPayload), false);
  assert.equal(authorize("STOP_RUN", websiteSender(), forgedPayload), false);
  assert.equal(authorize(platformMessages[0], websiteSender(platformUrl, { frameId: 3 }), forgedPayload), false);
});

test("legitimate query strings and fragments keep their original message permissions", () => {
  assert.equal(authorize(platformMessages[0], websiteSender(`${platformUrl}?view=tasks#current`)), true);
  assert.equal(authorize("GENERATE_AI_REPLY", websiteSender("https://x.com/example/status/123?s=20#reply")), true);
});

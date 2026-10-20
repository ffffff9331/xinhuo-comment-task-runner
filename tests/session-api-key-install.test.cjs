"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("a failed credential migration still configures the toolbar side panel and remains an explicit failure", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
  let install; const panels = [], event = { addListener() {} };
  const chrome = {
    runtime: { getURL: value => `chrome-extension://fixture/${value}`, onInstalled: { addListener: fn => { install = fn; } }, onMessage: event },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} },
      session: { setAccessLevel: async () => {}, get: async () => { throw Error("fixture unavailable"); }, set: async () => {} } },
    sidePanel: { setPanelBehavior: async options => { panels.push(options); } },
    alarms: { onAlarm: event }, tabs: { onRemoved: event, onCreated: event, onUpdated: event }
  };
  const c = vm.createContext({ chrome, console, URL, importScripts() {} });
  vm.runInContext(source, c); await vm.runInContext("runtimeStateReady", c);
  await assert.rejects(install(), /会话|配置/);
  assert.equal(panels.length, 1); assert.equal(panels[0].openPanelOnActionClick, true);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const endpoint = "https://api.vayne.cc.cd/v1/responses";
const engine = read("src/reply-engine.js");
const background = read("src/background.js");

function declaration(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, name);
  const next = /^(?:async )?function \w+\(/gm;
  next.lastIndex = match.index + match[0].length;
  const end = next.exec(source)?.index ?? source.length;
  return source.slice(match.index, end);
}
function settingsContext() {
  const context = vm.createContext({
    URL, console, importScripts() {},
    chrome: { runtime: { getURL: (p) => p } }
  });
  const start = background.indexOf("const DEFAULT_SETTINGS =");
  const end = background.indexOf("\n};", start) + 3;
  vm.runInContext(background.slice(0, end), context);
  for (const name of ["migrateSettings", "normalizeSettings",
    background.includes("function normalizeClockTime(") ? "normalizeClockTime" : "normalizeClock"]) {
    vm.runInContext(declaration(background, name), context);
  }
  return context;
}

test("all provider aliases use the fixed Responses endpoint and chosen model", async () => {
  const requests = [];
  const context = vm.createContext({
    URL, console, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, text: async () => JSON.stringify({ output_text: "reply" }) };
    }
  });
  vm.runInContext(engine, context);
  for (const provider of ["openai", "gpt-5-nano", "gpt-5.6-terra", "deepseek", "grok", "gemini", "gemini-flash"]) {
    assert.equal(await context.callAIProvider(provider, "test-key", "prompt", "tweet", {
      model: "chosen-model", apiUrl: endpoint
    }), "reply");
  }
  assert.equal(requests.length, 7);
  for (const request of requests) {
    assert.equal(request.url, endpoint);
    assert.equal(request.body.model, "chosen-model");
    assert.ok(Array.isArray(request.body.input));
    assert.equal(request.body.messages, undefined);
    assert.equal(request.body.contents, undefined);
    assert.equal(request.options.headers.Authorization, "Bearer test-key");
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.credentials, "omit");
  }
});

test("direct endpoint overrides are rejected before any credential is sent", async () => {
  let calls = 0;
  const context = vm.createContext({
    URL, console, AbortController, setTimeout, clearTimeout,
    fetch: async () => { calls++; throw Error("unexpected request"); }
  });
  vm.runInContext(engine, context);
  for (const apiUrl of ["https://other.example/v1/responses", endpoint + "?x=1", "http://api.vayne.cc.cd/v1/responses"]) {
    await assert.rejects(context.callAIProvider("openai", "test-key", "prompt", "tweet", { apiUrl }), /URL/);
  }
  assert.equal(calls, 0);
});

test("settings lock the endpoint, preserve models, and discard foreign legacy keys", () => {
  const context = settingsContext();
  const defaults = context.normalizeSettings({});
  for (const aiApiUrl of ["https://old.example/v1/responses", "", undefined]) {
    const migrated = context.normalizeSettings({
      settingsVersion: defaults.settingsVersion,
      aiProvider: "deepseek", aiApiUrl, aiApiKey: "old-key", aiModel: "custom-model"
    });
    assert.equal(migrated.aiApiUrl, endpoint);
    assert.equal(migrated.aiApiKey, "");
    assert.equal(migrated.aiModel, "custom-model");
  }
  const same = context.normalizeSettings({
    settingsVersion: defaults.settingsVersion,
    aiApiUrl: endpoint, aiApiKey: "relay-key", aiModel: "another-model"
  });
  assert.equal(same.aiApiKey, "relay-key");
  assert.equal(same.aiModel, "another-model");
  assert.equal(context.normalizeSettings(same).aiApiKey, "relay-key");
});

test("AI settings expose model and key but no endpoint or protocol field", () => {
  const html = read("src/debug/debug.html");
  const script = read("src/debug/debug.js");
  assert.match(html, /id="aiModel"/);
  assert.match(html, /id="aiApiKey" type="password"/);
  assert.doesNotMatch(html, /id="(?:aiApiUrl|aiEndpoint|aiProtocol|aiProvider)"/);
  assert.doesNotMatch(script, /fields\.aiApiUrl/);
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(manifest.host_permissions.includes("https://api.vayne.cc.cd/*"));
});

// Review-time checks added during the 2026-09-11 self-audit.
// Run with: node tests/review-check.mjs
// These pin review findings; failures below correspond to findings in the
// review report and must be resolved (or consciously accepted) before merge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const background = read("src/background.js");
const engine = read("src/reply-engine.js");
const xPage = read("src/content/x.js");
let passed = 0;
const failures = [];
const test = async (name, action) => {
  try {
    await action();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${String(error.message || error).split("\n")[0]}`);
  }
};

function declaration(source, name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing function: ${name}`);
  const start = match.index;
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = start + match[0].length;
  const end = next.exec(source)?.index ?? source.lastIndexOf("})();");
  return source.slice(start, end > start ? end : source.length);
}
function contextFor(source, names, globals = {}) {
  const context = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout,
    normalize: (s) => String(s).replace(/\s+/g, " ").trim(),
    normalizeText: (s) => String(s).replace(/\s+/g, " ").trim(),
    startTaskWidgetAssist() {}, ...globals });
  for (const name of names) vm.runInContext(declaration(source, name), context);
  return context;
}

const USER_FALLBACK_REPLIES = [
  "牛逼，写得真好",
  "写得挺好的，收获不少",
  "讲得很清楚，重点抓得准",
  "老师这篇写得很专业",
  "好的，朕知道了",
  "写得有点东西，继续更新",
  "内容扎实，读完很有收获",
  "观点很实在，确实挺受用",
  "分析得不错，细节也到位",
  "信息整理得很完整",
  "讲得挺透，感谢分享",
  "写得很顺，读起来舒服"
];
const XINHUO_FALLBACK_REPLIES = [
  "说得很实在，读完有点启发",
  "内容讲得明白，收获不少",
  "思路挺清晰，读起来很顺畅",
  "看完更好理解这件事了",
  "观点比较实用，挺有启发的",
  "表达很清楚，读着也舒服"
];
const BLACKLIST_GLOBALS = {
  DEFAULT_AI_SYSTEM_PROMPT: "prompt",
  DEFAULT_REPLY_BLACKLIST: ["\n", "有点东西", "真香"],
  REPLY_STRUCTURAL_BLACKLIST: [{ label: "句首这系起手", regex: /^[\s'"“”‘’「」『』()（）【】]*?(?:这|这个|这条|这类|这种|这波)/i }],
  REPLY_HARD_BAN_PHRASES: ["值得关注"],
  MIN_REPLY_CHINESE_CHARS: 5,
  MAX_REPLY_CHINESE_CHARS: 20,
  USER_FALLBACK_REPLIES,
  XINHUO_FALLBACK_REPLIES,
  fallbackReplyBag: [],
  loadedReplyBlacklist: [],
  chrome: { storage: null }
};
const ENGINE_FUNCS = [
  "pickUserFallbackReply", "refillFallbackReplyBag", "takeNextValidFallbackReply",
  "normalizeReplyMinChineseChars",
  "getPromptReplyLengthRange", "getReplyLengthRange",
  "validateFinalReplyText", "isUsableReplyText", "normalizeBlacklistCandidateText",
  "countReplyChineseChars", "detectReplyTextDegeneration", "checkBlacklistedWords",
  "getReplyBlacklistSnapshot", "escapeRegExp"
];

// Happy path: the long fallback bag honours the default task range, while a
// user-declared upper bound may safely extend beyond the legacy 15-character cap.
await test("long fallback bag honours the default range and configured limits may reach 60", async () => {
  const c = contextFor(engine, ENGINE_FUNCS, BLACKLIST_GLOBALS);
  assert.equal(c.normalizeReplyMinChineseChars(0), 5);
  assert.equal(c.normalizeReplyMinChineseChars(99), 60);
  assert.equal(c.normalizeReplyMinChineseChars(10), 10);
  const seen = new Set();
  for (let index = 0; index < 6; index += 1) {
    const reply = await c.pickUserFallbackReply("tweet", { minChineseChars: 10 });
    seen.add(reply);
    const chars = c.countReplyChineseChars(reply);
    assert.ok(chars >= 10 && chars <= 20, `fallback "${reply}" has ${chars} chinese chars, expected 10..20`);
  }
  assert.equal(seen.size, 6, "the long bag should serve six distinct replies before refilling");
});

await test("common word 确实 is accepted while the shipped blacklist also permits it", () => {
  const c = contextFor(engine, [
    "parseReplyBlacklistText", "validateFinalReplyText", "isUsableReplyText",
    "normalizeReplyMinChineseChars", "getPromptReplyLengthRange", "getReplyLengthRange",
    "normalizeBlacklistCandidateText", "countReplyChineseChars", "detectReplyTextDegeneration",
    "checkBlacklistedWords", "getReplyBlacklistSnapshot", "escapeRegExp"
  ], BLACKLIST_GLOBALS);
  const shippedBlacklist = c.parseReplyBlacklistText(read("src/reply_blacklist.txt"));
  assert.equal(shippedBlacklist.includes("确实"), false);
  assert.equal(c.validateFinalReplyText("确实能感觉到细节做得挺用心", "10到20个汉字", { minChineseChars: 10 }).ok, true);
});

// Failure path: a fallback reply is posted verbatim when the AI fails, so it
// must pass the same validation the AI reply must pass — including blacklist
// words declared in the user's own system prompt. (Regression vs Lighthouse,
// where takeNextValidFallbackReply enforced this.)
await test("fallback replies must pass validateFinalReplyText incl. prompt-declared bans", async () => {
  const c = contextFor(engine, ENGINE_FUNCS, BLACKLIST_GLOBALS);
  const prompt = "生成词黑名单：收获";
  const seen = [];
  for (let index = 0; index < 6; index += 1) {
    const reply = await c.pickUserFallbackReply("tweet", { minChineseChars: 10, systemPrompt: prompt });
    seen.push(reply);
    assert.equal(
      c.validateFinalReplyText(reply, prompt, { minChineseChars: 10 }).ok,
      true,
      `fallback reply failed validation: ${reply}`
    );
  }
  assert.ok(!seen.some((reply) => reply.includes("收获")), "prompt-banned fallback must never be returned");
});

// Boundary / adjacent scenario: an invalid custom AI endpoint must fail loudly.
// Silently falling back to the provider endpoint sends a relay key to the real
// provider (or a provider key to the wrong service) with no diagnostic.
await test("invalid custom AI endpoint must not silently fall back to the provider endpoint", async () => {
  let fetchedUrl = "";
  const c = contextFor(engine, ["callAIProvider", "readJsonResponse", "normalizeCustomAIEndpoint"], {
    AI_PROVIDER_CONFIG: { openai: { endpoint: "https://api.openai.com/v1/responses", model: "provider-default" } },
    fetch: async (url) => {
      fetchedUrl = url;
      return { ok: true, text: async () => JSON.stringify({ output_text: "不应发送" }) };
    }
  });
  await assert.rejects(
    c.callAIProvider("openai", "relay-key", "prompt", "tweet", {
      model: "gpt-5.6-terra",
      apiUrl: "https://relay.example/v1/chat/completions",
      timeout: 1000
    }),
    /自定义|invalid|URL/i
  );
  assert.equal(fetchedUrl, "");
});

// Boundary / adjacent scenario: keep the re-injection guard version in lockstep
// with the manifest (see the Lighthouse finding for what happens when it drifts).
await test("content-script SCRIPT_VERSION matches the manifest version", async () => {
  const contentFiles = ["src/content/xinhuo.js", "src/content/x.js"];
  for (const file of contentFiles) {
    const match = read(file).match(/SCRIPT_VERSION\s*=\s*"([^"]+)"/);
    assert.ok(match, `${file} must declare SCRIPT_VERSION`);
    assert.equal(match[1], manifest.version, `${file} SCRIPT_VERSION is stale`);
  }
});

// Ported from the Lighthouse side: while the active reply step runs, X may
// swap the route to /compose/post with a visible composer. That transition
// must not cancel the step; any other URL change still must.
await test("only the active reply step may survive a visible X compose route", async () => {
  const c = contextFor(xPage, ["assertActiveRun", "isExpectedReplyComposeTransition"], {
    activeTargetUrl: "https://x.com/test/status/123",
    activeRunId: "run-1",
    activeStepName: "RUN_X_REPLY",
    activeStepStartedAt: Date.now(),
    cancelledRunIds: new Set(),
    location: { href: "https://x.com/compose/post" },
    document: { querySelector: () => ({}) },
    normalizeTweetUrl: (value) => /\/status\/\d+/.test(String(value || "")) ? String(value) : ""
  });
  assert.doesNotThrow(() => c.assertActiveRun("run-1"));
  c.activeStepName = "COMPLETE_X_TASK_WIDGET";
  assert.throws(() => c.assertActiveRun("run-1"), /目标推文已变化/);
  c.activeStepName = "RUN_X_REPLY";
  c.document.querySelector = () => null;
  assert.throws(() => c.assertActiveRun("run-1"), /目标推文已变化/);
});

// The Gemini API key must travel in the x-goog-api-key header, never in the
// request URL where it can leak into network/proxy logs.
await test("gemini requests authenticate via header, not the URL query string", async () => {
  let fetchedUrl = "";
  let headers = null;
  const c = contextFor(engine, ["callAIProvider", "readJsonResponse"], {
    AI_PROVIDER_CONFIG: {
      gemini: {
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
        model: "gemini-3-pro-preview"
      }
    },
    normalizeCustomAIEndpoint: () => "",
    fetch: async (url, options) => {
      fetchedUrl = url;
      headers = options.headers;
      return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "好" }] } }] }) };
    }
  });
  assert.equal(await c.callAIProvider("gemini", "secret-key", "prompt", "tweet", { timeout: 100 }), "好");
  assert.equal(headers["x-goog-api-key"], "secret-key");
  assert.ok(!fetchedUrl.includes("key="), `API key leaked into the request URL: ${fetchedUrl}`);
});

console.log(`xinhuo review checks: ${passed} passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;

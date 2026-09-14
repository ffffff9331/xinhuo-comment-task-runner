const DEFAULT_AI_SYSTEM_PROMPT = "根据原推文写一句自然的中文回复。像真实用户刷到后随手留下的感受，简短、有一点具体反应，不必完整表达观点。10到15个汉字为主，可保留必要的英文词。避免宣传腔、总结腔、夸张吹捧、复述原文和模板化感叹。只输出回复。";

const AI_PROVIDER_CONFIG = {
  openai: {
    endpoint: "https://api.openai.com/v1/responses",
    model: "gpt-3.5-turbo"
  },
  "gpt-5-nano": {
    endpoint: "https://api.openai.com/v1/responses",
    model: "gpt-5-nano"
  },
  "gpt-5.6-terra": {
    endpoint: "https://api.openai.com/v1/responses",
    model: "gpt-5.6-terra"
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat"
  },
  grok: {
    endpoint: "https://api.x.ai/v1/chat/completions",
    model: "grok-beta"
  },
  gemini: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
    model: "gemini-3-pro-preview"
  },
  "gemini-flash": {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
    model: "gemini-3-flash-preview"
  }
};

const DEFAULT_REPLY_BLACKLIST = [
  "\n",
  "格局打开",
  "未来可期",
  "真香",
  "稳了",
  "HODL",
  "革命",
  "未来",
  "香",
  "格局",
  "硬道理",
  "走起",
  "这波",
  "这个",
  "这条",
  "这类",
  "这种",
  "值得关注",
  "值得细读",
  "值得继续看",
  "值得继续观察",
  "值得跟踪",
  "继续观察",
  "适合做快讯",
  "信息量很大",
  "硬核",
  "会玩",
  "静待",
  "花开",
  "才是",
  "绝了",
  "有点东西",
  "有点意思",
  "确实",
  "真实",
  "真本事",
  "我熟",
  "香港见",
  "现场见",
  "到时候见",
  "线下见",
  "不见不散",
  "我也去",
  "俺也去",
  "去看看",
  "去见见",
  "先报名",
  "报名了",
  "到场支持"
];

const REPLY_STRUCTURAL_BLACKLIST = [
  {
    label: "句首这系起手",
    regex: /^[\s'"“”‘’「」『』()（）【】]*?(?:这|这个|这条|这类|这种|这波)/i
  }
];

const REPLY_HARD_BAN_PHRASES = [
  "值得关注",
  "值得细读",
  "值得继续看",
  "值得继续观察",
  "值得跟踪",
  "继续观察",
  "适合做快讯",
  "信息量很大"
];

const MIN_REPLY_CHINESE_CHARS = 5;
const MAX_REPLY_CHINESE_CHARS = 15;
// One initial request plus five retries. The final attempt may use the
// multi-candidate prompt, but every provider call shares this total budget.
const MAX_AI_NORMAL_ATTEMPTS = 6;
const DEFAULT_AI_TIMEOUT_MS = 60000;
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

let loadedReplyBlacklist = [...DEFAULT_REPLY_BLACKLIST];
let replyBlacklistLoadPromise = null;
let fallbackReplyBag = [];

async function ensureReplyBlacklistLoaded(force = false) {
  if (!force && replyBlacklistLoadPromise) return replyBlacklistLoadPromise;
  replyBlacklistLoadPromise = (async () => {
    try {
      const response = await fetch(chrome.runtime.getURL("src/reply_blacklist.txt"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const parsed = parseReplyBlacklistText(text);
      loadedReplyBlacklist = parsed.length ? Array.from(new Set(["\n", ...parsed])) : [...DEFAULT_REPLY_BLACKLIST];
    } catch (error) {
      console.warn("[ReplyEngine] Failed to load blacklist, fallback to defaults:", error);
      loadedReplyBlacklist = [...DEFAULT_REPLY_BLACKLIST];
    }
    return loadedReplyBlacklist;
  })();
  return replyBlacklistLoadPromise;
}

async function generateLighthouseAIReply(aiConfig, tweet, options = {}) {
  await ensureReplyBlacklistLoaded();

  const provider = normalizeProvider(aiConfig.provider);
  const apiKey = String(aiConfig.apiKey || "").trim();
  const tweetContent = buildTweetContent(tweet);
  if (!apiKey) throw new Error("AI API Key 为空，请先在侧栏填写");
  if (!tweetContent) throw new Error("未读取到推文正文，无法生成回复");

  const basePrompt = appendTaskReplyLengthInstruction(
    appendEventReplyGuardInstruction(
      appendReplyHardBanInstruction(String(aiConfig.systemPrompt || DEFAULT_AI_SYSTEM_PROMPT).trim()),
      tweetContent
    ),
    options
  );

  const replyResult = await callAIWithSolaRetry(provider, apiKey, basePrompt, tweetContent, {
    apiUrl: aiConfig.apiUrl,
    model: aiConfig.model,
    signal: options.signal,
    timeout: options.timeout || DEFAULT_AI_TIMEOUT_MS,
    minChineseChars: normalizeReplyMinChineseChars(options.minChineseChars)
  });
  const diagnostics = replyResult?.diagnostics || [];
  const finalReplyText = replyResult?.replyText || await pickUserFallbackReply(tweetContent, {
    ...options,
    systemPrompt: basePrompt
  });

  return { ok: true, replyText: finalReplyText, tweetContent, provider, fallback: !replyResult?.replyText, diagnostics };
}

async function callAIProvider(provider, apiKey, systemPrompt, tweetContent, options) {
  const config = AI_PROVIDER_CONFIG[provider];
  if (!config) throw new Error(`Unsupported AI provider: ${provider}`);
  const requestModel = String(options.model || "").trim() || config.model;
  const customApiUrl = String(options.apiUrl || "").trim();
  const normalizedCustomApiUrl = normalizeCustomAIEndpoint(provider, customApiUrl);
  if (customApiUrl && !normalizedCustomApiUrl) {
    throw new Error("自定义 AI URL 无效或与当前接口协议不匹配");
  }
  const apiUrl = normalizedCustomApiUrl || config.endpoint;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("任务已停止"));
  if (options.signal?.aborted) throw new Error("任务已停止");
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 60000;
  const timer = setTimeout(() => controller.abort(new Error(`AI 请求超时：${timeout}ms`)), timeout);

  try {
    if (provider === "gemini" || provider === "gemini-flash") {
      const body = {
        contents: [
          {
            parts: [
              {
                text: `${systemPrompt}\n\nTweet: "${tweetContent}"\n\nReply:`
              }
            ]
          }
        ]
      };
      if (provider === "gemini") {
        body.generationConfig = { thinkingConfig: { thinkingLevel: "low" } };
      }
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const data = await readJsonResponse(response);
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    // All OpenAI providers use the Responses API. Chat Completions fields such
    // as `messages` and `temperature` are rejected by Responses gateways.
    if (provider === "openai" || provider === "gpt-5-nano" || provider === "gpt-5.6-terra") {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: requestModel,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Tweet: "${tweetContent}"\n\nGenerate a reply:` }
          ],
          max_output_tokens: 256
        }),
        signal: controller.signal
      });
      const data = await readJsonResponse(response);
      if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
      if (Array.isArray(data.output)) {
        for (const item of data.output) {
          const content = Array.isArray(item?.content) ? item.content : [];
          const textItem = content.find((part) => typeof part?.text === "string" && part.text.trim());
          if (textItem?.text) return textItem.text;
        }
      }
      return "";
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: requestModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Tweet: "${tweetContent}"\n\nGenerate a reply:` }
        ],
        temperature: 0.7
      }),
      signal: controller.signal
    });
    const data = await readJsonResponse(response);
    return data.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function callAIWithSolaRetry(
  provider,
  apiKey,
  systemPrompt,
  tweetContent,
  options,
  blacklistRetryCount = 0,
  multiCandidateMode = false,
  diagnostics = [],
  aiAttempt = 0
) {
  if (options.signal?.aborted) throw new Error("任务已停止");
  const stage = multiCandidateMode ? `候选兜底（第${aiAttempt + 1}轮）` : `第${aiAttempt + 1}轮`;
  let rawReply = "";
  try {
    rawReply = await callAIProvider(provider, apiKey, systemPrompt, tweetContent, options);
  } catch (error) {
    if (options.signal?.aborted) throw new Error("任务已停止");
    diagnostics.push(createReplyDiagnostic(stage, "", "", {
      reason: "api_error",
      error: error?.message || String(error),
      blacklistWords: []
    }));
    if (aiAttempt < MAX_AI_NORMAL_ATTEMPTS - 1) {
      await delay(800);
      return callAIWithSolaRetry(
        provider,
        apiKey,
        systemPrompt,
        tweetContent,
        options,
        blacklistRetryCount + 1,
        false,
        diagnostics,
        aiAttempt + 1
      );
    }
    return { replyText: "", diagnostics };
  }
  if (!rawReply) {
    const validation = { ok: false, reason: "empty", blacklistWords: [] };
    diagnostics.push(createReplyDiagnostic(stage, rawReply, "", validation));
    return retryAIReplyAfterValidation(
      provider,
      apiKey,
      systemPrompt,
      tweetContent,
      options,
      blacklistRetryCount,
      validation,
      diagnostics,
      aiAttempt
    );
  }

  if (multiCandidateMode) {
    const candidates = extractBlacklistCandidates(rawReply);
    if (!candidates.length) {
      diagnostics.push(createReplyDiagnostic(stage, rawReply, "", { reason: "empty", blacklistWords: [] }));
      return { replyText: "", diagnostics };
    }
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const normalizedCandidate = normalizeBlacklistCandidateText(candidate);
      const validation = validateFinalReplyText(normalizedCandidate, systemPrompt, options);
      diagnostics.push(createReplyDiagnostic(`${stage}${index + 1}`, candidate, normalizedCandidate, validation));
      if (validation.ok) return { replyText: normalizedCandidate, diagnostics };
    }
    return { replyText: "", diagnostics };
  }

  const normalizedReplyText = normalizeBlacklistCandidateText(rawReply);
  const validation = validateFinalReplyText(normalizedReplyText, systemPrompt, options);
  diagnostics.push(createReplyDiagnostic(stage, rawReply, normalizedReplyText, validation));
  if (validation.ok) return { replyText: normalizedReplyText, diagnostics };

  return retryAIReplyAfterValidation(
    provider,
    apiKey,
    systemPrompt,
    tweetContent,
    options,
    blacklistRetryCount,
    validation,
    aiAttempt
  );
}

async function retryAIReplyAfterValidation(
  provider,
  apiKey,
  systemPrompt,
  tweetContent,
  options,
  blacklistRetryCount,
  validation,
  diagnostics,
  aiAttempt
) {
  const retryWords = getValidationRetryWords(validation);
  if (!retryWords.length) return { replyText: "", diagnostics };
  if (aiAttempt >= MAX_AI_NORMAL_ATTEMPTS - 1) return { replyText: "", diagnostics };

  const nextAttempt = aiAttempt + 1;
  const useCandidatePrompt = nextAttempt === MAX_AI_NORMAL_ATTEMPTS - 1;
  const nextSystemPrompt = useCandidatePrompt
    ? buildBlacklistCandidatePrompt(systemPrompt, retryWords)
    : enhanceSystemPromptWithBlacklist(systemPrompt, retryWords);
  await delay(500);
  return callAIWithSolaRetry(
    provider,
    apiKey,
    nextSystemPrompt,
    tweetContent,
    options,
    blacklistRetryCount + 1,
    useCandidatePrompt,
    diagnostics,
    nextAttempt
  );
}

async function readJsonResponse(response) {
  const rawText = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 300)}`);
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    throw new Error(`AI 响应不是有效 JSON: ${error.message}`);
  }
}

function normalizeProvider(provider) {
  return AI_PROVIDER_CONFIG[provider] ? provider : "deepseek";
}

function normalizeCustomAIEndpoint(provider, input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!/^https:$/i.test(url.protocol)) return "";
    if (provider === "gemini" || provider === "gemini-flash") {
      if (!/\/v\d+(alpha|beta)?\/models\/[^?#]+:generateContent$/i.test(url.pathname || "")) return "";
    }
    if (provider === "openai" || provider === "gpt-5-nano" || provider === "gpt-5.6-terra") {
      if (!/\/v\d+(?:\/responses)?$/i.test(url.pathname || "") && !/\/responses$/i.test(url.pathname || "")) return "";
    }
    return url.toString();
  } catch (_) {
    return "";
  }
}

function buildTweetContent(tweet) {
  const parts = [];
  if (tweet?.authorName || tweet?.authorHandle) {
    parts.push(`Author: ${[tweet.authorName, tweet.authorHandle].filter(Boolean).join(" ")}`);
  }
  if (tweet?.text) parts.push(`Text: ${tweet.text}`);
  if (tweet?.url) parts.push(`URL: ${tweet.url}`);
  return parts.join("\n").trim();
}

function normalizeBlacklistCandidateText(text) {
  if (!text) return "";
  return String(text)
    .replace(/^[\s>*#-]+/gm, "")
    .replace(/^\d+[.)、：:]\s*/gm, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, "")
    .trim();
}

function countReplyChineseChars(text) {
  const matches = String(text || "").match(/[\u4e00-\u9fa5]/g);
  return matches ? matches.length : 0;
}

function detectReplyTextDegeneration(value) {
  const raw = String(value || "")
    .replace(/\uFEFF/g, "")
    .trim();
  if (!raw) return { blocked: false, reasonCode: "", reasonText: "" };
  const compact = raw.replace(/\s+/g, "");
  const signalText = compact.replace(/[，。！？、,.!?;；:：'"“”‘’`~…\-—_()[\]{}<>《》【】]/g, "");
  const chars = Array.from(signalText);
  if (chars.length >= 40) {
    const uniqueRatio = new Set(chars).size / chars.length;
    if (uniqueRatio <= 0.22) {
      return {
        blocked: true,
        reasonCode: "REPLY_DEGENERATE_LOW_VARIETY",
        reasonText: "回复文本字符重复度过高，疑似模型退化输出"
      };
    }
    for (let size = 2; size <= 8; size += 1) {
      const counts = new Map();
      for (let i = 0; i <= chars.length - size; i += 1) {
        const gram = chars.slice(i, i + size).join("");
        counts.set(gram, (counts.get(gram) || 0) + 1);
      }
      let maxCount = 0;
      let maxGram = "";
      counts.forEach((count, gram) => {
        if (count > maxCount) {
          maxCount = count;
          maxGram = gram;
        }
      });
      const coverage = (maxCount * size) / chars.length;
      if (maxCount >= 6 && coverage >= 0.45) {
        return {
          blocked: true,
          reasonCode: "REPLY_DEGENERATE_REPEATED_NGRAM",
          reasonText: `回复文本重复片段过多：${maxGram}`
        };
      }
    }
  }
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length >= 12) {
    const uniqueWordRatio = new Set(words.map((word) => word.toLowerCase())).size / words.length;
    if (uniqueWordRatio <= 0.35) {
      return {
        blocked: true,
        reasonCode: "REPLY_DEGENERATE_REPEATED_WORDS",
        reasonText: "回复文本词语重复度过高，疑似模型退化输出"
      };
    }
  }
  return { blocked: false, reasonCode: "", reasonText: "" };
}

function normalizeReplyMinChineseChars(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, MIN_REPLY_CHINESE_CHARS), MAX_REPLY_CHINESE_CHARS)
    : MIN_REPLY_CHINESE_CHARS;
}

function isUsableReplyText(text, options = {}) {
  const chineseChars = countReplyChineseChars(text);
  return chineseChars >= normalizeReplyMinChineseChars(options.minChineseChars) && chineseChars <= MAX_REPLY_CHINESE_CHARS;
}

function validateFinalReplyText(text, systemPrompt, options = {}) {
  const normalized = normalizeBlacklistCandidateText(text);
  if (!normalized) {
    return { ok: false, reason: "empty", blacklistWords: [] };
  }
  if (!isUsableReplyText(normalized, options)) {
    return { ok: false, reason: "length", blacklistWords: [], minChineseChars: normalizeReplyMinChineseChars(options.minChineseChars) };
  }
  const blacklistCheck = checkBlacklistedWords(normalized, systemPrompt);
  if (blacklistCheck.hasBlacklisted) {
    return { ok: false, reason: "blacklist", blacklistWords: blacklistCheck.words || [] };
  }
  const qualityCheck = detectReplyTextDegeneration(normalized);
  if (qualityCheck.blocked) {
    return { ok: false, reason: qualityCheck.reasonCode || "quality", blacklistWords: [] };
  }
  return { ok: true, reason: "", blacklistWords: [] };
}

function createReplyDiagnostic(stage, rawReply, normalizedReply, validation = {}) {
  const blacklistWords = Array.isArray(validation.blacklistWords) ? validation.blacklistWords : [];
  const normalized = String(normalizedReply || "");
  const reason = validation.ok ? "ok" : validation.reason || "unknown";
  return {
    stage: String(stage || "未知轮次"),
    ok: Boolean(validation.ok),
    raw: clipReplyDiagnosticText(rawReply, 90),
    normalized: clipReplyDiagnosticText(normalized, 90),
    charCount: countReplyChineseChars(normalized),
    reason,
    reasonText: describeReplyFailureReason(reason, normalized, blacklistWords, validation.error, validation.minChineseChars),
    blacklistWords
  };
}

function describeReplyFailureReason(reason, normalizedReply, blacklistWords, error, minChineseChars = MIN_REPLY_CHINESE_CHARS) {
  if (reason === "ok") return "通过";
  if (reason === "api_error") return `AI接口异常：${clipReplyDiagnosticText(error, 120) || "未知错误"}`;
  if (reason === "empty") return "AI没有返回可用文本";
  if (reason === "length") return `中文部分长度不合规：${countReplyChineseChars(normalizedReply)}个汉字，要求${normalizeReplyMinChineseChars(minChineseChars)}到${MAX_REPLY_CHINESE_CHARS}个汉字`;
  if (reason === "blacklist") {
    const words = Array.isArray(blacklistWords) && blacklistWords.length ? blacklistWords.join("、") : "未知黑名单词";
    return `命中黑名单：${words}`;
  }
  if (reason === "REPLY_DEGENERATE_LOW_VARIETY") return "字符重复度过高，疑似模型退化输出";
  if (reason === "REPLY_DEGENERATE_REPEATED_NGRAM") return "重复片段过多，疑似模型退化输出";
  if (reason === "REPLY_DEGENERATE_REPEATED_WORDS") return "词语重复度过高，疑似模型退化输出";
  return `未通过规则：${reason || "unknown"}`;
}

function clipReplyDiagnosticText(text, maxLength) {
  const normalized = String(text || "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\s+/g, " ")
    .trim();
  const limit = Math.max(10, Number(maxLength) || 90);
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  return `${chars.slice(0, limit).join("")}...`;
}

function getValidationRetryWords(validation) {
  if (!validation || validation.ok) return [];
  if (Array.isArray(validation.blacklistWords) && validation.blacklistWords.length) {
    return validation.blacklistWords;
  }
  const reasonMap = {
    empty: "空回复",
    length: "回复中文部分长度不符合要求",
    REPLY_DEGENERATE_LOW_VARIETY: "回复字符重复度过高",
    REPLY_DEGENERATE_REPEATED_NGRAM: "回复重复片段过多",
    REPLY_DEGENERATE_REPEATED_WORDS: "回复词语重复度过高"
  };
  return [reasonMap[validation.reason] || validation.reason || "回复不符合规则"];
}

function truncateReplyText(text) {
  if (!text) return "";
  const chars = Array.from(String(text).replace(/\s+/g, ""));
  if (chars.length <= MAX_REPLY_CHINESE_CHARS) return chars.join("");
  return chars.slice(0, MAX_REPLY_CHINESE_CHARS).join("");
}

function extractBlacklistCandidates(replyText) {
  if (!replyText) return [];
  const raw = String(replyText).trim();
  const lineParts = raw.split(/\n+/).map((part) => normalizeBlacklistCandidateText(part)).filter(Boolean);
  const candidates = [];
  lineParts.forEach((segment) => {
    const subParts = segment.split(/\s*\|\|\|\s*|\s*###\s*/).map((part) => normalizeBlacklistCandidateText(part)).filter(Boolean);
    if (subParts.length > 1) candidates.push(...subParts);
    else candidates.push(segment);
  });
  return Array.from(new Set(candidates)).slice(0, 6);
}

async function pickUserFallbackReply(seed, options = {}) {
  const minChineseChars = normalizeReplyMinChineseChars(options.minChineseChars);
  const replies = minChineseChars >= 10 ? XINHUO_FALLBACK_REPLIES : USER_FALLBACK_REPLIES;
  if (!replies.length) {
    throw new Error("AI 未生成符合 Sola 与插件规则的回复，且兜底池为空");
  }

  const storageArea = typeof chrome !== "undefined" && chrome.storage
    ? (chrome.storage.session || chrome.storage.local)
    : null;
  if (storageArea) {
    try {
      const bagKey = minChineseChars >= 10 ? "xinhuoFallbackReplyBag" : "lighthouseFallbackReplyBag";
      const stored = await storageArea.get([bagKey]);
      const storedBag = Array.isArray(stored?.[bagKey])
        ? stored[bagKey].filter((reply) => replies.includes(reply))
        : [];
      if (storedBag.length) fallbackReplyBag = storedBag;
    } catch (_) {}
  }

  fallbackReplyBag = fallbackReplyBag.filter((reply) => replies.includes(reply));
  if (!fallbackReplyBag.length) refillFallbackReplyBag(replies);

  let reply = takeNextValidFallbackReply(options);
  if (!reply) {
    refillFallbackReplyBag(replies);
    reply = takeNextValidFallbackReply(options);
  }
  if (!reply) {
    throw new Error("AI 未生成合规回复，兜底回复也未通过长度或黑名单校验");
  }
  if (storageArea) {
    try {
      const bagKey = minChineseChars >= 10 ? "xinhuoFallbackReplyBag" : "lighthouseFallbackReplyBag";
      await storageArea.set({ [bagKey]: fallbackReplyBag });
    } catch (_) {}
  }
  return reply;
}

function refillFallbackReplyBag(replies) {
  fallbackReplyBag = [...replies];
  for (let index = fallbackReplyBag.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [fallbackReplyBag[index], fallbackReplyBag[swapIndex]] = [fallbackReplyBag[swapIndex], fallbackReplyBag[index]];
  }
}

function takeNextValidFallbackReply(options = {}) {
  const systemPrompt = String(options.systemPrompt || DEFAULT_AI_SYSTEM_PROMPT);
  while (fallbackReplyBag.length) {
    const candidate = fallbackReplyBag.pop();
    if (validateFinalReplyText(candidate, systemPrompt, options).ok) return candidate;
  }
  return "";
}

function buildBlacklistCandidatePrompt(systemPrompt, blacklistedWords) {
  const basePrompt = enhanceSystemPromptWithBlacklist(systemPrompt, blacklistedWords || []);
  return `${basePrompt}\n\n最后兜底：请一次性生成 3 条不同的候选回复。要求：\n1. 每条都必须是单行\n2. 每条前面加 1. / 2. / 3.\n3. 不要解释，不要写标题\n4. 三条都要自然、像真人回复`;
}

function appendReplyHardBanInstruction(systemPrompt) {
  const base = String(systemPrompt || "").trim();
  const hardRule = "硬性禁令：1. 禁止使用“这 / 这个 / 这条 / 这类 / 这种 / 这波”作为句首。2. 禁止出现“值得关注 / 值得细读 / 值得继续看 / 值得继续观察 / 值得跟踪 / 继续观察 / 适合做快讯 / 信息量很大”这类空泛点评。3. 一旦会写出上述表达，必须彻底换一种说法。";
  if (!base) return hardRule;
  if (base.includes("禁止使用“这 / 这个 / 这条 / 这类 / 这种 / 这波”作为句首")) return base;
  return `${base}\n\n${hardRule}`;
}

function appendTaskReplyLengthInstruction(systemPrompt, options = {}) {
  const minChineseChars = normalizeReplyMinChineseChars(options.minChineseChars);
  if (minChineseChars <= MIN_REPLY_CHINESE_CHARS) return systemPrompt;
  const rule = `任务硬性要求：中文回复必须不少于${minChineseChars}个汉字，且不超过${MAX_REPLY_CHINESE_CHARS}个汉字。`;
  return String(systemPrompt || "").includes(rule) ? String(systemPrompt || "") : `${String(systemPrompt || "").trim()}\n\n${rule}`.trim();
}

function detectEventInviteTweetContext(tweetContent) {
  const text = String(tweetContent || "").toLowerCase();
  if (!text) return false;
  const markers = ["luma.com", "lu.ma", "meetup", "side event", "side-event", "event", "hong kong", "报名", "活动", "见面", "线下", "邀请", "到场"];
  const hitCount = markers.reduce((sum, marker) => sum + (text.includes(marker) ? 1 : 0), 0);
  return hitCount >= 2 || (/4月\d{1,2}[日号]?/.test(text) && /(香港|hong kong|报名|活动|见面|线下)/i.test(text));
}

function appendEventReplyGuardInstruction(systemPrompt, tweetContent) {
  const base = String(systemPrompt || "").trim();
  if (!detectEventInviteTweetContext(tweetContent)) return base;
  const guard = "活动邀约帖额外约束：如果原文是在发活动、线下见面、报名或邀约，不要假装自己会去现场、报名、到场或赴约。禁止使用：香港见、现场见、到时候见、线下见、不见不散、我也去、俺也去、我去、去看看、去见见、先报名、报名了、到场支持。可以评论活动排面、嘉宾、信息密度、话题热度，但不要把自己写成已经决定参加的人。";
  if (!base) return guard;
  if (base.includes("活动邀约帖额外约束")) return base;
  return `${base}\n\n${guard}`;
}

function checkBlacklistedWords(replyText, systemPrompt) {
  if (!replyText) return { hasBlacklisted: false, words: [], blacklist: [] };

  const blacklist = getReplyBlacklistSnapshot();
  if (systemPrompt) {
    const blacklistPatterns = [
      /生成词黑名单[：:]\s*([\s\S]*?)(?=\n\s*(?:[^\s\n]|$)|$)/i,
      /黑名单[：:]\s*([\s\S]*?)(?=\n\s*(?:[^\s\n]|$)|$)/i,
      /禁止使用[：:]\s*([\s\S]*?)(?=\n\s*(?:[^\s\n]|$)|$)/i,
      /不要使用[：:]\s*([\s\S]*?)(?=\n\s*(?:[^\s\n]|$)|$)/i,
      /生成词黑名单[：:]\s*([\s\S]+?)(?=\n\n|\n[^\s\n]{2,}[：:]|$)/i
    ];
    for (const pattern of blacklistPatterns) {
      const match = systemPrompt.match(pattern);
      if (!match) continue;
      const expanded = match[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.match(/^[：:]/) && !line.match(/^生成词黑名单|^黑名单|^禁止使用|^不要使用/i))
        .flatMap((item) => item.split(/[，,、]/).map((part) => part.trim()).filter(Boolean));
      expanded.forEach((word) => {
        if (word && !blacklist.includes(word)) blacklist.push(word);
      });
      break;
    }
  }

  const foundWords = [];
  blacklist.forEach((word) => {
    if (!word) return;
    const isChinese = /[\u4e00-\u9fa5]/.test(word);
    const regex = isChinese
      ? new RegExp(escapeRegExp(word), "gi")
      : new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi");
    if (regex.test(replyText)) foundWords.push(word);
  });
  REPLY_STRUCTURAL_BLACKLIST.forEach((rule) => {
    if (rule.regex.test(String(replyText || "").trim())) foundWords.push(rule.label);
  });
  const uniqueWords = Array.from(new Set(foundWords));
  return {
    hasBlacklisted: uniqueWords.length > 0,
    words: uniqueWords,
    blacklist: [...blacklist, ...REPLY_HARD_BAN_PHRASES]
  };
}

function enhanceSystemPromptWithBlacklist(systemPrompt, blacklistedWords) {
  if (!blacklistedWords || blacklistedWords.length === 0) return systemPrompt;
  const displayWords = blacklistedWords.map((word) => (word === "\n" || word === "\r" ? "换行符" : word));
  const instruction = `\n\n重要：请确保回复中绝对不要包含以下词汇：${displayWords.join("、")}。如果回复中包含这些词汇，请用其他表达方式替换。回复请用单行，不要换行。`;
  return String(systemPrompt || "") + instruction;
}

function getReplyBlacklistSnapshot() {
  return Array.isArray(loadedReplyBlacklist) && loadedReplyBlacklist.length ? [...loadedReplyBlacklist] : [...DEFAULT_REPLY_BLACKLIST];
}

function parseReplyBlacklistText(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

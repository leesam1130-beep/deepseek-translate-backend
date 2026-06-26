// SemaTranslate / DeepSeek Translate Backend
// 服务区域：坦桑尼亚达累斯萨拉姆（Dar es Salaam）WhatsApp 商务聊天翻译。
// 主语言：斯瓦希里语 / 英语 / 法语；口语词库覆盖 Dar 常见连写、错拼与缩写。
// API Keys 仅保存在服务端环境变量，插件端不再持有任何密钥。
//
// Endpoints:
//   GET  /                              healthcheck (legacy)
//   GET  /api/health                    extension uses this for "测试连接"
//   POST /api/translate                 中文 → 客户语言（slim prompt 默认；mode:"expert" 可回退）
//   POST /api/batch-translate-incoming  批量来信 → 中文（slim prompt 默认；含 12 类意图 + 自动升级）
//   POST /intent                        意图识别（本地关键词优先，AI fallback；不带产品/历史）
//   POST /quote                         产品报价（仅匹配到的 1-5 条产品，不传整库）
//   POST /translate                     legacy 简单翻译（保持向后兼容）
//
// Token 优化（2026-06）:
//   - /api/translate system prompt: ~2700 → ~220 tokens（删除产品库/术语表/客户档案）
//   - /api/batch-translate-incoming system prompt: ~1100 → ~450 tokens（精简意图说明）
//   - 历史消息：限制到最近 3 条 × 100 字符
//   - 所有调用加 max_output_tokens 上限
//   - 新增 token 使用日志，input/output > 10:1 时输出 WARNING
//   - 安全网：保留旧 prompt 作为 expert 模式，可 per-request 或 env GWELL_TRANSLATE_DEFAULT_MODE=expert 回退
//   - 模型白名单：默认拒绝 gpt-4o / gpt-4.1 / o1 等昂贵模型（单价 16.7× mini），自动降级到 gpt-4o-mini
//                 env GWELL_ALLOW_PREMIUM_MODELS=true 可解除限制；典型日费用从 $1.55 → $0.10 量级

import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tryLocalIncomingTranslation, tryIncomingFallbackTranslation } from "./incoming-local.js";
import {
  recordUserUsage,
  checkUserQuota,
  getUserUsage,
  getUsageOverview,
  listAvailableMonths,
  getUsageStorageInfo,
  setUserQuota,
  adjustUserQuota,
  resetUserUsage,
  clearUserQuotaOverride,
  getUserQuotaInfo
} from "./usage-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
const adminDir = join(__dirname, "public", "admin");
app.use("/admin", express.static(adminDir, { index: "index.html" }));
app.get("/admin", (_req, res) => res.redirect(301, "/admin/"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

// --- DeepSeek（默认主 provider，OpenAI 当容灾备份）---
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const DEEPSEEK_DEFAULT_MODEL = (
  process.env.SEMA_DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat"
).toLowerCase().trim();
const PRIMARY_PROVIDER =
  String(process.env.SEMA_PRIMARY_PROVIDER || process.env.GWELL_PRIMARY_PROVIDER || "deepseek").toLowerCase() === "openai"
    ? "openai"
    : "deepseek";

if (!OPENAI_API_KEY && !DEEPSEEK_API_KEY) {
  console.warn("[sema-backend] WARNING: neither OPENAI_API_KEY nor DEEPSEEK_API_KEY is set; all translation routes will fail.");
} else if (!OPENAI_API_KEY) {
  console.warn("[sema-backend] OPENAI_API_KEY missing — OpenAI fallback disabled (only DeepSeek will be tried).");
} else if (!DEEPSEEK_API_KEY) {
  console.warn("[sema-backend] DEEPSEEK_API_KEY missing — DeepSeek fallback disabled (only OpenAI will be tried).");
}
console.log(`[sema-backend] primary provider: ${PRIMARY_PROVIDER} (DeepSeek default model: ${DEEPSEEK_DEFAULT_MODEL})`);

// ============================================================
// Token 优化相关：默认翻译模式 / 历史限幅 / 日志
// ============================================================
// GWELL_TRANSLATE_DEFAULT_MODE:
//   "slim"   (默认) → 短 prompt，省 token，质量已通过 GWELL 身份/数字保留规则保证
//   "expert"        → 旧版长 prompt（含完整术语表），仅在发现 slim 翻译质量下降时使用
// 准确率优先（默认开启）。SEMA_ACCURACY_PRIORITY=false 可回到省 token 模式。
const ACCURACY_PRIORITY = String(process.env.SEMA_ACCURACY_PRIORITY ?? "true").toLowerCase() !== "false";
const LOCAL_FAST_ENABLED = String(process.env.SEMA_LOCAL_FAST || "").toLowerCase() === "true";

const DEFAULT_TRANSLATE_MODE = (() => {
  const env = process.env.SEMA_TRANSLATE_DEFAULT_MODE || process.env.GWELL_TRANSLATE_DEFAULT_MODE;
  if (env) return String(env).toLowerCase() === "expert" ? "expert" : "slim";
  return ACCURACY_PRIORITY ? "expert" : "slim";
})();
console.log(`[sema-backend] default translate mode: ${DEFAULT_TRANSLATE_MODE} (accuracy priority: ${ACCURACY_PRIORITY})`);

// ============================================================
// 模型白名单（防止昂贵模型被默认调用，每年节省数百美元）
// ============================================================
// GWELL_ALLOW_PREMIUM_MODELS:
//   未设置 / "false" → 后端拒绝接受 gpt-4o / gpt-4.1 / o1 等高价模型，自动降级到 gpt-4o-mini
//   "true"          → 完全放行，相信客户端的 model 字段（紧急/高质量场景再开）
// 默认 false。这能彻底防止 Chrome 插件意外或刻意传 "gpt-4o" 导致单价瞬间放大 16.7 倍。
const ALLOW_PREMIUM_MODELS = String(
  process.env.SEMA_ALLOW_PREMIUM_MODELS || process.env.GWELL_ALLOW_PREMIUM_MODELS || ""
).toLowerCase() === "true";
const FALLBACK_MODEL = "gpt-4o-mini";

// 公认便宜的 mini 系列（前缀匹配）
const ALLOWED_MINI_PREFIXES = [
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4_1-mini" // OpenAI dashboard 见过的别名形式
];

// 公认昂贵的 premium 系列（前缀匹配）—— 命中即降级（除非 ALLOW_PREMIUM_MODELS=true）
const PREMIUM_PREFIXES = [
  "gpt-4o-2024",
  "gpt-4o-2025",
  "gpt-4o-realtime",
  "gpt-4o-audio",
  "gpt-4o-search",
  "gpt-4.1-2025",
  "gpt-4-turbo",
  "gpt-4-",
  "chatgpt-4o-latest",
  "o1",
  "o3"
];

function isMiniModel(m) {
  const s = String(m || "").toLowerCase();
  return ALLOWED_MINI_PREFIXES.some((p) => s === p || s.startsWith(p + "-") || s.startsWith(p));
}

function isPremiumModel(m) {
  const s = String(m || "").toLowerCase();
  if (isMiniModel(s)) return false; // mini 系列优先
  return s === "gpt-4o" || s === "gpt-4.1" || s === "gpt-4" || PREMIUM_PREFIXES.some((p) => s.startsWith(p));
}

function enforceModelPolicy(requested, route) {
  const m = String(requested || "").trim();
  if (!m) return FALLBACK_MODEL;
  if (isMiniModel(m)) return m;
  if (isPremiumModel(m)) {
    if (ALLOW_PREMIUM_MODELS) {
      console.log(`[sema-backend] [${route}] PREMIUM model "${m}" allowed by SEMA_ALLOW_PREMIUM_MODELS=true`);
      return m;
    }
    console.warn(`[sema-backend] [${route}] BLOCKED premium model "${m}" → forced to "${FALLBACK_MODEL}" (set SEMA_ALLOW_PREMIUM_MODELS=true to permit)`);
    return FALLBACK_MODEL;
  }
  console.warn(`[sema-backend] [${route}] UNKNOWN model "${m}" → forced to "${FALLBACK_MODEL}"`);
  return FALLBACK_MODEL;
}

console.log(`[sema-backend] premium model policy: ${ALLOW_PREMIUM_MODELS ? "ALLOWED (SEMA_ALLOW_PREMIUM_MODELS=true)" : "BLOCKED → fallback to " + FALLBACK_MODEL}`);

// 历史消息上限（准确率模式加大上下文）
const OUTBOUND_HISTORY_MAX_ITEMS = ACCURACY_PRIORITY ? 5 : 2;
const OUTBOUND_HISTORY_MAX_CHARS = ACCURACY_PRIORITY ? 150 : 80;
const HISTORY_MAX_ITEMS = ACCURACY_PRIORITY ? 5 : 3;
const HISTORY_MAX_CHARS = ACCURACY_PRIORITY ? 150 : 100;

function clampHistory(messages, maxItems = HISTORY_MAX_ITEMS, maxChars = HISTORY_MAX_CHARS) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-maxItems)
    .map((m) => {
      if (typeof m === "string") {
        const t = m.replace(/\s+/g, " ").trim();
        return t.length > maxChars ? t.slice(0, maxChars) + "…" : t;
      }
      const text = String(m?.text || "").replace(/\s+/g, " ").trim();
      const clipped = text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
      return { ...m, text: clipped };
    })
    .filter((m) => (typeof m === "string" ? m.length > 0 : String(m.text || "").length > 0));
}

function logUsage({
  route,
  mode,
  inputChars,
  usage,
  model,
  withProducts = false,
  withHistory = false,
  provider = "openai",
  providerFallback = false,
  targetLanguage = null,
  targetSource = null
}) {
  const pt = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const ct = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const tt = usage?.total_tokens ?? (pt + ct);
  const ratio = ct > 0 ? pt / ct : Infinity;
  const ratioStr = isFinite(ratio) ? ratio.toFixed(2) : "inf";
  const warn = ct > 0 && ratio > 10 ? "  ⚠ WARNING: input tokens too high, check prompt/products/history." : "";
  const tag = provider === "deepseek" ? "DeepSeek Usage" : "OpenAI Usage";
  const fallbackNote = providerFallback ? "  ⚠ provider fallback (primary failed)" : "";
  console.log(
    [
      `[${tag}]${fallbackNote}`,
      `  route: ${route}` + (mode ? `  mode: ${mode}` : ""),
      `  inputChars: ${inputChars}`,
      `  promptTokens: ${pt}`,
      `  completionTokens: ${ct}`,
      `  totalTokens: ${tt}`,
      `  ratio (input:output): ${ratioStr}:1`,
      `  model: ${model}`,
      `  withProducts: ${withProducts}`,
      `  withHistory: ${withHistory}` + (targetLanguage ? `  target: ${targetLanguage} (${targetSource})` : "") + warn
    ].join("\n")
  );
}

// ============================================================
// Products DB（启动时加载一次；仅 /quote 路由使用）
// ============================================================
let PRODUCTS = [];
try {
  const raw = readFileSync(join(__dirname, "products.json"), "utf8");
  PRODUCTS = JSON.parse(raw);
  console.log(`[sema-backend] loaded ${PRODUCTS.length} products from products.json`);
} catch (err) {
  console.warn(`[sema-backend] products.json not loaded (${err.code || err.message}); /quote will degrade to slim translation.`);
}

const BATCH_CONTEXT_MAX_ITEMS = ACCURACY_PRIORITY ? 5 : 3;

// 达累斯萨拉姆区域：口语词库默认开启；完整行业词库需 SEMA_ENABLE_GLOSSARY=true
const ENABLE_GLOSSARY = String(process.env.SEMA_ENABLE_GLOSSARY || "false").toLowerCase() === "true";

function compileGlossaryPatterns(entries) {
  for (const entry of entries) {
    entry._compiled = (Array.isArray(entry.patterns) ? entry.patterns : [])
      .map((pat) => {
        const p = String(pat || "").toLowerCase();
        if (!p) return null;
        if (/[\u4e00-\u9fff]/.test(p)) {
          return { type: "cjk", needle: p };
        }
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return { type: "re", re: new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i") };
      })
      .filter(Boolean);
  }
  return entries;
}

let COLLOQUIAL_GLOSSARY = [];
try {
  const raw = readFileSync(join(__dirname, "colloquial-glossary.json"), "utf8");
  COLLOQUIAL_GLOSSARY = compileGlossaryPatterns(JSON.parse(raw));
  console.log(`[sema-backend] loaded ${COLLOQUIAL_GLOSSARY.length} Dar colloquial glossary entries`);
} catch (err) {
  console.warn(`[sema-backend] colloquial-glossary.json not loaded (${err.code || err.message})`);
}

let GLOSSARY = [...COLLOQUIAL_GLOSSARY];
if (ENABLE_GLOSSARY) {
  try {
    const raw = readFileSync(join(__dirname, "local-glossary.json"), "utf8");
    const industry = compileGlossaryPatterns(JSON.parse(raw));
    GLOSSARY = [...COLLOQUIAL_GLOSSARY, ...industry];
    console.log(`[sema-backend] merged ${industry.length} industry glossary entries (SEMA_ENABLE_GLOSSARY=true)`);
  } catch (err) {
    console.warn(`[sema-backend] local-glossary.json not loaded (${err.code || err.message}); using colloquial only.`);
  }
}

// TOP-N cap：词典命中过多时（一次中文回复可能命中 15+ 条，含 价格/箱/货 这种短而通用的），
// 按"被命中的 pattern 长度"降序保留前 N 条 —— 长 pattern 更具体（"价格表" > "价格"），
// 携带的信息密度更高，模型也更需要它们。N=6 足够覆盖常见业务场景。
const GLOSSARY_MATCH_CAP = ACCURACY_PRIORITY ? 12 : 6;

function findGlossaryMatches(text) {
  if (!GLOSSARY.length || !text) return [];
  const lower = String(text).toLowerCase();
  const scored = [];
  for (const entry of GLOSSARY) {
    const compiled = entry._compiled || [];
    let matchedLen = 0;
    for (const c of compiled) {
      const hit = c.type === "cjk" ? lower.includes(c.needle) : c.re.test(lower);
      if (hit) {
        const l = c.type === "cjk" ? c.needle.length : c.re.source.length;
        if (l > matchedLen) matchedLen = l;
      }
    }
    if (matchedLen > 0) scored.push({ entry, matchedLen });
  }
  scored.sort((a, b) => b.matchedLen - a.matchedLen);
  return scored.slice(0, GLOSSARY_MATCH_CAP).map((s) => s.entry);
}

// 词典块按翻译方向单向化（双向格式 ↔ 会让模型分不清"该输出哪一侧"，
// 实测出现过把 "价格表" "箱数量" 等中文照抄进 Swahili 输出的情况）。
//   direction = "cn-to-foreign" : 中→外（用于 /api/translate），左侧中文，右侧外文
//   direction = "foreign-to-cn" : 外→中（用于 /api/batch-translate-incoming），左侧外文，右侧中文
function buildGlossaryBlock(matches, direction) {
  if (!matches || matches.length === 0) return "";
  const splitSides = (m) => {
    const all = Array.isArray(m.patterns) ? m.patterns : [];
    const cn = all.filter((p) => /[\u4e00-\u9fff]/.test(p));
    const fn = all.filter((p) => !/[\u4e00-\u9fff]/.test(p));
    return { cn, fn };
  };

  if (direction === "cn-to-foreign") {
    const lines = matches.map((m) => {
      const { cn, fn } = splitSides(m);
      const left = (cn[0] || m.zh).trim();
      const right = fn.length ? fn.join(" / ") : (m.en || m.zh);
      const note = m.note ? ` (${m.note})` : "";
      return `- ${left} → ${right}${note}`;
    });
    return `Glossary (中文 → foreign, match target language only):\n${lines.join("\n")}\n\n`;
  }

  const lines = matches.map((m) => {
    const { fn } = splitSides(m);
    const left = fn.length ? fn.join(" / ") : (m.en || m.zh);
    const note = m.note ? ` (${m.note})` : "";
    return `- ${left} → ${m.zh}${note}`;
  });
  return `Glossary (foreign → 中文, use when matched):\n${lines.join("\n")}\n\n`;
}

function searchProducts(text, max = 5) {
  if (!PRODUCTS.length || !text) return [];
  const s = String(text).toLowerCase();
  const tokens = s.split(/[\s,.;:!?\-/()\[\]{}"'`]+/).filter((t) => t.length >= 2);
  const scored = PRODUCTS.map((p) => {
    let score = 0;
    if (p.code && s.includes(String(p.code).toLowerCase())) score += 10;
    if (p.name && s.includes(String(p.name).toLowerCase())) score += 5;
    const kws = Array.isArray(p.keywords) ? p.keywords : [];
    for (const kw of kws) {
      const kwL = String(kw).toLowerCase();
      if (!kwL) continue;
      if (/^[\u4e00-\u9fff]/.test(kwL)) {
        if (s.includes(kwL)) score += 3;
      } else if (tokens.some((t) => t === kwL || t.includes(kwL))) {
        score += 2;
      }
    }
    return { product: p, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.product);
}

// ============================================================
// 本地意图关键词 — 已禁用（通用版不做意图猜测）
// ============================================================
function localIntent() {
  return null;
}

// ============================================================
// 用户名白名单(可选)
// ============================================================
// SEMA_ALLOWED_USERS (兼容 GWELL_ALLOWED_USERS)
const RAW_ALLOWED_USERS = String(
  process.env.SEMA_ALLOWED_USERS || process.env.GWELL_ALLOWED_USERS || ""
).trim();
const ALLOWED_USERS = RAW_ALLOWED_USERS
  ? new Set(RAW_ALLOWED_USERS.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const AUTH_ENABLED = !!ALLOWED_USERS && ALLOWED_USERS.size > 0;

if (AUTH_ENABLED) {
  console.log(`[sema-backend] auth ENABLED, ${ALLOWED_USERS.size} allowed user(s): ${Array.from(ALLOWED_USERS).join(", ")}`);
} else {
  console.log("[sema-backend] auth DISABLED (SEMA_ALLOWED_USERS unset/empty) — all requests allowed.");
}

function getReqUser(req) {
  return String(req.get("x-sema-user") || req.get("x-gwell-user") || "").trim();
}

/** 未传用户名时，在未启用白名单的情况下归入默认用户，便于管理台统计 */
const DEFAULT_USAGE_USER = String(process.env.SEMA_DEFAULT_USER || "_default").trim() || "_default";

function resolveUsageUser(req) {
  const user = getReqUser(req);
  if (user) return user;
  if (!AUTH_ENABLED) return DEFAULT_USAGE_USER;
  return null;
}

function requireUser(req, res, next) {
  const user = getReqUser(req);
  req._user = user || null;

  if (!AUTH_ENABLED) {
    if (user) console.log(`[sema-backend] [${req.method} ${req.path}] user=${user} (auth disabled)`);
    return next();
  }

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: "USERNAME_REQUIRED",
      hint: "请在 SemaTranslate 设置中填写已开通的用户名后重试"
    });
  }
  if (!ALLOWED_USERS.has(user)) {
    return res.status(401).json({
      ok: false,
      error: "USERNAME_NOT_ALLOWED",
      hint: `用户名「${user}」未授权，请联系管理员开通`
    });
  }

  console.log(`[sema-backend] [${req.method} ${req.path}] user=${user} (ok)`);
  next();
}

function requireQuota(req, res, next) {
  const user = req._user;
  if (!user) return next();
  const q = checkUserQuota(user);
  if (!q.ok) {
    return res.status(429).json({
      ok: false,
      error: q.error,
      hint: q.hint,
      usage: q.usage
    });
  }
  next();
}

// ============================================================
// OpenAI Responses API caller (1:1 与旧 background.js 行为一致)
// ============================================================
async function callOpenAIResponses({
  model,
  instructions,
  input,
  jsonSchema,
  temperature = 0.3,
  timeoutMs = 60000,
  maxOutputTokens = null
}) {
  if (!OPENAI_API_KEY) throw new Error("Server missing OPENAI_API_KEY");
  if (!model) throw new Error("Missing model");

  const body = { model, instructions, input, temperature };
  if (typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
    body.max_output_tokens = maxOutputTokens;
  }
  if (jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: jsonSchema.name || "result",
        schema: jsonSchema.schema,
        strict: jsonSchema.strict !== false
      }
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error(`OpenAI timeout (${timeoutMs}ms)`);
    throw new Error("OpenAI network error: " + (err?.message || String(err)));
  }
  clearTimeout(timer);

  if (!res.ok) {
    let raw = "";
    try { raw = await res.text(); } catch {}
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const msg = parsed?.error?.message || raw.slice(0, 300) || res.statusText;
    const e = new Error(`OpenAI ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  let text = data.output_text || "";
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" && typeof c.text === "string") text += c.text;
        }
      }
    }
  }

  return { text: String(text || "").trim(), usage: data.usage || null, raw: data };
}

// ============================================================
// DeepSeek provider —— OpenAI 兼容 Chat Completions，同签名同返回结构
// ============================================================
function extractJsonStringField(text, fieldName) {
  if (!text || typeof text !== "string") return "";
  const re = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
  const m = text.match(re);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1] || "";
  }
}

async function callDeepSeekChat({
  model,
  instructions,
  input,
  jsonSchema,
  temperature = 0.3,
  timeoutMs = 60000,
  maxOutputTokens = null
}) {
  if (!DEEPSEEK_API_KEY) throw new Error("Server missing DEEPSEEK_API_KEY");
  if (!model) throw new Error("Missing model");

  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push({ role: "user", content: input });

  const body = { model, messages, temperature };
  if (typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
    body.max_tokens = maxOutputTokens;
  }
  if (jsonSchema) {
    body.response_format = { type: "json_object" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error(`DeepSeek timeout (${timeoutMs}ms)`);
    throw new Error("DeepSeek network error: " + (err?.message || String(err)));
  }
  clearTimeout(timer);

  if (!res.ok) {
    let raw = "";
    try { raw = await res.text(); } catch {}
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const msg = parsed?.error?.message || raw.slice(0, 300) || res.statusText;
    const e = new Error(`DeepSeek ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  const text = String(choice?.message?.content || "").trim();
  const usage = data.usage
    ? {
        input_tokens: data.usage.prompt_tokens || 0,
        output_tokens: data.usage.completion_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
        prompt_tokens: data.usage.prompt_tokens || 0,
        completion_tokens: data.usage.completion_tokens || 0
      }
    : null;

  if (!text) {
    const e = new Error("DeepSeek empty response");
    e.status = 422;
    throw e;
  }

  return { text, usage, raw: data };
}

// ============================================================
// Provider 路由器 —— 主选 DeepSeek，失败容灾到 OpenAI（或反之）
// ============================================================
function isDeepSeekModel(m) {
  return /^deepseek[-_]/i.test(String(m || ""));
}

function isOpenAIModel(m) {
  const s = String(m || "").toLowerCase();
  return s.startsWith("gpt") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("chatgpt");
}

function resolveProviderModel(requestedModel, route) {
  if (isDeepSeekModel(requestedModel)) {
    return { provider: "deepseek", model: String(requestedModel) };
  }
  if (isOpenAIModel(requestedModel)) {
    return { provider: "openai", model: enforceModelPolicy(requestedModel, route) };
  }

  const outboundOverride = String(
    process.env.SEMA_OUTBOUND_PROVIDER || process.env.GWELL_OUTBOUND_PROVIDER || ""
  ).toLowerCase();
  let routePrimary;
  if (route === "/api/translate") {
    routePrimary = outboundOverride === "openai" ? "openai" : "deepseek";
  } else {
    routePrimary = PRIMARY_PROVIDER;
  }

  if (routePrimary === "deepseek") {
    return { provider: "deepseek", model: DEEPSEEK_DEFAULT_MODEL };
  }
  return { provider: "openai", model: enforceModelPolicy(requestedModel, route) };
}

async function translateOneIncomingLLM(text) {
  const { provider, model } = resolveProviderModel(null, "/api/batch-translate-incoming");
  const { text: raw } = await callTranslateAPI({
    provider,
    model,
    instructions:
      "Translate ONE WhatsApp customer message (Swahili/English/French, Dar es Salaam business chat) " +
      'to Simplified Chinese. Return JSON only: {"translation_cn":"..."}. Never return empty unless input is already Chinese.',
    input: String(text || "").trim(),
    jsonSchema: {
      name: "single_incoming_zh",
      strict: true,
      schema: {
        type: "object",
        properties: { translation_cn: { type: "string" } },
        required: ["translation_cn"],
        additionalProperties: false
      }
    },
    temperature: 0.2,
    maxOutputTokens: 320,
    timeoutMs: 45000
  });
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) {}
  const zh = String(parsed?.translation_cn || extractJsonStringField(raw, "translation_cn") || "").trim();
  return zh;
}

function parseBatchLlmItems(parsed, rawText, llmItems) {
  const collected = [];
  const arrays = [parsed?.items, parsed?.translations, parsed?.results].filter(Array.isArray);
  for (const arr of arrays) {
    for (const t of arr) {
      if (!t || typeof t !== "object") continue;
      const zh = String(t.translation_cn || t.translation || t.zh || "").trim();
      if (t.id != null) collected.push({ id: String(t.id), translation_cn: zh });
      else if (zh) collected.push({ translation_cn: zh });
    }
  }
  if (parsed?.translation_cn && llmItems.length === 1) {
    collected.push({ id: llmItems[0].id, translation_cn: String(parsed.translation_cn).trim() });
  }
  if (!collected.length && llmItems.length === 1) {
    const zh = extractJsonStringField(rawText, "translation_cn");
    if (zh) collected.push({ id: llmItems[0].id, translation_cn: zh });
  }
  return collected;
}

function mapLlmItemsById(llmList, llmItems) {
  const byId = new Map();
  llmList.forEach((t, i) => {
    if (t?.id) byId.set(String(t.id), t);
    else if (llmItems[i]) byId.set(llmItems[i].id, { ...t, id: llmItems[i].id });
  });
  return byId;
}

async function callTranslateAPI({ provider, model, ...rest }) {
  const fallbackProvider = provider === "deepseek" ? "openai" : "deepseek";
  const fallbackHasKey = fallbackProvider === "deepseek" ? !!DEEPSEEK_API_KEY : !!OPENAI_API_KEY;
  const fallbackModel = fallbackProvider === "deepseek" ? DEEPSEEK_DEFAULT_MODEL : FALLBACK_MODEL;

  const callOnce = (p, m) =>
    p === "deepseek"
      ? callDeepSeekChat({ ...rest, model: m })
      : callOpenAIResponses({ ...rest, model: m });

  try {
    const r = await callOnce(provider, model);
    return { ...r, provider, modelUsed: model, providerFallback: false };
  } catch (err) {
    if (!fallbackHasKey) throw err;
    console.warn(
      `[provider-fallback] ${provider}/${model} failed: ${err?.message || err} → retry ${fallbackProvider}/${fallbackModel}`
    );
    const r = await callOnce(fallbackProvider, fallbackModel);
    return {
      ...r,
      provider: fallbackProvider,
      modelUsed: fallbackModel,
      providerFallback: true,
      primaryError: String(err?.message || err)
    };
  }
}

// ============================================================
// 翻译 prompt / schema —— 全部从插件 background.js 搬过来
// ============================================================

// === 12 类销售意图 ===
const INTENT_ENUM = [
  "ask_location",
  "ask_price",
  "ask_stock",
  "ask_product_info",
  "ask_catalog_media",
  "ask_delivery",
  "ask_payment",
  "ask_visit_or_business",
  "after_sales_complaint",
  "customer_interested",
  "customer_not_interested",
  "other"
];

const BATCH_TRANSLATE_SCHEMA = {
  name: "batch_translate_to_zh",
  strict: true,
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            translation_cn: { type: "string" }
          },
          required: ["id", "translation_cn"],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  }
};

// === SLIM 默认 prompt（~180 tokens）===
// 用户决定意图自己分析，prompt 砍掉 12-intent 分类、PRIORITY、confidence 等，
// 只负责把 foreign 翻成中文。
const BATCH_TRANSLATE_INSTRUCTIONS_SLIM = `You are a professional translator for Dar es Salaam (Tanzania) WhatsApp business chat.
Customers write Swahili, English, French, or mixed — often short, informal, with typos and abbreviations.

If CONVERSATION CONTEXT appears: REFERENCE ONLY — do NOT translate it. Use it to resolve:
- Pointing words: hii, nahii, iyo, hizi ("this/these")
- Bare specs: 30W, E27, A60
- Cryptic shorts: Vp, Bei, Ngp, Ngapi

Colloquial (Dar): ngp/ngapi/shingapi=多少钱; vp/vipi=怎么样; nahii/na hii=这个; nafuu=要便宜的; caton/katoni=carton/箱; mpesa=移动支付.

Per item → translation_cn (Simplified Chinese):
- Already Chinese / pure URL / emoji only → ""
- Ok/Sawa/Ndio → "好的"; Asante → "谢谢"; Hi/Habari/Mambo → "你好"
- Short cryptic → MUST use CONTEXT for a complete sentence (never output bare "价" or "怎样")
- Empty context + vague poke (Vp?) → "在吗？" or "怎么样？"

Strict JSON per schema.`;

const BATCH_TRANSLATE_INSTRUCTIONS_EXPERT = `Expert translator: Dar es Salaam WhatsApp import/wholesale chat → Simplified Chinese.

CONVERSATION CONTEXT (if present): recent customer messages, oldest→newest. REFERENCE ONLY — never translate.
Use context to resolve abbreviations, product references, and one-word replies.

Examples with context:
  CTX: ["Mna A60 LED bulb?"]  item: "Ngp"  → "A60 LED 球泡多少钱？"
  CTX: ["Mna taa za solar?"]  item: "Bei"  → "太阳能灯多少钱？"
  CTX: ["nahii","30W"]        item: "Vp"   → "30W 这款怎么样？有货吗？"
  CTX: []                      item: "Vp"   → "在吗？/怎么样？"
  any CTX                     item: "Ok"   → "好的"

Per item rules:
- Chinese/URL/emoji → ""
- Acknowledgments → "好的"; Thanks → "谢谢"/"非常感谢"; Greetings → "你好"
- Never output 1–2 character fragments; always a natural complete Chinese sentence
- Preserve numbers, units, TZS/USD, product codes

Dar slang: ngp/ngapi/shingapi/shiganpi; vp/vipi; mzigo=货物; duka=店铺; TZS/shilingi=坦桑先令.

Strict JSON per schema.`;

// === 中→客户语言 schema ===
// 移除 detectionReason 字段：之前每次响应都会让模型写一段"为什么判定这个语言"的解释，
// 这部分纯属内部诊断信息但增加 ~30-60 output tokens，且会让模型多做无用推理。
const TRANSLATE_SCHEMA = {
  name: "translation_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      detectedLanguage: { type: "string" },
      detectedLanguageConfidence: { type: "string", enum: ["high", "medium", "low"] },
      translation: { type: "string" }
    },
    required: ["detectedLanguage", "detectedLanguageConfidence", "translation"],
    additionalProperties: false
  }
};

// === SLIM 默认 outbound prompt（~280 tokens）===
// 包含 4 个硬规则：身份、保留原样字段、零汉字输出、单语输出 + 词典 advisory。
// 优化痕迹：先前为修 bug 写了 ~684 token 的长版，实测过肿（占整次 input ~50%），
// 现已浓缩到核心约束，占用降低 ~58%。
function buildOutboundInstructionsSlim({ targetLanguage }) {
  return `You are a translator for Dar es Salaam WhatsApp business chat.
Translate ONLY the Chinese text below into ${targetLanguage}. Do not reply to the customer or add sales content.

Rules:
- Faithful 1:1 meaning — do not add or omit information
- 箱 → katoni / carton / ctn (match ${targetLanguage}); keep quantities ("3 箱" keeps 3)
- Preserve numbers, units (W/V/TZS/USD), SKUs, URLs, phone numbers, emojis exactly
- Zero Chinese characters in output; single language only (no Sw+En mix)
- Swahili: natural Dar/Kariakoo tone; English business words (price, MOQ, sample) OK when natural
- French: business French as used by Congo/DRC buyers in Dar

JSON only: {"detectedLanguage":"${targetLanguage}","detectedLanguageConfidence":"high","translation":"..."}`;
}

function buildOutboundInstructionsExpert({ targetLanguage, overrideLanguage, contextHint }) {
  const lang = overrideLanguage || targetLanguage || "English";
  const cust = contextHint || {};
  const hints = [];
  if (cust.phoneLangHint) hints.push(`phone suggests ${cust.phoneLangHint}`);
  if (cust.name) hints.push(`contact: ${cust.name}`);
  const hintLine = hints.length ? `\nHints: ${hints.join("; ")} (tone only, do not mention in translation)` : "";

  return `Expert translator: Dar es Salaam WhatsApp, Chinese → ${lang}.
CONVERSATION CONTEXT (if any) = customer's recent messages — reference only, do NOT translate or answer them.
Translate ONLY the Chinese reply at the end.

Swahili style: katoni/carton for 箱; location/anwani for 地址; mix common English trade terms when natural.
Preserve all numbers, TZS/USD, specs, URLs. No Chinese in output. One language only.${hintLine}

JSON: {"detectedLanguage":"${lang}","detectedLanguageConfidence":"high","translation":"..."}`;
}

function buildOutboundInput({ customerMessages, sourceText }) {
  const clamped = clampHistory(customerMessages, OUTBOUND_HISTORY_MAX_ITEMS, OUTBOUND_HISTORY_MAX_CHARS);
  const lines = [];

  if (clamped.length > 0) {
    lines.push("CONVERSATION CONTEXT (customer messages — reference only, do NOT translate):");
    clamped.forEach((m, i) => {
      lines.push(`${i + 1}. ${typeof m === "string" ? m : String(m?.text || "")}`);
    });
    lines.push("");
  }

  const combined = [
    sourceText,
    ...clamped.map((m) => (typeof m === "string" ? m : String(m?.text || "")))
  ].filter(Boolean).join("\n");
  const glossaryBlock = buildGlossaryBlock(findGlossaryMatches(combined), "cn-to-foreign");
  if (glossaryBlock) lines.push(glossaryBlock);

  lines.push("CHINESE REPLY TO TRANSLATE:");
  lines.push(sourceText);
  return lines.join("\n");
}

// 注：语言检测由前端（Chrome 扩展 content.js）负责。
// 优先级：电话号码前缀（+255 → Swahili / +243 → French / +260 → English）>
//         客户消息关键词（仅无电话时）> 默认 English。
// 结果放在 overrideLanguage / contextHint.phoneLangHint 传给 /api/translate。
//
// 后端二次兜底：phoneHint 优先；无电话时才用 customerMessages 关键词检测。

const OUTBOUND_LANGS = new Set(["Swahili", "English", "French"]);

const FR_DETECT_MARKERS = new Set([
  "tu", "vous", "nous", "ne", "pas", "est", "sont", "avec", "pour", "dans", "sur",
  "bonsoir", "bonjour", "merci", "oui", "non", "attente", "comprends", "comprend",
  "marchandises", "reçu", "recu", "photos", "problème", "probleme", "attendions",
  "rencontrer", "envoyer", "réellement", "reellement", "mon", "ami", "as", "peux",
  "d'accord", "daccord", "reste", "attente"
]);
const SW_DETECT_MARKERS = new Set([
  "habari", "hujambo", "mambo", "jambo", "asante", "ndiyo", "hapana", "sawa", "karibu",
  "pole", "tafadhali", "ninaweza", "naweza", "kuapata", "kupata", "taarifa", "kuhusu",
  "nimepokea", "umepokea", "mzigo", "bei", "picha", "tatizo", "subiri", "nimeelewa", "je"
]);
const EN_DETECT_MARKERS = new Set([
  "the", "and", "you", "your", "have", "received", "goods", "problem", "waiting",
  "understand", "friend", "hello", "thanks", "please", "send", "photos"
]);

function normalizeDetectText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ");
}

function countFrenchAccentsInText(s) {
  const m = String(s || "").match(/[àâäæçéèêëïîôùûüÿœ]/gi);
  return m ? m.length : 0;
}

/** 从 customerMessages 做轻量关键词检测（不喂给 LLM，仅纠正 targetLanguage） */
function detectLangFromCustomerMessages(messages) {
  const texts = (Array.isArray(messages) ? messages : [])
    .map((m) => (typeof m === "string" ? m : (m?.text || "")).trim())
    .filter(Boolean)
    .slice(-5);
  if (!texts.length) return null;

  let fr = 0;
  let sw = 0;
  let en = 0;
  let accentCount = 0;
  for (const raw of texts) {
    accentCount += countFrenchAccentsInText(raw);
    const tokens = normalizeDetectText(raw).split(/\s+/).filter((t) => t.length >= 2);
    for (const t of tokens) {
      if (FR_DETECT_MARKERS.has(t)) fr++;
      if (SW_DETECT_MARKERS.has(t)) sw++;
      if (EN_DETECT_MARKERS.has(t)) en++;
    }
  }

  if (sw >= 1 && sw > fr && sw > en) {
    return { language: "Swahili", source: "customerMessages-sw", confidence: sw >= 2 ? "high" : "medium" };
  }
  if (fr >= 1 && fr >= en && (fr >= 2 || accentCount >= 1)) {
    return { language: "French", source: "customerMessages-fr", confidence: fr >= 2 || accentCount >= 1 ? "high" : "medium" };
  }
  if (accentCount >= 1 && en === 0) {
    return { language: "French", source: "customerMessages-fr-accent", confidence: "high" };
  }
  if (en >= 2 && en > fr && en > sw) {
    return { language: "English", source: "customerMessages-en", confidence: "medium" };
  }
  return null;
}

function resolveOutboundTargetLanguage({ overrideLanguage, phoneHint, customerMessages, languageLock = false }) {
  const ov = overrideLanguage ? String(overrideLanguage).trim() : "";
  const ph = phoneHint ? String(phoneHint).trim() : "";

  // 侧栏手动锁定语言 → 最高优先级
  if (languageLock && ov && OUTBOUND_LANGS.has(ov)) {
    return { targetLanguage: ov, targetSource: "override-lock" };
  }

  // 电话优先
  if (ph && OUTBOUND_LANGS.has(ph)) {
    return { targetLanguage: ph, targetSource: "phoneHint" };
  }

  // 无电话 → 消息关键词
  const msgDetect = detectLangFromCustomerMessages(customerMessages);
  if (msgDetect && OUTBOUND_LANGS.has(msgDetect.language)) {
    return { targetLanguage: msgDetect.language, targetSource: msgDetect.source };
  }

  if (ov && OUTBOUND_LANGS.has(ov)) {
    return { targetLanguage: ov, targetSource: "override" };
  }

  return { targetLanguage: "English", targetSource: "default" };
}

// ============================================================
// Routes
// ============================================================

app.get("/", (req, res) => {
  res.send("Translation backend is running.");
});

const MODEL_CATALOG = {
  deepseek: {
    label: "DeepSeek",
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    models: {
      default: [
        { id: "deepseek-chat", label: "DeepSeek Chat（推荐 · 快 · 便宜）" }
      ],
      upgrade: [
        { id: "deepseek-reasoner", label: "DeepSeek Reasoner（推理更强）" }
      ]
    }
  },
  openai: {
    label: "OpenAI",
    defaultModel: FALLBACK_MODEL,
    models: {
      default: [{ id: "gpt-4o-mini", label: "gpt-4o-mini（备用 · 快 · 成本低）" }],
      upgrade: [{ id: "gpt-4o", label: "gpt-4o（强力 · 升级用）" }]
    }
  }
};

function buildHealthProviderInfo() {
  const primary = PRIMARY_PROVIDER;
  const fallback = primary === "deepseek" ? "openai" : "deepseek";
  const primaryCat = MODEL_CATALOG[primary];
  const fallbackCat = MODEL_CATALOG[fallback];
  return {
    provider: primary,
    providerLabel: primaryCat?.label || primary,
    fallbackProvider: fallback,
    fallbackProviderLabel: fallbackCat?.label || fallback,
    activeProvider: primary,
    activeModel: primaryCat?.defaultModel || null,
    models: primaryCat?.models || { default: [], upgrade: [] },
    fallbackModels: fallbackCat?.models || { default: [], upgrade: [] }
  };
}

app.get("/api/health", (req, res) => {
  const user = getReqUser(req);
  let authorized;
  if (!AUTH_ENABLED) authorized = true;
  else if (!user) authorized = false;
  else authorized = ALLOWED_USERS.has(user);

  const providerInfo = buildHealthProviderInfo();
  const usage = user ? getUserUsage(user) : null;
  const usageStorage = getUsageStorageInfo();

  res.json({
    ok: true,
    hasKey: !!(DEEPSEEK_API_KEY || OPENAI_API_KEY),
    hasDeepSeekKey: !!DEEPSEEK_API_KEY,
    hasOpenAIKey: !!OPENAI_API_KEY,
    primaryProvider: PRIMARY_PROVIDER,
    deepseekModel: DEEPSEEK_DEFAULT_MODEL,
    authEnabled: AUTH_ENABLED,
    allowedCount: AUTH_ENABLED ? ALLOWED_USERS.size : 0,
    yourUser: user || null,
    authorized,
    defaultTranslateMode: DEFAULT_TRANSLATE_MODE,
    allowPremiumModels: ALLOW_PREMIUM_MODELS,
    fallbackModel: FALLBACK_MODEL,
    glossaryEntries: COLLOQUIAL_GLOSSARY.length,
    industryGlossaryEntries: ENABLE_GLOSSARY ? GLOSSARY.length - COLLOQUIAL_GLOSSARY.length : 0,
    region: "Dar es Salaam, Tanzania",
    buildVersion: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
    promptVersion: "sema-translate-v1",
    usage,
    usageStorage,
    ...providerInfo
  });
});

app.get("/api/usage", requireUser, (req, res) => {
  const user = req._user;
  if (!user) {
    return res.status(400).json({ ok: false, error: "USERNAME_REQUIRED" });
  }
  res.json({ ok: true, usage: getUserUsage(user) });
});

function requireAdmin(req, res, next) {
  const adminUsers = String(process.env.SEMA_ADMIN_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const user = req._user;
  if (adminUsers.length > 0 && !adminUsers.includes(user)) {
    const hint = !user
      ? "请在管理页「连接设置」填写与 Railway 变量 SEMA_ADMIN_USERS 一致的管理员用户名"
      : `当前用户「${user}」不在 SEMA_ADMIN_USERS 中`;
    return res.status(403).json({ ok: false, error: "ADMIN_REQUIRED", hint });
  }
  next();
}

app.get("/api/admin/usage", requireUser, requireAdmin, (req, res) => {
  const month = String(req.query.month || "").trim() || undefined;
  const overview = getUsageOverview({ month });
  res.json({
    ok: true,
    month: overview.month,
    overview: {
      userCount: overview.userCount,
      activeUserCount: overview.activeUserCount,
      whitelistedCount: overview.whitelistedCount,
      totalTokens: overview.totalTokens,
      inputTokens: overview.inputTokens,
      outputTokens: overview.outputTokens,
      requests: overview.requests
    },
    users: overview.users,
    availableMonths: listAvailableMonths()
  });
});

function adminUserParam(req) {
  return decodeURIComponent(String(req.params.user || "").trim());
}

app.patch("/api/admin/users/:user/quota", requireUser, requireAdmin, (req, res) => {
  try {
    const user = adminUserParam(req);
    if (!user) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const { quota, unlimited, clearOverride } = req.body || {};

    let info;
    if (clearOverride === true) {
      info = clearUserQuotaOverride(user);
    } else if (unlimited === true) {
      info = setUserQuota(user, { unlimited: true });
    } else if (typeof quota === "number") {
      info = setUserQuota(user, { quota });
    } else {
      return res.status(400).json({ ok: false, error: "INVALID_BODY", hint: "传 quota（数字）、unlimited: true 或 clearOverride: true" });
    }

    res.json({ ok: true, user, quota: info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

app.post("/api/admin/users/:user/quota/adjust", requireUser, requireAdmin, (req, res) => {
  try {
    const user = adminUserParam(req);
    if (!user) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const delta = Number(req.body?.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, error: "INVALID_DELTA", hint: "delta 须为非零数字，正数充值、负数减配" });
    }

    const info = adjustUserQuota(user, delta);
    res.json({ ok: true, user, delta, quota: info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

app.post("/api/admin/users/:user/usage/reset", requireUser, requireAdmin, (req, res) => {
  try {
    const user = adminUserParam(req);
    if (!user) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const month = String(req.body?.month || req.query?.month || "").trim() || undefined;
    const usage = resetUserUsage(user, month);
    res.json({ ok: true, user, month: usage.month, usage });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/admin/users/:user", requireUser, requireAdmin, (req, res) => {
  const user = adminUserParam(req);
  if (!user) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });
  res.json({ ok: true, user, usage: getUserUsage(user), quota: getUserQuotaInfo(user) });
});

// === 主路由 1：outbound 中→客户语言 ===
// 默认 slim prompt（~220 tokens）；可 per-request `mode:"expert"` 或 env GWELL_TRANSLATE_DEFAULT_MODE 回退。
app.post("/api/translate", requireUser, requireQuota, async (req, res) => {
  try {
    const {
      sourceText,
      customerMessages = [],
      overrideLanguage = null,
      contextHint = null,
      languageLock = false,
      model: requestedModel = null,
      mode: reqMode
    } = req.body || {};

    const src = String(sourceText || "").trim();
    if (!src) return res.status(400).json({ ok: false, error: "EMPTY_SOURCE" });

    // === Target language 解析（前端做检测，后端只翻译 + 关键词二次兜底） ===
    const phoneHint = contextHint && contextHint.phoneLangHint
      ? String(contextHint.phoneLangHint).trim()
      : "";
    const { targetLanguage, targetSource } = resolveOutboundTargetLanguage({
      overrideLanguage,
      phoneHint,
      customerMessages,
      languageLock: languageLock === true
    });

    // 不传 model = 走 PRIMARY_PROVIDER 默认（DeepSeek）；
    // 传 "gpt-..." 强制 OpenAI；传 "deepseek-..." 强制 DeepSeek。
    const { provider: chosenProvider, model } = resolveProviderModel(requestedModel, "/api/translate");
    const modelDowngraded = isOpenAIModel(requestedModel) && model !== requestedModel;

    const mode = (String(reqMode || DEFAULT_TRANSLATE_MODE).toLowerCase() === "expert") ? "expert" : "slim";
    const instructions = mode === "expert"
      ? buildOutboundInstructionsExpert({ targetLanguage, contextHint })
      : buildOutboundInstructionsSlim({ targetLanguage });
    // KEY：customerMessages 作为对话上下文供消歧；LLM 只翻译 sourceText，不代客户回复。
    const input = buildOutboundInput({
      customerMessages,
      sourceText: src
    });

    // outbound 默认走 DeepSeek；失败时 callTranslateAPI 自动切 OpenAI。
    const {
      text,
      usage,
      provider: usedProvider,
      modelUsed,
      providerFallback,
      primaryError
    } = await callTranslateAPI({
      provider: chosenProvider,
      model,
      instructions,
      input,
      jsonSchema: TRANSLATE_SCHEMA,
      temperature: ACCURACY_PRIORITY ? 0.2 : 0.3,
      maxOutputTokens: ACCURACY_PRIORITY ? 1500 : 1200
    });

    logUsage({
      route: "/api/translate",
      mode,
      inputChars: instructions.length + input.length,
      usage,
      model: modelUsed,
      provider: usedProvider,
      providerFallback,
      withProducts: false,
      withHistory: Array.isArray(customerMessages) && customerMessages.length > 0,
      targetLanguage,
      targetSource
    });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // JSON 解析失败（通常是 max_output_tokens 截断）。绝对不能把"截断 JSON 串"
      // 当 translation 返回——前端会原样塞进 WhatsApp 输入框。
      // 改为：用正则抢救 translation 字段；抢救不到就返回 ok:false 让前端走错误提示。
      console.warn(
        `[/api/translate] non-JSON output: provider=${usedProvider} model=${modelUsed} ` +
        `outputLen=${(text || "").length} usage=${JSON.stringify(usage || {})} ` +
        `preview=${JSON.stringify((text || "").slice(0, 400))}`
      );
      const recoveredTranslation = extractJsonStringField(text, "translation");
      if (!recoveredTranslation) {
        return res.status(502).json({
          ok: false,
          error: "BAD_JSON_FROM_MODEL: translation truncated or malformed (likely max_output_tokens hit). 请重试一次。",
          provider: usedProvider,
          model: modelUsed,
          usage,
          providerFallback,
          primaryError: providerFallback ? primaryError : undefined
        });
      }
      parsed = {
        detectedLanguage: targetLanguage,
        detectedLanguageConfidence: "low",
        translation: recoveredTranslation
      };
    }

    // 防御：万一模型没按 schema 写 detectedLanguage，强制 override 成前端决定的 target。
    if (!parsed.detectedLanguage) parsed.detectedLanguage = targetLanguage;
    if (!parsed.detectedLanguageConfidence) parsed.detectedLanguageConfidence = "high";

    // 诊断接口（GWELL_TRANSLATE_DEBUG=1 时才启用 _debug 字段；平时关闭防止 prompt 泄露）
    const debugEcho = (process.env.SEMA_TRANSLATE_DEBUG === "1" || process.env.GWELL_TRANSLATE_DEBUG === "1") &&
      (req.query?.debug === "1" || req.body?.__debug === true) ? {
        _debug: {
          promptVersion: "translate-only-v3",
          targetLanguage,
          targetSource,
          instructionsLen: instructions.length,
          inputLen: input.length,
          instructions,
          input,
          rawOutput: text
        }
      } : {};

    const usageUser = resolveUsageUser(req);
    if (usageUser) {
      recordUserUsage(usageUser, {
        route: "/api/translate",
        usage: usage || {},
        provider: usedProvider,
        model: modelUsed
      });
    }

    res.json({
      ok: true,
      ...parsed,
      targetLanguage,
      targetSource,
      messageCount: Array.isArray(customerMessages) ? customerMessages.length : 0,
      usage,
      model: modelUsed,
      provider: usedProvider,
      providerFallback,
      primaryError: providerFallback ? primaryError : undefined,
      mode,
      requestedModel,
      modelDowngraded,
      ...debugEcho
    });
  } catch (err) {
    console.error("[/api/translate]", err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      requestedModel: req.body?.model ?? null
    });
  }
});

// === 主路由 2：批量来信 → 中文（仅翻译；意图分类已移除） ===
// upgradeModel 字段保留向后兼容（前端可能仍在传），但不再触发升级。
app.post("/api/batch-translate-incoming", requireUser, requireQuota, async (req, res) => {
  try {
    const {
      items: rawItems,
      recentContext: rawCtx = [],
      model: requestedModel = null,
      upgradeModel: requestedUpgradeModel = null,
      mode: reqMode
    } = req.body || {};

    const items = Array.isArray(rawItems) ? rawItems.filter(Boolean) : [];
    if (items.length === 0) return res.json({ ok: true, translations: [] });

    // === 本地快路径（默认关闭，避免 Vp/Bei 等歧义句误译）===
    const localById = new Map();
    const llmItems = [];
    for (const it of items) {
      const hit = LOCAL_FAST_ENABLED ? tryLocalIncomingTranslation(it.text) : null;
      if (hit) {
        localById.set(it.id, hit);
      } else {
        llmItems.push(it);
      }
    }

    const fullRecentContext = clampHistory(
      (Array.isArray(rawCtx) ? rawCtx : []).map((s) => String(s || "").replace(/\r?\n/g, " ").trim()).filter(Boolean)
    ).map((m) => (typeof m === "string" ? m : m.text));

    // 准确率模式：有上下文就附上（最多 BATCH_CONTEXT_MAX_ITEMS 条）
    const recentContext = fullRecentContext.length > 0
      ? fullRecentContext.slice(-BATCH_CONTEXT_MAX_ITEMS)
      : [];

    if (localById.size > 0) {
      console.log(`[batch] local-fast: ${localById.size}/${items.length} items (0 tokens)`);
    }

    // 不传 model = 走 PRIMARY_PROVIDER 默认（DeepSeek）；
    // 传 "gpt-..." 强制 OpenAI；传 "deepseek-..." 强制 DeepSeek。
    const { provider: chosenProvider, model } = resolveProviderModel(requestedModel, "/api/batch-translate-incoming");
    const modelDowngraded = isOpenAIModel(requestedModel) && model !== requestedModel;

    const mode = (String(reqMode || DEFAULT_TRANSLATE_MODE).toLowerCase() === "expert") ? "expert" : "slim";
    const batchInstructions = mode === "expert"
      ? BATCH_TRANSLATE_INSTRUCTIONS_EXPERT
      : BATCH_TRANSLATE_INSTRUCTIONS_SLIM;

    let contextBlock = "";
    if (recentContext.length) {
      contextBlock =
        `CONVERSATION CONTEXT (customer messages — reference only, do NOT translate):\n` +
        `${recentContext.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n`;
    }

    const perItemOutput = ACCURACY_PRIORITY ? 280 : 220;
    const maxOutputTokens = Math.min(Math.max(llmItems.length * perItemOutput, 350), 2000);

    async function callBatchOnce({ provider: pv, model: m, items: subItems }) {
      if (!subItems.length) {
        return { items: [], usage: null, provider: pv, modelUsed: m, providerFallback: false, primaryError: null };
      }
      const subLines = subItems.map((it, i) =>
        `--- ITEM ${i + 1} ---\nid: ${it.id}\ntext: ${String(it.text || "").trim()}`
      );
      const glossarySource = [
        ...subItems.map((it) => String(it.text || "")),
        ...recentContext
      ].join("\n");
      const glossaryBlock = buildGlossaryBlock(
        findGlossaryMatches(glossarySource),
        "foreign-to-cn"
      );
      const subInput =
        `${glossaryBlock}${contextBlock}` +
        `Translate EACH item below to Simplified Chinese.\n` +
        `Return JSON only: {"items":[{"id":"<copy id exactly>","translation_cn":"..."}]}\n\n` +
        subLines.join("\n\n");
      const {
        text,
        usage,
        provider: usedProvider,
        modelUsed,
        providerFallback,
        primaryError
      } = await callTranslateAPI({
        provider: pv,
        model: m,
        instructions: batchInstructions,
        input: subInput,
        jsonSchema: BATCH_TRANSLATE_SCHEMA,
        temperature: ACCURACY_PRIORITY ? 0.15 : 0.2,
        timeoutMs: 60000,
        maxOutputTokens: Math.min(Math.max(subItems.length * perItemOutput, 350), 2000)
      });
      logUsage({
        route: "/api/batch-translate-incoming",
        mode,
        inputChars: batchInstructions.length + subInput.length,
        usage,
        model: modelUsed,
        provider: usedProvider,
        providerFallback,
        withProducts: false,
        withHistory: recentContext.length > 0
      });
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        // 关键诊断信息：把模型的原始返回打到 Railway log，方便下次定位
        // （限 800 char 防止日志爆炸；通常截断只在末尾几十字节）
        const preview = (text || "").slice(0, 800);
        console.error(
          `[batch] BAD_JSON_FROM_MODEL: provider=${usedProvider} model=${modelUsed} ` +
          `outputLen=${(text || "").length} ` +
          `maxOutputTokens=${Math.min(Math.max(subItems.length * perItemOutput, 350), 2000)} ` +
          `usage=${JSON.stringify(usage || {})}`
        );
        console.error(`[batch] BAD_JSON_FROM_MODEL preview: ${JSON.stringify(preview)}`);
        throw new Error("BAD_JSON_FROM_MODEL: " + (err?.message || String(err)));
      }
      const llmList = parseBatchLlmItems(parsed, text, subItems);
      if (!llmList.length && (parsed?.items?.length || 0) === 0) {
        console.warn(
          `[batch] empty items from model provider=${usedProvider} model=${modelUsed} ` +
          `preview=${JSON.stringify((text || "").slice(0, 400))}`
        );
      }
      return {
        items: llmList,
        usage,
        provider: usedProvider,
        modelUsed,
        providerFallback,
        primaryError
      };
    }

    const {
      items: llmList,
      usage,
      provider: usedProvider,
      modelUsed,
      providerFallback,
      primaryError
    } = await callBatchOnce({ provider: chosenProvider, model, items: llmItems });

    const llmById = mapLlmItemsById(llmList, llmItems);

    const translations = [];
    for (const it of items) {
      const local = localById.get(it.id);
      if (local) {
        translations.push({
          id: it.id,
          translation_cn: local.translation_cn,
          intent: "other",
          secondary_intents: [],
          confidence: "high",
          translation_source: local.source
        });
        continue;
      }
      const idx = llmItems.indexOf(it);
      const t = llmById.get(it.id) || (idx >= 0 ? llmList[idx] : null);
      let zh = String(t?.translation_cn || "").trim();
      let source = "llm";
      if (!zh) {
        zh = tryIncomingFallbackTranslation(it.text);
        if (zh) source = "local-fallback";
      }
      if (!zh && llmItems.includes(it)) {
        try {
          zh = await translateOneIncomingLLM(it.text);
          if (zh) source = "single-llm";
        } catch (err) {
          console.warn(`[batch] single-llm fallback failed id=${it.id}:`, err?.message || err);
        }
      }
      translations.push({
        id: it.id,
        translation_cn: zh,
        intent: "other",
        secondary_intents: [],
        confidence: zh ? (source === "llm" ? "medium" : "high") : "low",
        translation_source: source
      });
    }

    const usageUser = resolveUsageUser(req);
    if (usageUser) {
      recordUserUsage(usageUser, {
        route: "/api/batch-translate-incoming",
        usage: usage || {},
        provider: usedProvider,
        model: modelUsed
      });
    }

    res.json({
      ok: true,
      translations,
      localFastCount: localById.size,
      llmCount: llmItems.length,
      usage,
      upgradeUsage: null,
      upgradedIds: [],
      model: modelUsed,
      upgradeModel: null,
      provider: usedProvider,
      providerFallback,
      primaryError: providerFallback ? primaryError : undefined,
      mode,
      requestedModel,
      requestedUpgradeModel,
      modelDowngraded
    });
  } catch (err) {
    console.error("[/api/batch-translate-incoming]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// === Legacy 简单翻译，保留向后兼容 ===
app.post("/translate", requireUser, async (req, res) => {
  try {
    const { text, targetLanguage } = req.body || {};
    if (!text) return res.status(400).json({ error: "Missing text" });

    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Server missing OPENAI_API_KEY" });

    const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content: `你是达累斯萨拉姆 WhatsApp 商务聊天翻译助手。
客户常用斯瓦希里语、英语、法语或混合书写。
规则：
1. 中文输入 → 译成目标语言；外文输入 → 译成中文。
2. 保留数字、TZS/USD、单位、链接。
3. 自然口语，不要逐字死翻。
4. 只输出译文，不要解释。`
          },
          {
            role: "user",
            content: `目标语言：${targetLanguage || "中文"}\n需要翻译的内容：\n${text}`
          }
        ]
      })
    });

    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `OpenAI ${r.status}: ${bodyText.slice(0, 300)}` });
    }
    const data = await r.json();
    logUsage({
      route: "/translate",
      mode: "legacy",
      inputChars: String(text).length,
      usage: data?.usage,
      model: "gpt-4.1-mini",
      withProducts: false,
      withHistory: false
    });
    res.json({ translation: data?.choices?.[0]?.message?.content || "" });
  } catch (error) {
    console.error("[/translate]", error);
    res.status(500).json({ error: "Translation failed" });
  }
});

// === 意图识别 — 已禁用 ===
app.post("/intent", requireUser, async (req, res) => {
  res.json({ ok: true, intent: "other", confidence: "low", source: "disabled", usedAI: false });
});

// === 报价/产品（legacy；SemaTranslate 前端未使用）===
// 仅这个路由允许把产品资料注入 prompt。即使本地搜索失败，也只回退到无产品的 slim 翻译，绝不发送整个产品库。
app.post("/quote", requireUser, async (req, res) => {
  try {
    const {
      text,
      targetLanguage = null,
      customerMessages = [],
      model: requestedModel = FALLBACK_MODEL
    } = req.body || {};

    const t = String(text || "").trim();
    if (!t) return res.status(400).json({ ok: false, error: "EMPTY_TEXT" });

    const model = enforceModelPolicy(requestedModel, "/quote");
    const modelDowngraded = model !== requestedModel;

    const matches = searchProducts(t, 5);
    const history = clampHistory(customerMessages);

    let productBlock = "";
    if (matches.length > 0) {
      productBlock =
`## Matched products (max 5)
${matches.map((p, i) => `${i + 1}. ${p.code} — ${p.name}\n   specs: ${p.specs}\n   packing: ${p.packing}`).join("\n")}

`;
    }

    let historyBlock = "";
    if (history.length > 0) {
      historyBlock =
`## Recent customer messages (oldest → newest, ref only)
${history.map((m, i) => `${i + 1}. ${typeof m === "string" ? m : m.text}`).join("\n")}

`;
    }

    const detect = targetLanguage
      ? `Target language is forced to "${targetLanguage}" (confidence=high, reason="manual override").`
      : `Detect customer's primary language from their messages (Swahili / English / French / mixed). If unclear/empty → English.`;

    const instructions = `You are a WhatsApp sales assistant for wholesale/import businesses in Dar es Salaam, Tanzania.

The customer is asking about price / stock / product info. Use ONLY the matched products listed in the input — do NOT invent codes or specs. If no matched products are listed, answer in a generic helpful way and ask for clarification (model, watts, qty).

TASKS
1. ${detect}
2. Compose a concise WhatsApp reply in that language quoting the matched product(s) (code, key spec, packing). For Swahili buyers, mixing English business words (price, MOQ, carton, USD) is preferred.
3. Preserve numbers, units (W, V, K, mAh, USD, TZS, %), product codes, URLs, phone numbers exactly.
4. Output the reply text only — no quotes, no "Reply:" prefix, no markdown, no JSON.`;

    const input = `${historyBlock}${productBlock}## Customer question
${t}`;

    if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "Server missing OPENAI_API_KEY" });

    const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 700,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: input }
        ]
      })
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      return res.status(r.status).json({ ok: false, error: `OpenAI ${r.status}: ${bodyText.slice(0, 200)}` });
    }
    const data = await r.json();
    logUsage({
      route: "/quote",
      mode: "default",
      inputChars: instructions.length + input.length,
      usage: data?.usage,
      model,
      withProducts: matches.length > 0,
      withHistory: history.length > 0
    });

    res.json({
      ok: true,
      reply: data?.choices?.[0]?.message?.content || "",
      matchedProducts: matches.map((p) => ({ code: p.code, name: p.name })),
      usage: data?.usage,
      model,
      requestedModel,
      modelDowngraded
    });
  } catch (err) {
    console.error("[/quote]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

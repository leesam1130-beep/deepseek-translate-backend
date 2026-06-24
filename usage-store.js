/**
 * Per-user token usage tracking (file-backed, ready for DB migration).
 *
 * Env:
 *   SEMA_USER_QUOTAS  JSON map or "user1:100000,user2:50000" (monthly token limit; 0 = unlimited)
 *   SEMA_USAGE_DIR    directory for usage.json (default: ./data)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USAGE_DIR = process.env.SEMA_USAGE_DIR || join(__dirname, "data");
const USAGE_FILE = join(USAGE_DIR, "usage.json");

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseQuotas() {
  const raw = String(process.env.SEMA_USER_QUOTAS || process.env.GWELL_USER_QUOTAS || "").trim();
  if (!raw) return new Map();
  try {
    if (raw.startsWith("{")) {
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj).map(([k, v]) => [k, Number(v) || 0]));
    }
  } catch {
    /* fall through to comma format */
  }
  const map = new Map();
  for (const part of raw.split(",")) {
    const [user, limit] = part.split(":").map((s) => s.trim());
    if (user) map.set(user, Number(limit) || 0);
  }
  return map;
}

const USER_QUOTAS = parseQuotas();

function loadStore() {
  try {
    if (!existsSync(USAGE_FILE)) return { months: {} };
    return JSON.parse(readFileSync(USAGE_FILE, "utf8"));
  } catch {
    return { months: {} };
  }
}

function saveStore(store) {
  if (!existsSync(USAGE_DIR)) mkdirSync(USAGE_DIR, { recursive: true });
  writeFileSync(USAGE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function emptyUserStats() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    byRoute: {}
  };
}

export function getUserQuota(user) {
  if (!user) return 0;
  return USER_QUOTAS.get(user) ?? 0;
}

export function getUserUsage(user) {
  const month = currentMonthKey();
  const store = loadStore();
  const monthData = store.months?.[month] || {};
  const stats = monthData[user] || emptyUserStats();
  const quota = getUserQuota(user);
  return {
    user,
    month,
    ...stats,
    quota: quota || null,
    remaining: quota > 0 ? Math.max(0, quota - stats.totalTokens) : null,
    quotaExceeded: quota > 0 && stats.totalTokens >= quota
  };
}

export function recordUserUsage(user, { route, usage, provider, model }) {
  if (!user) return;
  const pt = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const ct = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const tt = usage?.total_tokens ?? pt + ct;
  if (tt <= 0) return;

  const month = currentMonthKey();
  const store = loadStore();
  if (!store.months) store.months = {};
  if (!store.months[month]) store.months[month] = {};
  if (!store.months[month][user]) store.months[month][user] = emptyUserStats();

  const u = store.months[month][user];
  u.totalTokens += tt;
  u.inputTokens += pt;
  u.outputTokens += ct;
  u.requests += 1;
  if (!u.byRoute[route]) {
    u.byRoute[route] = { requests: 0, totalTokens: 0 };
  }
  u.byRoute[route].requests += 1;
  u.byRoute[route].totalTokens += tt;
  u.lastProvider = provider;
  u.lastModel = model;
  u.updatedAt = new Date().toISOString();

  saveStore(store);
}

export function checkUserQuota(user) {
  const quota = getUserQuota(user);
  if (!quota || quota <= 0) return { ok: true };
  const usage = getUserUsage(user);
  if (usage.totalTokens >= quota) {
    return {
      ok: false,
      error: "QUOTA_EXCEEDED",
      hint: `本月用量已达上限（${quota.toLocaleString()} tokens），请联系管理员扩容`,
      usage
    };
  }
  return { ok: true, usage };
}

export function listAllUsage({ month = currentMonthKey() } = {}) {
  const store = loadStore();
  const monthData = store.months?.[month] || {};
  return Object.entries(monthData).map(([user, stats]) => ({
    user,
    month,
    ...stats,
    quota: getUserQuota(user) || null
  }));
}

if (USER_QUOTAS.size > 0) {
  console.log(`[sema-backend] user quotas enabled for ${USER_QUOTAS.size} user(s)`);
}

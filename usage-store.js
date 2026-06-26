/**
 * Per-user token usage + quota tracking (file-backed, ready for DB migration).
 *
 * Env:
 *   SEMA_USER_QUOTAS     JSON map or "user1:100000,user2:50000" (fallback quota; 0 = unlimited)
 *   SEMA_ALLOWED_USERS   comma list — shown in admin even with zero usage
 *   SEMA_USAGE_DIR       directory for usage.json / quotas.json (default: ./data)
 *
 * Quota priority: quotas.json (admin panel) > SEMA_USER_QUOTAS (env)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { computeCostFromUsage, computeUsageCost } from "./pricing.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveUsageDir() {
  const explicit = String(process.env.SEMA_USAGE_DIR || "").trim();
  if (explicit) return explicit;
  const railwayMount = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  if (railwayMount) return railwayMount;
  return join(__dirname, "data");
}

const USAGE_DIR = resolveUsageDir();
const USAGE_FILE = join(USAGE_DIR, "usage.json");
const QUOTAS_FILE = join(USAGE_DIR, "quotas.json");

export function getUsageStorageInfo() {
  return {
    dir: USAGE_DIR,
    file: USAGE_FILE,
    quotasFile: QUOTAS_FILE,
    persistent: !!process.env.RAILWAY_VOLUME_MOUNT_PATH || !!process.env.SEMA_USAGE_DIR,
    volumeMounted: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
    volumeName: process.env.RAILWAY_VOLUME_NAME || null
  };
}

function ensureDir() {
  if (!existsSync(USAGE_DIR)) mkdirSync(USAGE_DIR, { recursive: true });
}

function currentMonthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentDayKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function monthFromDay(day) {
  return String(day || "").slice(0, 7);
}

function parseEnvQuotas() {
  const raw = String(process.env.SEMA_USER_QUOTAS || process.env.GWELL_USER_QUOTAS || "").trim();
  if (!raw) return new Map();
  try {
    if (raw.startsWith("{")) {
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj).map(([k, v]) => [k, Number(v) || 0]));
    }
  } catch {
    /* fall through */
  }
  const map = new Map();
  for (const part of raw.split(",")) {
    const [user, limit] = part.split(":").map((s) => s.trim());
    if (user) map.set(user, Number(limit) || 0);
  }
  return map;
}

function parseAllowedUsers() {
  const raw = String(process.env.SEMA_ALLOWED_USERS || process.env.GWELL_ALLOWED_USERS || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const ENV_QUOTAS = parseEnvQuotas();
const ALLOWED_USERS = parseAllowedUsers();

function loadStore() {
  try {
    if (!existsSync(USAGE_FILE)) return { months: {}, days: {} };
    const store = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
    if (!store.days) store.days = {};
    if (!store.months) store.months = {};
    return store;
  } catch {
    return { months: {}, days: {} };
  }
}

function saveStore(store) {
  ensureDir();
  writeFileSync(USAGE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function loadQuotaStore() {
  try {
    if (!existsSync(QUOTAS_FILE)) return { users: {} };
    return JSON.parse(readFileSync(QUOTAS_FILE, "utf8"));
  } catch {
    return { users: {} };
  }
}

function saveQuotaStore(store) {
  ensureDir();
  writeFileSync(QUOTAS_FILE, JSON.stringify(store, null, 2), "utf8");
}

function emptyUserStats() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputCacheHitTokens: 0,
    inputCacheMissTokens: 0,
    costCny: 0,
    requests: 0,
    byRoute: {}
  };
}

function resolveRowCost(stats) {
  if (typeof stats.costCny === "number" && stats.costCny > 0) return stats.costCny;
  const hit = stats.inputCacheHitTokens || 0;
  const miss = stats.inputCacheMissTokens ?? (stats.inputTokens || 0);
  return computeUsageCost({
    inputCacheHitTokens: hit,
    inputCacheMissTokens: miss,
    outputTokens: stats.outputTokens || 0,
    provider: stats.lastProvider || "deepseek"
  });
}

/** Panel override > env > unlimited */
export function getUserQuotaInfo(user) {
  if (!user) {
    return { effectiveQuota: 0, unlimited: true, source: "none", panelQuota: null };
  }

  const panel = loadQuotaStore().users?.[user];
  if (panel) {
    if (panel.unlimited) {
      return { effectiveQuota: 0, unlimited: true, source: "panel", panelQuota: null };
    }
    if (typeof panel.quota === "number" && panel.quota > 0) {
      return { effectiveQuota: panel.quota, unlimited: false, source: "panel", panelQuota: panel.quota };
    }
  }

  const envQ = ENV_QUOTAS.get(user) ?? 0;
  if (envQ > 0) {
    return { effectiveQuota: envQ, unlimited: false, source: "env", panelQuota: null };
  }

  return { effectiveQuota: 0, unlimited: true, source: "none", panelQuota: null };
}

export function getUserQuota(user) {
  const info = getUserQuotaInfo(user);
  return info.unlimited ? 0 : info.effectiveQuota;
}

function enrichUserRow(user, stats, { month, day = null } = {}) {
  const quotaInfo = getUserQuotaInfo(user);
  const monthKey = day ? monthFromDay(day) : month;
  const store = loadStore();
  const monthlyStats = store.months?.[monthKey]?.[user] || emptyUserStats();
  const totalTokensForQuota = monthlyStats.totalTokens || 0;
  const quota = quotaInfo.unlimited ? null : quotaInfo.effectiveQuota;
  return {
    user,
    month: monthKey,
    day,
    ...stats,
    costCny: resolveRowCost(stats),
    quota,
    unlimited: quotaInfo.unlimited,
    quotaSource: quotaInfo.source,
    remaining: quota != null && quota > 0 ? Math.max(0, quota - totalTokensForQuota) : null,
    quotaExceeded: quota != null && quota > 0 && totalTokensForQuota >= quota,
    whitelisted: ALLOWED_USERS.includes(user)
  };
}

export function getUserUsage(user) {
  const month = currentMonthKey();
  const store = loadStore();
  const monthData = store.months?.[month] || {};
  const stats = monthData[user] || emptyUserStats();
  return enrichUserRow(user, stats, { month });
}

function applyUsageToBucket(bucket, { route, inputTokens, outputTokens, inputCacheHitTokens, inputCacheMissTokens, totalTokens, costCny, provider, model }) {
  bucket.requests += 1;
  if (!bucket.byRoute[route]) {
    bucket.byRoute[route] = { requests: 0, totalTokens: 0, costCny: 0 };
  }
  bucket.byRoute[route].requests += 1;

  if (totalTokens > 0 || costCny > 0) {
    bucket.totalTokens += totalTokens;
    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.inputCacheHitTokens = (bucket.inputCacheHitTokens || 0) + inputCacheHitTokens;
    bucket.inputCacheMissTokens = (bucket.inputCacheMissTokens || 0) + inputCacheMissTokens;
    bucket.costCny = (bucket.costCny || 0) + costCny;
    bucket.byRoute[route].totalTokens += totalTokens;
    bucket.byRoute[route].costCny = (bucket.byRoute[route].costCny || 0) + costCny;
  }
  if (provider) bucket.lastProvider = provider;
  if (model) bucket.lastModel = model;
  bucket.updatedAt = new Date().toISOString();
}

export function recordUserUsage(user, { route, usage, provider, model }) {
  if (!user) return;
  const billed = computeCostFromUsage(usage || {}, provider || "deepseek");
  const payload = { route, provider, model, ...billed };

  const now = new Date();
  const month = currentMonthKey(now);
  const day = currentDayKey(now);
  const store = loadStore();
  if (!store.months) store.months = {};
  if (!store.days) store.days = {};
  if (!store.months[month]) store.months[month] = {};
  if (!store.days[day]) store.days[day] = {};
  if (!store.months[month][user]) store.months[month][user] = emptyUserStats();
  if (!store.days[day][user]) store.days[day][user] = emptyUserStats();

  applyUsageToBucket(store.months[month][user], payload);
  applyUsageToBucket(store.days[day][user], payload);

  saveStore(store);
}

export function checkUserQuota(user) {
  const info = getUserQuotaInfo(user);
  if (info.unlimited) return { ok: true };
  const usage = getUserUsage(user);
  if (usage.totalTokens >= info.effectiveQuota) {
    return {
      ok: false,
      error: "QUOTA_EXCEEDED",
      hint: `本月用量已达上限（${info.effectiveQuota.toLocaleString()} tokens），请联系管理员扩容`,
      usage
    };
  }
  return { ok: true, usage };
}

function listKnownUsers({ month, day } = {}) {
  const names = new Set();
  for (const u of ALLOWED_USERS) names.add(u);
  const store = loadStore();
  const qStore = loadQuotaStore();
  for (const u of Object.keys(qStore.users || {})) names.add(u);

  if (day) {
    for (const u of Object.keys(store.days?.[day] || {})) names.add(u);
  } else {
    const m = month || currentMonthKey();
    for (const u of Object.keys(store.months?.[m] || {})) names.add(u);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function listAllUsage({ month, day } = {}) {
  const store = loadStore();

  if (day) {
    const dayData = store.days?.[day] || {};
    return listKnownUsers({ day }).map((user) =>
      enrichUserRow(user, dayData[user] || emptyUserStats(), { month: monthFromDay(day), day })
    );
  }

  const m = month || currentMonthKey();
  const monthData = store.months?.[m] || {};
  return listKnownUsers({ month: m }).map((user) =>
    enrichUserRow(user, monthData[user] || emptyUserStats(), { month: m })
  );
}

function aggregateOverview(users, meta) {
  const totals = users.reduce(
    (acc, u) => {
      acc.totalTokens += u.totalTokens || 0;
      acc.inputTokens += u.inputTokens || 0;
      acc.outputTokens += u.outputTokens || 0;
      acc.inputCacheHitTokens += u.inputCacheHitTokens || 0;
      acc.inputCacheMissTokens += u.inputCacheMissTokens || 0;
      acc.requests += u.requests || 0;
      acc.costCny += u.costCny || 0;
      return acc;
    },
    {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputCacheHitTokens: 0,
      inputCacheMissTokens: 0,
      requests: 0,
      costCny: 0
    }
  );
  totals.costCny = Math.round(totals.costCny * 1_000_000) / 1_000_000;
  return {
    ...meta,
    userCount: users.length,
    activeUserCount: users.filter((u) => (u.requests || 0) > 0).length,
    whitelistedCount: ALLOWED_USERS.length,
    ...totals,
    users: users.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0))
  };
}

export function getUsageOverview({ month, day } = {}) {
  if (day) {
    const users = listAllUsage({ day });
    return aggregateOverview(users, {
      period: "day",
      day,
      month: monthFromDay(day)
    });
  }

  const m = month || currentMonthKey();
  const users = listAllUsage({ month: m });
  return aggregateOverview(users, {
    period: "month",
    month: m,
    day: null
  });
}

export function listAvailableMonths() {
  const store = loadStore();
  return Object.keys(store.months || {}).sort().reverse();
}

export function listAvailableDays() {
  const store = loadStore();
  return Object.keys(store.days || {}).sort().reverse();
}

export function setUserQuota(user, { quota, unlimited } = {}) {
  if (!user) throw new Error("USER_REQUIRED");

  const store = loadQuotaStore();
  if (!store.users) store.users = {};

  if (unlimited === true) {
    store.users[user] = {
      unlimited: true,
      quota: null,
      updatedAt: new Date().toISOString(),
      source: "panel"
    };
  } else if (typeof quota === "number" && quota > 0) {
    store.users[user] = {
      unlimited: false,
      quota: Math.floor(quota),
      updatedAt: new Date().toISOString(),
      source: "panel"
    };
  } else {
    throw new Error("INVALID_QUOTA");
  }

  saveQuotaStore(store);
  return getUserQuotaInfo(user);
}

export function adjustUserQuota(user, delta) {
  if (!user) throw new Error("USER_REQUIRED");
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) throw new Error("INVALID_DELTA");

  const info = getUserQuotaInfo(user);
  const base = info.unlimited ? 0 : info.effectiveQuota;
  const newQuota = Math.max(1, Math.floor(base + d));
  setUserQuota(user, { quota: newQuota });
  return getUserQuotaInfo(user);
}

export function resetUserUsage(user, { month, day } = {}) {
  if (!user) throw new Error("USER_REQUIRED");
  const store = loadStore();

  if (day) {
    if (store.days?.[day]?.[user]) {
      delete store.days[day][user];
      saveStore(store);
    }
    return enrichUserRow(user, emptyUserStats(), { month: monthFromDay(day), day });
  }

  const m = month || currentMonthKey();
  if (store.months?.[m]?.[user]) {
    delete store.months[m][user];
    saveStore(store);
  }
  return getUserUsage(user);
}

export function clearUserQuotaOverride(user) {
  if (!user) throw new Error("USER_REQUIRED");
  const store = loadQuotaStore();
  if (store.users?.[user]) {
    delete store.users[user];
    saveQuotaStore(store);
  }
  return getUserQuotaInfo(user);
}

if (ENV_QUOTAS.size > 0) {
  console.log(`[sema-backend] env quotas for ${ENV_QUOTAS.size} user(s)`);
}
if (ALLOWED_USERS.length > 0) {
  console.log(`[sema-backend] whitelist: ${ALLOWED_USERS.length} user(s)`);
}

const storage = getUsageStorageInfo();
console.log(
  `[sema-backend] usage storage: ${storage.dir}` +
    (storage.volumeMounted ? ` (Railway volume: ${storage.volumeName || "attached"})` : " (local/ephemeral — attach a Railway volume at /app/data for persistence)")
);

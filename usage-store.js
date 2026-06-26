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

function resolveUsageDir() {
  const explicit = String(process.env.SEMA_USAGE_DIR || "").trim();
  if (explicit) return explicit;
  const railwayMount = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  if (railwayMount) return railwayMount;
  return join(__dirname, "data");
}

const USAGE_DIR = resolveUsageDir();
const USAGE_FILE = join(USAGE_DIR, "usage.json");

export function getUsageStorageInfo() {
  return {
    dir: USAGE_DIR,
    file: USAGE_FILE,
    persistent: !!process.env.RAILWAY_VOLUME_MOUNT_PATH || !!process.env.SEMA_USAGE_DIR,
    volumeMounted: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
    volumeName: process.env.RAILWAY_VOLUME_NAME || null
  };
}

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

  const month = currentMonthKey();
  const store = loadStore();
  if (!store.months) store.months = {};
  if (!store.months[month]) store.months[month] = {};
  if (!store.months[month][user]) store.months[month][user] = emptyUserStats();

  const u = store.months[month][user];
  u.requests += 1;
  if (!u.byRoute[route]) {
    u.byRoute[route] = { requests: 0, totalTokens: 0 };
  }
  u.byRoute[route].requests += 1;

  if (tt > 0) {
    u.totalTokens += tt;
    u.inputTokens += pt;
    u.outputTokens += ct;
    u.byRoute[route].totalTokens += tt;
  }
  if (provider) u.lastProvider = provider;
  if (model) u.lastModel = model;
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
  return Object.entries(monthData).map(([user, stats]) => {
    const quota = getUserQuota(user);
    return {
      user,
      month,
      ...stats,
      quota: quota || null,
      remaining: quota > 0 ? Math.max(0, quota - stats.totalTokens) : null,
      quotaExceeded: quota > 0 && stats.totalTokens >= quota
    };
  });
}

export function getUsageOverview({ month = currentMonthKey() } = {}) {
  const users = listAllUsage({ month });
  const totals = users.reduce(
    (acc, u) => {
      acc.totalTokens += u.totalTokens || 0;
      acc.inputTokens += u.inputTokens || 0;
      acc.outputTokens += u.outputTokens || 0;
      acc.requests += u.requests || 0;
      return acc;
    },
    { totalTokens: 0, inputTokens: 0, outputTokens: 0, requests: 0 }
  );
  return {
    month,
    userCount: users.length,
    activeUserCount: users.filter((u) => (u.requests || 0) > 0).length,
    ...totals,
    users: users.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0))
  };
}

export function listAvailableMonths() {
  const store = loadStore();
  return Object.keys(store.months || {}).sort().reverse();
}

if (USER_QUOTAS.size > 0) {
  console.log(`[sema-backend] user quotas enabled for ${USER_QUOTAS.size} user(s)`);
}

const storage = getUsageStorageInfo();
console.log(
  `[sema-backend] usage storage: ${storage.dir}` +
    (storage.volumeMounted ? ` (Railway volume: ${storage.volumeName || "attached"})` : " (local/ephemeral — attach a Railway volume at /app/data for persistence)")
);

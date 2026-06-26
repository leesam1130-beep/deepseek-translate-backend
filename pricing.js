/**
 * Token → 费用（CNY）。默认 DeepSeek-V4-Flash 官方价（元/百万 tokens）：
 *   输入（缓存命中）0.02 | 输入（缓存未命中）1 | 输出 2
 *
 * Env 覆盖（元/百万 tokens）：
 *   SEMA_PRICE_INPUT_HIT / SEMA_PRICE_INPUT_MISS / SEMA_PRICE_OUTPUT
 *   SEMA_OPENAI_PRICE_INPUT / SEMA_OPENAI_PRICE_OUTPUT  — OpenAI 容灾备用
 */

const M = 1_000_000;

function numEnv(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export const PRICING_META = {
  currency: "CNY",
  symbol: "¥",
  modelLabel: "DeepSeek-V4-Flash",
  deepseek: {
    inputHitPerM: numEnv("SEMA_PRICE_INPUT_HIT", 0.02),
    inputMissPerM: numEnv("SEMA_PRICE_INPUT_MISS", 1),
    outputPerM: numEnv("SEMA_PRICE_OUTPUT", 2)
  },
  openai: {
    inputPerM: numEnv("SEMA_OPENAI_PRICE_INPUT", 1.075),
    outputPerM: numEnv("SEMA_OPENAI_PRICE_OUTPUT", 4.3)
  }
};

export function normalizeUsageTokens(usage) {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  let hit = Number(usage?.prompt_cache_hit_tokens ?? usage?.input_cache_hit_tokens ?? 0) || 0;
  let miss = Number(usage?.prompt_cache_miss_tokens ?? usage?.input_cache_miss_tokens ?? 0) || 0;

  if (inputTokens > 0 && hit + miss === 0) {
    miss = inputTokens;
  } else if (hit + miss > inputTokens && inputTokens > 0) {
    const ratio = inputTokens / (hit + miss);
    hit = Math.floor(hit * ratio);
    miss = inputTokens - hit;
  }

  return {
    inputTokens,
    outputTokens,
    inputCacheHitTokens: hit,
    inputCacheMissTokens: miss,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens
  };
}

export function computeUsageCost({ inputCacheHitTokens = 0, inputCacheMissTokens = 0, outputTokens = 0, provider = "deepseek" } = {}) {
  const p = String(provider || "deepseek").toLowerCase();
  let cost = 0;

  if (p === "openai") {
    const inT = inputCacheHitTokens + inputCacheMissTokens;
    cost =
      (inT / M) * PRICING_META.openai.inputPerM +
      (outputTokens / M) * PRICING_META.openai.outputPerM;
  } else {
    cost =
      (inputCacheHitTokens / M) * PRICING_META.deepseek.inputHitPerM +
      (inputCacheMissTokens / M) * PRICING_META.deepseek.inputMissPerM +
      (outputTokens / M) * PRICING_META.deepseek.outputPerM;
  }

  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function computeCostFromUsage(usage, provider = "deepseek") {
  const t = normalizeUsageTokens(usage);
  const costCny = computeUsageCost({ ...t, provider });
  return { ...t, costCny };
}

export function sumCosts(rows) {
  return rows.reduce((acc, r) => acc + (r.costCny || 0), 0);
}

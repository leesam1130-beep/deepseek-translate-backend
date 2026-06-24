/**
 * 来信翻译本地快路径：达累斯萨拉姆 WhatsApp 口语/连写/错拼 → 固定中文，0 LLM tokens。
 * 未命中返回 null，交给 LLM + 前后文。
 */

export function normalizeIncomingText(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[^a-z0-9\u00c0-\u024f'?]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactIncomingText(raw) {
  return normalizeIncomingText(raw).replace(/\s/g, "");
}

/** 仅当文本短/含糊时才值得附带 recentContext（省 input tokens） */
export function needsIncomingContext(text) {
  const norm = normalizeIncomingText(text);
  const compact = compactIncomingText(text);
  if (!norm) return false;
  if (norm.length <= 48) return true;
  if (/^(vp|ngp|bei|ok|sawa|ndio)\.?$/i.test(norm)) return true;
  if (/ngapi|shing|nafuu|betri|nionekabei|shiganpi/i.test(compact)) return true;
  return false;
}

const EXACT_RULES = [
  [/^(ni\s+)?tsh\s*ngapi\??$/i, "多少坦桑尼亚先令？"],
  [/^(ni\s+)?shilingi\s*ngapi\??$/i, "多少坦桑尼亚先令？"],
  [/^(hiz[i]?|hii|izi)\s*(ni\s+)?(shilingi\s*)?ngapi\??$/i, "这个多少钱？"],
  [/^(bei\s*)?ngapi\??$/i, "多少钱？"],
  [/^vp\??$/i, "怎么样？/在吗？"],
  [/^(asante\s*)?sana$/i, "非常感谢"],
  [/^asante\.?$/i, "谢谢"],
  [/^(ok|okay|sawa|ndio|ndiyo)\.?$/i, "好的"],
  [/^(hi|hello|habari|mambo|hujambo)\b/i, "你好"],
  [/^nafuu?\.?$/i, "要便宜的/实惠的"]
];

const COMPACT_RULES = [
  [/shilingingapi|shingapi|shiganpi|shingp|shingapi/i, "多少钱？"],
  [/nionekabei/i, "让我看看价格。"],
  [/betrizinatoka/i, "电池是自带的吗？/电池从哪儿来的？"],
  [/betrizinato/i, "电池是自带的吗？/电池从哪儿来的？"],
  [/hizinigapi|hizingapi/i, "这个多少钱？"],
  [/tshngapi/i, "多少坦桑尼亚先令？"]
];

const LOOSE_RULES = [
  [/betri.{0,6}zinato/i, "电池是自带的吗？/电池从哪儿来的？"],
  [/shilingi.{0,4}ngapi|shi.{0,3}ngapi/i, "多少钱？"],
  [/(uniambie|weniambie|niambie).{0,40}(bei|ngapi|shing)/i, "请告诉我价格。"],
  [/(uniambie|weniambie).{0,40}nafuu/i, "请告诉我，要便宜的。"],
  [/(nione|nionek).{0,6}bei/i, "让我看看价格。"],
  [/nafuu/i, null] // 仅作标记，见下方组合
];

export function tryLocalIncomingTranslation(raw) {
  const norm = normalizeIncomingText(raw);
  const compact = compactIncomingText(raw);
  if (!norm) return { translation_cn: "", source: "local-empty" };

  for (const [re, zh] of EXACT_RULES) {
    if (re.test(norm)) return { translation_cn: zh, source: "local-exact" };
  }

  // 组合：问价 + 要便宜（须在 COMPACT 前，避免 nionekabei 单独命中）
  const wantsPrice = /(bei|ngapi|shingapi|shiganpi|nionekabei)/i.test(compact);
  const wantsCheap = /nafuu?/i.test(norm);
  const wantsTell = /(uniambie|weniambie|niambie)/i.test(norm);
  if (wantsTell && wantsPrice && wantsCheap) {
    return { translation_cn: "请告诉我价格，要便宜的。", source: "local-composite" };
  }
  if (wantsTell && wantsPrice) {
    return { translation_cn: "请告诉我价格。", source: "local-composite" };
  }
  if (wantsTell && wantsCheap) {
    return { translation_cn: "请告诉我，要便宜的。", source: "local-composite" };
  }

  for (const [re, zh] of COMPACT_RULES) {
    if (re.test(compact)) return { translation_cn: zh, source: "local-compact" };
  }
  for (const [re, zh] of LOOSE_RULES) {
    if (re.test(norm) && zh) return { translation_cn: zh, source: "local-loose" };
  }

  return null;
}

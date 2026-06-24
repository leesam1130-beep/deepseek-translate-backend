// 测量 SemaTranslate 后端各路由 prompt token 消耗
// 用法: node scripts/measure-tokens.mjs

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { encode } from "gpt-tokenizer/model/gpt-4o-mini";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverSource = readFileSync(join(root, "server.js"), "utf8");
const colloquial = JSON.parse(readFileSync(join(root, "colloquial-glossary.json"), "utf8"));

function extractTemplate(src, varName) {
  const m = src.match(new RegExp(`const\\s+${varName}\\s*=\\s*\`([\\s\\S]*?)\`;`));
  return m ? m[1] : null;
}

function extractFnReturn(src, fnName) {
  const m = src.match(new RegExp(`function\\s+${fnName}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) return null;
  const ret = m[1].match(/return\s+`([\s\S]*?)`;/);
  return ret ? ret[1] : null;
}

function tokens(s) {
  return s ? encode(s).length : 0;
}

function row(label, text) {
  const t = tokens(text);
  console.log(`  ${label.padEnd(42)} ${String(t).padStart(5)} tok   ${String(text?.length || 0).padStart(5)} ch`);
}

const batchSlim = extractTemplate(serverSource, "BATCH_TRANSLATE_INSTRUCTIONS_SLIM");
const batchExpert = extractTemplate(serverSource, "BATCH_TRANSLATE_INSTRUCTIONS_EXPERT");
const outSlimTpl = extractFnReturn(serverSource, "buildOutboundInstructionsSlim");
const outExpertTpl = extractFnReturn(serverSource, "buildOutboundInstructionsExpert");
const outSlim = outSlimTpl?.replace(/\$\{targetLanguage\}/g, "Swahili") || "";
const outExpert = outExpertTpl?.replace(/\$\{lang\}/g, "Swahili") || "";

// 典型样例
const srcZh = "您好，货已备好，3箱 A60 9W，批发价 0.5 USD/pcs。";
const ctxMsgs = ["Mna A60 LED?", "9W au 12W?", "Bei ya jumla?"];
const batchItems = [
  { id: "m1", text: "Ngp" },
  { id: "m2", text: "Sawa" }
];

const outInputNoCtx = `CTX:\n1. ${ctxMsgs[0]}\n2. ${ctxMsgs[1]}\n\n${srcZh}`;
const batchInputWithCtx = `CTX:\n1. ${ctxMsgs[0]}\n2. ${ctxMsgs[1]}\n\nm1: Ngp\nm2: Sawa`;
const batchInputNoCtx = `m1: Bei ya jumla?\nm2: Asante sana`;

// 词库命中估算（vp+ngapi 2条）
const glossarySample = `Terms:\nvp/vipi→怎么样？/如何？\nngapi/ngp→多少钱？\n`;

console.log("\n=========================================================");
console.log(" SemaTranslate Backend — Token 测量 (gpt-4o-mini 编码)");
console.log("=========================================================\n");

console.log("【System / Instructions】");
row("来信 slim", batchSlim);
row("来信 expert", batchExpert);
row("出站 slim", outSlim);
row("出站 expert", outExpert);
row("口语词库 colloquial-glossary", `${colloquial.length} entries (runtime inject 0~6 hits)`);

console.log("\n【典型 Input（不含 JSON schema 开销）】");
row("出站 input（2条CTX + 中文）", outInputNoCtx);
row("来信 batch（2条+CTX）", batchInputWithCtx);
row("来信 batch（2条长句无CTX）", batchInputNoCtx);
row("词库块样例（2命中）", glossarySample);

console.log("\n【整次请求 input 估算 = instructions + input】");
const scenarios = [
  ["出站翻译", outSlim, outInputNoCtx],
  ["来信 batch（短句+CTX）", batchSlim, batchInputWithCtx + glossarySample],
  ["来信 batch（长句无CTX）", batchSlim, batchInputNoCtx],
  ["来信 local-fast（Vp/Ngp命中）", "—", "0 (本地规则)"]
];
for (const [name, inst, inp] of scenarios) {
  if (inst === "—") {
    console.log(`  ${name.padEnd(28)} ${inp}`);
    continue;
  }
  const total = tokens(inst) + tokens(inp);
  console.log(`  ${name.padEnd(28)} ~${total} input tokens  (inst ${tokens(inst)} + body ${tokens(inp)})`);
}

console.log("\n【Output 估算】");
console.log("  出站 JSON 回复        ~40-80 output tokens");
console.log("  来信 batch 2条        ~60-120 output tokens");
console.log("  来信 local-fast       0 output tokens");

console.log("\n【前端传给后端的载荷】");
console.log("  /api/translate        sourceText + customerMessages(≤2×80字) + contextHint");
console.log("  /api/batch            items[] + recentContext(前端最多6条,后端短句才取3条)");
console.log("  插件本地缓存命中       0 token（text-cache / inline-cache / incoming-local）");

console.log("");

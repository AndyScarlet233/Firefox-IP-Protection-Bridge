// Regression tests for rule copy/import (migration between browsers).
// Mirrors extension/background.js normalizeDomain + canonicalManagedDomain + parseRulePayload.
let failures = 0;
const check = (n, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`);
  if (!ok) console.log(`        expected ${JSON.stringify(e)}\n        actual   ${JSON.stringify(a)}`);
};

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const ALIASES = {
  "www.bilibili.com":"bilibili.com","chat.openai.com":"chatgpt.com","www.chatgpt.com":"chatgpt.com",
  "claude.com":"claude.ai","www.claude.com":"claude.ai","www.claude.ai":"claude.ai",
  "anthropic.com":"claude.ai","www.google.com":"google.com","gemini.google.com":"google.com"
};
const normalizeDomain = (input) => {
  let value = String(input || "").trim().toLowerCase();
  if (!value) throw new Error("请输入网站域名。");
  value = value.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
  try {
    const u = new URL(value.includes("://") ? value : `https://${value}`);
    value = u.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
  } catch (_) { throw new Error("这个网站地址看起来无效。"); }
  if (!value || value.length > 253 || value.includes(" ")) throw new Error("这个网站地址看起来无效。");
  if (!DOMAIN_SHAPE.test(value)) throw new Error("这个网站地址看起来无效。");
  return value;
};
const canonicalManagedDomain = (i) => { const d = normalizeDomain(i); return ALIASES[d] || d; };
const nmda = (vs) => { const r=[]; for (const it of(Array.isArray(vs)?vs:[])) { try{const d=canonicalManagedDomain(it); if(!r.includes(d)) r.push(d);}catch(_){} } return r.sort(); };

function parseRulePayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const seen = new Set();
  let items = [];
  if (raw.startsWith("[")) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error("导入内容不是有效的 JSON 数组。"); }
    if (!Array.isArray(parsed)) throw new Error("导入内容必须是数组。");
    items = parsed;
  } else {
    items = raw.split(/\r?\n|;/);
  }
  for (const item of items) {
    const value = String(item ?? "").trim();
    if (!value) continue;
    const candidate = value.replace(/^#/, "").trim();
    if (!candidate) continue;
    const pieces = candidate.split(/[,\s]+/).filter(Boolean).map((piece) => {
      try { return canonicalManagedDomain(piece); } catch (_) { return ""; }
    });
    if (!pieces.length || pieces.some((piece) => !piece)) continue;
    for (const domain of pieces) {
      if (!seen.has(domain)) seen.add(domain);
    }
  }
  if (!seen.size) throw new Error("没有找到可导入的域名。");
  return [...seen].sort();
}

console.log("\n=== 解析：各种粘贴格式 ===");
check("换行列表", parseRulePayload("a.com\nb.com\nc.com"), ["a.com","b.com","c.com"]);
check("逗号列表", parseRulePayload("a.com, b.com , c.com"), ["a.com","b.com","c.com"]);
check("分号/空格混合", parseRulePayload("a.com; b.com\nc.com"), ["a.com","b.com","c.com"]);
check("JSON 数组", parseRulePayload('["a.com","b.com"]'), ["a.com","b.com"]);
check("带注释头(复制格式)", parseRulePayload("# 火狐 VPN 白名单（走 VPN）\n# 共 2 条；在另一台电脑点「导入」并粘贴即可合并\na.com\nb.com"), ["a.com","b.com"]);

console.log("\n=== 规范化：别名与 URL ===");
check("www.* 折叠", parseRulePayload("www.google.com\ngemini.google.com"), ["google.com"]);
check("去重+大小写", parseRulePayload("a.com\na.com\nA.COM"), ["a.com"]);
check("带 https 前缀", parseRulePayload("https://chatgpt.com/x"), ["chatgpt.com"]);
check("带路径", parseRulePayload("https://ippure.com/MyIP-Info-Card.html"), ["ippure.com"]);
check("*. 通配", parseRulePayload("*.claude.ai"), ["claude.ai"]);
check("大写归一", parseRulePayload("IPPure.com"), ["ippure.com"]);

console.log("\n=== 迁移往返：导出再导入必须完全一致 ===");
{
  const original = ["chatgpt.com","gemini.google.com","ippure.com","www.google.com","www.google.com.hk","z-lib.sk"];
  const exported = nmda(original);
  const text = [
    "# 火狐 VPN 白名单（走 VPN）",
    "# 共 " + exported.length + " 条；在另一台电脑点「导入」并粘贴即可合并",
    ...exported
  ].join("\n");
  check("往返一致", parseRulePayload(text), exported);
}

console.log("\n=== 错误处理 ===");
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
check("空输入 -> []", parseRulePayload("   "), []);
check("坏 JSON 抛错", throws(() => parseRulePayload('["a.com",')), true);
check("非数组 JSON 抛错", throws(() => parseRulePayload('{"a":1}')), true);
check("全非法 -> 抛错", throws(() => parseRulePayload("!!!\n???")), true);
check("纯散文 -> 抛错", throws(() => parseRulePayload("这些是一些说明文字")), true);

console.log("\n=== 合并语义（导入不覆盖已有规则）===");
{
  const before = ["chatgpt.com"];
  const incoming = parseRulePayload("ippure.com\nchatgpt.com\nz-lib.sk");
  const merged = nmda([...before, ...incoming]);
  check("合并后含全部", merged, ["chatgpt.com","ippure.com","z-lib.sk"]);
  check("原有规则未丢失", merged.includes("chatgpt.com"), true);
  check("新增计数", merged.filter(d => !before.includes(d)).length, 2);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

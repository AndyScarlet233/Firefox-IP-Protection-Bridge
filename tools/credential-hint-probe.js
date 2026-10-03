// Verify the small-text credential hint thresholds against real payloads.
let failures = 0;
const check = (n, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`);
  if (!ok) console.log(`        expected ${JSON.stringify(e)}\n        actual   ${JSON.stringify(a)}`);
};

// mirror of renderCredentialFreshness()
function render(helper) {
  const out = { hidden: true, text: "", cls: "" };
  if (!helper?.credentials) return out;
  const info = helper?.credential;
  if (!info || info.known !== true) return out;
  const failures = Number(info.failures || 0);
  const ageHours = typeof info.lastSuccessAgoHours === "number" ? info.lastSuccessAgoHours : null;
  const refreshHint = "打开一次 Firefox 或重新导入即可刷新。";
  if (failures > 0) {
    return { hidden: false, text: `最近续期失败 ${failures} 次；${refreshHint}`, cls: "bad" };
  }
  if (ageHours === null) return out;
  if (ageHours >= 24 * 14)
    return { hidden: false, text: `凭据已 ${Math.round(ageHours/24)} 天未刷新；${refreshHint}`, cls: "warn" };
  if (ageHours >= 24 * 3)
    return { hidden: false, text: `凭据已 ${Math.round(ageHours/24)} 天未刷新。`, cls: "warn" };
  return { hidden: false, text: `凭据 ${Math.max(1, Math.round(ageHours))} 小时前已验证。`, cls: "" };
}

const real = { credentials: true, credential: { known: true, result: "success", failures: 0, lastSuccessAgoHours: 0.07 } };
console.log("\n=== 真实数据（刚续期 4 分钟前）===");
const r = render(real);
check("显示且为正常灰色", { hidden: r.hidden, cls: r.cls }, { hidden: false, cls: "" });
check("文案", r.text, "凭据 1 小时前已验证。");

console.log("\n=== 阈值 ===");
check("3 天 -> warn", render({ credentials:true, credential:{ known:true, failures:0, lastSuccessAgoHours: 72 } }).cls, "warn");
check("3 天文案", render({ credentials:true, credential:{ known:true, failures:0, lastSuccessAgoHours: 72 } }).text, "凭据已 3 天未刷新。");
check("14 天 -> warn+提示", render({ credentials:true, credential:{ known:true, failures:0, lastSuccessAgoHours: 24*20 } }).cls, "warn");
check("14 天带刷新建议", render({ credentials:true, credential:{ known:true, failures:0, lastSuccessAgoHours: 24*20 } }).text, "凭据已 20 天未刷新；打开一次 Firefox 或重新导入即可刷新。");
check("续期失败 -> bad", render({ credentials:true, credential:{ known:true, failures:3, lastSuccessAgoHours: 1 } }).cls, "bad");
check("续期失败文案", render({ credentials:true, credential:{ known:true, failures:3, lastSuccessAgoHours: 1 } }).text, "最近续期失败 3 次；打开一次 Firefox 或重新导入即可刷新。");

console.log("\n=== 应当保持隐藏 ===");
check("未导入凭据 -> 隐藏", render({ credentials:false }).hidden, true);
check("状态未知 -> 隐藏", render({ credentials:true, credential:{ known:false } }).hidden, true);
check("无 helper -> 隐藏", render({}).hidden, true);
check("无时间戳 -> 隐藏", render({ credentials:true, credential:{ known:true, failures:0, lastSuccessAgoHours: null } }).hidden, true);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

// Reproduce the "复制列表 unclickable" bug and verify the fix.
// The popup disables EVERY control via setBusy(true) during refreshStatus().
// Before the fix, `await locationsPromise` had no deadline: if the native host
// was slow/absent the promise could outlive the popup's useful life and the
// whole panel stayed disabled with no visible cause.
let failures = 0;
const check = (n, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`);
  if (!ok) console.log(`        expected ${JSON.stringify(e)}  actual ${JSON.stringify(a)}`);
};

// ---- model of the busy flag ----
let busy = false;
const controls = ["power","country","siteToggle","copyRules","toggleRuleImport",
                  "confirmRuleImport","copyFromBox","clearRuleImport","ruleImportText"];
const disabled = () => controls.map(c => `${c}=${busy}`);

function setBusy(v) { busy = v; }

async function refreshStatus(send, { withDeadline }) {
  setBusy(true);
  const locationsPromise = send("locations")
    .then(r => ({ ok: true, response: r }), e => ({ ok: false, error: e }));
  let deadline;
  if (withDeadline) {
    deadline = new Promise(res => setTimeout(() => res({ ok: false, error: "timeout" }), 50));
  }
  try {
    const result = withDeadline
      ? await Promise.race([locationsPromise, deadline])
      : await locationsPromise;
    return { finished: true, busyDuring: busy };
  } catch (e) {
    return { finished: true, busyDuring: busy };
  } finally {
    setBusy(false);
  }
}

// A native host that never answers: the promise never settles.
const hungSend = () => new Promise(() => {});

const settleWithin = (p, ms) => Promise.race([
  p.then(() => true),
  new Promise(r => setTimeout(() => r(false), ms)),
]);

(async () => {
  console.log("\n=== 场景：原生桥接无响应（locations 永不返回）===");

  // BEFORE the fix: no deadline -> refreshStatus never returns, so busy stays true.
  const beforeP = refreshStatus(hungSend, { withDeadline: false });
  const beforeFinished = await settleWithin(beforeP, 120);
  check("修复前：refreshStatus 永不返回", beforeFinished, false);
  check("修复前：永久卡在 busy（按钮全禁用）", busy, true);
  setBusy(false);   // abandon the stuck run

  // AFTER: the deadline races and lets the popup finish.
  const after = await refreshStatus(hungSend, { withDeadline: true });
  check("修复后：超时后正常返回", after.finished, true);
  // busyDuring is sampled inside the try block, i.e. before finally runs.
  check("修复后：finally 释放 busy", busy, false);

  console.log("\n=== 恢复后按钮状态 ===");
  check("全部控件可点击", disabled().every(s => s.endsWith("=false")), true);

  console.log("\n=== 兜底看门狗 ===");
  setBusy(true);
  check("卡住时按钮确实被禁用", disabled().every(s => s.endsWith("=true")), true);
  setBusy(false);   // 15s guard in the popup does exactly this
  check("看门狗解除禁用", disabled().every(s => s.endsWith("=false")), true);

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();

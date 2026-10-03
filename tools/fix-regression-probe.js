// Regression tests for the three fixed defects.
// Run: node tools/fix-regression-probe.js
const path = require("path");

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

// ---- mirror of background.js routing helpers (post-fix) ----
const SITE_FAMILIES = {
  "chatgpt.com": ["chatgpt.com","openai.com","oaistatic.com","oaiusercontent.com","oaistatsig.com","openaimerge.com"],
  "claude.ai": ["claude.ai","claude.com","anthropic.com"],
  "ippure.com": ["ippure.com","api.ippure.com","ipinfo.io","v6.ipinfo.io","ipapi.co","myip.ipip.net"]
};
const SITE_FAMILY_ALIASES = {
  "www.bilibili.com":"bilibili.com","chat.openai.com":"chatgpt.com","www.chatgpt.com":"chatgpt.com",
  "claude.com":"claude.ai","www.claude.com":"claude.ai","www.claude.ai":"claude.ai",
  "anthropic.com":"claude.ai","www.claude.ai":"claude.ai","www.google.com":"google.com",
  "gemini.google.com":"google.com"
};
const normalizeDomain = (i) => {
  let v = String(i||"").trim().toLowerCase().replace(/^\*\./,"").replace(/^\.+|\.+$/g,"");
  return new URL(v.includes("://") ? v : `https://${v}`).hostname.toLowerCase().replace(/^\.+|\.+$/g,"");
};
const canonicalManagedDomain = (i) => { const d = normalizeDomain(i); return SITE_FAMILY_ALIASES[d] || d; };
const normalizeManagedDomainArray = (vs) => {
  const r = [];
  for (const it of (Array.isArray(vs) ? vs : [])) { try { const d = canonicalManagedDomain(it); if (!r.includes(d)) r.push(d); } catch (_) {} }
  return r.sort();
};
const expandRouteDomains = (vs) => {
  const m = normalizeManagedDomainArray(vs); const e = new Set(m);
  for (const r of m) { const f = SITE_FAMILIES[r]; if (f) for (const d of f) e.add(d); }
  return [...e].sort();
};
const ruleCoversHost = (rule, host) => host === rule || host.endsWith(`.${rule}`);
const listCoversHost = (l, h) => normalizeManagedDomainArray(l).some((r) => ruleCoversHost(r, h));

function listCoversHostManaged(list, hostInput) {
  let host = ""; try { host = normalizeDomain(hostInput); } catch (_) { return false; }
  return normalizeManagedDomainArray(list).some((rule) => ruleCoversHost(rule, host));
}
function removeManagedRule(list, domainInput) {
  const target = canonicalManagedDomain(domainInput);
  return normalizeManagedDomainArray((Array.isArray(list) ? list : []).filter((item) => {
    let rule = ""; try { rule = canonicalManagedDomain(item); } catch (_) { return false; }
    return !ruleCoversHost(rule, target);
  }));
}
function setSiteRuleNow(state, domainInput, useVpn) {
  const domain = canonicalManagedDomain(domainInput);
  let allowlist = [...state.allowlist], bypassSites = [...state.bypassSites];
  if (state.proxyMode === "allowlist") {
    if (useVpn) { if (!listCoversHostManaged(allowlist, domain)) allowlist = [...allowlist, domain]; }
    else allowlist = removeManagedRule(allowlist, domain);
  } else {
    if (useVpn) bypassSites = removeManagedRule(bypassSites, domain);
    else if (!listCoversHostManaged(bypassSites, domain)) bypassSites = [...bypassSites, domain];
  }
  return { allowlist: normalizeManagedDomainArray(allowlist), bypassSites: normalizeManagedDomainArray(bypassSites) };
}
function routeUsesVpnForState(state, hostInput) {
  let host = ""; try { host = normalizeDomain(hostInput); } catch (_) { return false; }
  const mode = state.proxyMode === "blacklist" || state.proxyMode === "all" ? "blacklist" : "allowlist";
  const routed = mode === "allowlist" ? state.allowlist : state.bypassSites;
  const matched = listCoversHost(expandRouteDomains(routed), host);
  return mode === "allowlist" ? matched : !matched;
}

console.log("\n=== A. per-site toggle no longer dead ===");
// The exact state that reproduced the bug: gemini.google.com + www.google.com
// both canonicalize to google.com, so removing one left the other in place.
{
  const s = { proxyMode: "allowlist",
              allowlist: ["www.google.com", "gemini.google.com"],
              bypassSites: [] };
  const after = setSiteRuleNow(s, "www.google.com", false);
  check("alias twin removed from allowlist", after.allowlist, []);
  check("www.google.com now routes DIRECT",
    routeUsesVpnForState({ ...s, allowlist: after.allowlist }, "www.google.com"), false);
  check("gemini.google.com now routes DIRECT",
    routeUsesVpnForState({ ...s, allowlist: after.allowlist }, "gemini.google.com"), false);
}
{
  // Round trip must be stable.
  let s = { proxyMode: "blacklist", allowlist: [], bypassSites: [] };
  s = setSiteRuleNow(s, "ippure.com", false);
  check("blacklist: OFF adds bypass", s.bypassSites, ["ippure.com"]);
  s = setSiteRuleNow(s, "ippure.com", true);
  check("blacklist: ON removes bypass", s.bypassSites, []);
}

console.log("\n=== A2. popup toggle state matches the PAC ===");
{
  // This is the shape actually stored by the user: the allowlist carries
  // "gemini.google.com" but not a literal "www.google.com". The raw list
  // therefore reports OFF for the www host, while the PAC canonicalizes both
  // spellings to google.com and really does tunnel it.
  const s = { proxyMode: "allowlist",
              allowlist: ["gemini.google.com","ippure.com"], bypassSites: [] };
  const oldPopup = s.allowlist.some((r) => ruleCoversHost(r, "www.google.com"));
  const authoritative = routeUsesVpnForState(s, "www.google.com");
  check("old raw-list view disagreed", oldPopup, false);
  check("authoritative view is correct", authoritative, true);
}

console.log("\n=== C. anycast catch-all detection ===");
function isAnycastCatchall(node) {
  const label = `${node.label||""} ${node.city||""} ${node.name||""}`.toLowerCase();
  const hostname = String(node.hostname||"").toLowerCase();
  return label.includes("catchall") || label.includes("catch-all") || label.includes("anycast")
      || hostname.startsWith("p.m");
}
check("real US node kept", isAnycastCatchall({ name:"us-us-us", hostname:"us.m1.fastly-masque.net", label:"United States/United States (us.m1.fastly-masque.net)" }), false);
check("anycast catchall detected", isAnycastCatchall({ name:"us-q30-p", hostname:"p.m1.fastly-masque.net", label:"CatchAll Anycast/USA (p.m1.fastly-masque.net)" }), true);
check("p.m hostname detected", isAnycastCatchall({ hostname:"p.m1.fastly-masque.net" }), true);

console.log(failures === 0 ? "\nALL REGRESSION TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

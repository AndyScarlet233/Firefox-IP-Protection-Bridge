const $ = (id) => document.getElementById(id);
const connectionCard = $("connectionCard");
const headline = $("headline");
const modeHint = $("modeHint");
const statusMark = $("statusMark");
const power = $("power");
const country = $("country");
const locationButton = $("locationButton");
const locationText = $("locationText");
const currentSite = $("currentSite");
const siteRow = $("siteRow");
const siteToggle = $("siteToggle");
const notice = $("notice");
const settingsButton = $("settingsButton");
const settingsPanel = $("settingsPanel");
const settingsSummary = $("settingsSummary");
const infoButton = $("infoButton");
const modeAllowlist = $("modeAllowlist");
const modeBlacklist = $("modeBlacklist");
const modeDescription = $("modeDescription");
const listTitle = $("listTitle");
const siteCount = $("siteCount");
const domainInput = $("domainInput");
const addDomain = $("addDomain");
const domainList = $("domainList");
const credentialStatus = $("credentialStatus");
const credentialFreshness = $("credentialFreshness");
const copyRules = $("copyRules");
const toggleRuleImport = $("toggleRuleImport");
const copyFromBox = $("copyFromBox");
const clearRuleImport = $("clearRuleImport");
const confirmRuleImport = $("confirmRuleImport");
const ruleImportPanel = $("ruleImportPanel");
const ruleImportText = $("ruleImportText");
const importFirefox = $("importFirefox");
const bootstrapLogin = $("bootstrapLogin");
const bootstrapProgress = $("bootstrapProgress");
const bootstrapForm = $("bootstrapForm");
const bootstrapEmail = $("bootstrapEmail");
const bootstrapPassword = $("bootstrapPassword");
const bootstrapStart = $("bootstrapStart");
const bootstrapFormCancel = $("bootstrapFormCancel");
const bootstrapChallenge = $("bootstrapChallenge");
const bootstrapChallengeHint = $("bootstrapChallengeHint");
const bootstrapCaptchaImg = $("bootstrapCaptchaImg");
const bootstrapCodeInput = $("bootstrapCodeInput");
const bootstrapCaptchaInput = $("bootstrapCaptchaInput");
const bootstrapChallengeSubmit = $("bootstrapChallengeSubmit");
const usageButton = $("usage");
const usageText = $("usageText");
const installPath = $("installPath");
const openFolder = $("openFolder");
const removeLocal = $("removeLocal");
const fullUninstall = $("fullUninstall");
const autoConnectToggle = $("autoConnectToggle");
const webRtcLeakToggle = $("webRtcLeakToggle");
const dnsPredictionToggle = $("dnsPredictionToggle");
const webRtcPrivacyDetail = $("webRtcPrivacyDetail");
const dnsPrivacyDetail = $("dnsPrivacyDetail");
const fingerprintShieldToggle = $("fingerprintShieldToggle");
const fingerprintShieldDetail = $("fingerprintShieldDetail");
const regionShieldToggle = $("regionShieldToggle");
const regionShieldDetail = $("regionShieldDetail");
const regionProfileText = $("regionProfileText");
const regionPageDiagText = $("regionPageDiagText");

// ---------------------------------------------------------------------------
// Localization. Every user-visible string in this file goes through t(); the
// English catalogue in _locales/en is the default locale, so a missing key
// falls back to the key itself instead of rendering an empty label.
// ---------------------------------------------------------------------------
function uiLanguage() {
  try { return String(chrome?.i18n?.getUILanguage?.() || "en"); }
  catch (_) { return "en"; }
}

function t(key, ...substitutions) {
  try {
    const text = chrome?.i18n?.getMessage?.(key, substitutions.map((value) => String(value)));
    if (typeof text === "string" && text) return text;
  } catch (_) {}
  return key;
}

const ENGLISH_UI = /^en\b/i.test(uiLanguage());

// popup.html ships lang="en" (the default locale); correct it to whatever
// locale Chrome actually resolved, so hyphenation, font fallback and screen
// readers follow the visible language.
try { document.documentElement.lang = uiLanguage().replace(/_/g, "-"); } catch (_) {}

// Chrome substitutes __MSG_*__ in manifest.json and CSS only - NOT in extension
// HTML pages - so popup.html carries data-i18n* attributes and this fills them
// in before the first render. Without it the raw attribute names would be
// visible on every static label.
function applyStaticI18n() {
  const fill = (selector, attribute, apply) => {
    for (const el of document.querySelectorAll(selector)) {
      const key = el.getAttribute(attribute);
      if (!key) continue;
      const text = t(key);
      if (text) apply(el, text);
    }
  };
  fill("[data-i18n]", "data-i18n", (el, text) => { el.textContent = text; });
  fill("[data-i18n-placeholder]", "data-i18n-placeholder", (el, text) => { el.placeholder = text; });
  fill("[data-i18n-title]", "data-i18n-title", (el, text) => { el.title = text; });
  fill("[data-i18n-aria-label]", "data-i18n-aria-label", (el, text) => { el.setAttribute("aria-label", text); });
  fill("[data-i18n-alt]", "data-i18n-alt", (el, text) => { el.alt = text; });
}

applyStaticI18n();

let state = { enabled: false, autoConnect: false, webRtcLeakProtection: true, dnsPredictionProtection: true, regionShieldEnabled: true, resolvedCountry: "", country: "REC", proxyMode: "allowlist", allowlist: [], bypassSites: [] };
let privacyStatus = null;
let regionStatus = null;
let helper = {};
let activeDomain = "";
let busy = false;
let connectionTransition = "";
let availableLocations = [];
let bootstrapPollActive = false;
let bootstrapChallengeNeed = null;

// Country names are the one list that cannot live in messages.json: the same
// code has to render as a Chinese name in a Chinese UI and as an English name
// in an English UI. The Chinese table below is the interface's original
// wording; an English UI is served by Intl.DisplayNames instead, which already
// ships accurate names for every code the pool can hand back.
const COUNTRY_NAMES_ZH = {
  AT: "奥地利", AU: "澳大利亚", BE: "比利时", BG: "保加利亚", CA: "加拿大",
  CH: "瑞士", CL: "智利", CO: "哥伦比亚", DE: "德国", DK: "丹麦",
  ES: "西班牙", FI: "芬兰", FR: "法国", GB: "英国", IE: "爱尔兰",
  IT: "意大利", JP: "日本", MX: "墨西哥", MY: "马来西亚", NL: "荷兰",
  NO: "挪威", NZ: "新西兰", PL: "波兰", PT: "葡萄牙", SE: "瑞典",
  SG: "新加坡", TH: "泰国", US: "美国", ZA: "南非"
};

let englishRegionNames = null;
function englishRegionName(code) {
  if (englishRegionNames === null) {
    try {
      englishRegionNames = new Intl.DisplayNames([uiLanguage() || "en"], { type: "region" });
    } catch (_) {
      englishRegionNames = false;
    }
  }
  if (!englishRegionNames) return "";
  try { return englishRegionNames.of(code) || ""; }
  catch (_) { return ""; }
}

// `fallback` covers codes the pool reports that are in neither list.
function countryNameFor(code, fallback = "") {
  const key = String(code || "").toUpperCase();
  if (!key) return fallback || "";
  if (ENGLISH_UI) return englishRegionName(key) || fallback || key;
  return COUNTRY_NAMES_ZH[key] || fallback || key;
}

function populateLocations(items = []) {
  availableLocations = Array.isArray(items) ? items : [];
  const previous = state.country || country.value || "REC";
  const availableCodes = new Set(availableLocations.filter(x => x && x.available !== false).map(x => String(x.code || "").toUpperCase()));
  const seenCodes = new Set(availableLocations.map(x => String(x.code || "").toUpperCase()).filter(Boolean));
  const allCodes = new Set([...Object.keys(COUNTRY_NAMES_ZH), ...seenCodes]);

  country.innerHTML = "";
  const recommended = document.createElement("option");
  recommended.value = "REC";
  recommended.textContent = t("locationRec");
  country.appendChild(recommended);

  const collator = new Intl.Collator(uiLanguage() || undefined);
  const sortedCodes = [...allCodes].sort((a, b) => {
    const infoA = availableLocations.find(x => String(x.code || "").toUpperCase() === a) || {};
    const infoB = availableLocations.find(x => String(x.code || "").toUpperCase() === b) || {};
    return collator.compare(countryNameFor(a, infoA.name), countryNameFor(b, infoB.name));
  });
  for (const code of sortedCodes) {
    const info = availableLocations.find(x => String(x.code || "").toUpperCase() === code) || {};
    const option = document.createElement("option");
    option.value = code;
    option.disabled = !availableCodes.has(code);
    const name = countryNameFor(code, info.name);
    option.textContent = option.disabled ? t("countryUnavailable", name) : name;
    country.appendChild(option);
  }

  const optionExists = [...country.options].some(o => o.value === previous);
  country.value = optionExists ? previous : "REC";
}

function sleepMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function send(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (_) {
    // The service worker can be asleep or still starting. Treating that as a
    // hard failure would surface a bogus error and leave the popup unusable.
    await sleepMs(400);
    try { response = await chrome.runtime.sendMessage(message); }
    catch (_) { throw new Error(t("errBackgroundNoResponse")); }
  }
  if (!response) throw new Error(t("errBackgroundNoResult"));
  if (response.ok === false) throw new Error(response.error || t("errOperationFailed"));
  return response;
}


function translateUiError(message = "") {
  const text = String(message || "").trim();
  if (!text) return "";
  const known = [
    [/Specified native messaging host not found\.?/i, t("errNativeHostNotFound")],
    [/Error when communicating with the native messaging host\.?/i, t("errNativeHostCommunicate")],
    [/Native host has exited\.?/i, t("errNativeHostExited")],
    [/Access to the specified native messaging host is forbidden\.?/i, t("errNativeHostForbidden")],
    [/Native bridge returned no response/i, t("errNativeNoResponse")],
    [/Native bridge timeout while running (.+)/i, (_, cmd) => t("errNativeTimeout", cmd)],
    [/Native bridge disconnected/i, t("errNativeDisconnected")],
    [/Chrome proxy is controlled by another extension or policy\.?/i, t("errProxyControlledPopup")],
    [/Unknown extension command/i, t("errUnknownCommand")],
    [/no listeners started/i, t("errNoNodes")],
    [/exported 0 nodes/i, t("errNoNodes")],
    [/代理进程提前退出.*no listeners started/i, t("errNoNodes")],
    [/missing FxA access token for Guardian usage query/i, t("errOutdatedBackend")],
    [/missing Firefox renewal credentials for Guardian usage query/i, t("errMissingRenewalCredentials")],
    [/Firefox Account session requires re-authentication for Guardian usage query/i, t("errAccountReauth")],
    [/Firefox Account OAuth usage query was rate-limited/i, t("errUsageRateLimited")],
    [/temporary Firefox Account\/Guardian usage query failure/i, t("errUsageTemporary")],
    [/Guardian usage request failed with HTTP 403/i, t("errUsage403")],
    [/Guardian usage request failed with HTTP 401/i, t("errUsage401")],
    [/HTTP 451|service_restricted|service is restricted/i, t("errHttp451")],
    [/automatic renewal is paused \(service_restricted\)/i, t("errRenewalPaused")]
  ];
  for (const [pattern, replacement] of known) {
    const match = text.match(pattern);
    if (match) return typeof replacement === 'function' ? replacement(...match) : replacement;
  }
  if (ENGLISH_UI) return text;
  return text
    .replace(/\bNative bridge\b/g, "本地桥接程序")
    .replace(/\bhelper\b/gi, "桥接程序")
    .replace(/\bFirefox IP Protection\b/g, "Firefox IP 保护");
}

function showNotice(text = "", kind = "") {
  text = translateUiError(text);
  notice.textContent = text;
  notice.className = `notice ${kind}`.trim();
}

function formatQuotaBytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return t("errGenericUnknown");
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)} GB`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(1)} MB`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(1)} KB`;
  return `${Math.round(amount)} B`;
}

function formatQuotaReset(value) {
  const raw = String(value || "").trim();
  if (!raw) return t("errGenericUnknown");
  return raw.replace(/Z$/, " UTC").replace("T", " ");
}

function formatUsageText(value) {
  const raw = String(value || "").trim();
  if (!raw) return t("errUnreadableUsage");
  try {
    const usage = JSON.parse(raw);
    if (usage && typeof usage === "object") {
      if (usage.unlimited === true) return t("usageUnlimited");
      const limit = Number(usage.limit);
      const remaining = Number(usage.remaining);
      if (Number.isFinite(limit) && Number.isFinite(remaining) && limit >= 0 && remaining >= 0) {
        const used = Math.max(0, limit - remaining);
        let text = t("usagePlan", formatQuotaBytes(limit), formatQuotaBytes(used), formatQuotaBytes(remaining));
        if (usage.reset) text += t("usageResetSuffix", formatQuotaReset(usage.reset));
        return text;
      }
    }
  } catch (_) {}
  return raw;
}

function setBusy(value) {
  busy = value;
  for (const el of [power, country, siteToggle, autoConnectToggle, webRtcLeakToggle, dnsPredictionToggle, fingerprintShieldToggle, regionShieldToggle, modeAllowlist, modeBlacklist, domainInput, addDomain, importFirefox, bootstrapLogin, openFolder, removeLocal, fullUninstall, copyRules, toggleRuleImport, confirmRuleImport, copyFromBox, clearRuleImport, ruleImportText, bootstrapEmail, bootstrapPassword, bootstrapStart, bootstrapFormCancel, bootstrapCodeInput, bootstrapCaptchaInput, bootstrapChallengeSubmit]) {
    if (el) el.disabled = value;
  }
}

// The "(unavailable)" marker is appended by populateLocations(), so recovering
// the bare country name means removing exactly that localized suffix.
function unavailableSuffix() {
  const marker = "\u0000";
  const sample = t("countryUnavailable", marker);
  const at = sample.indexOf(marker);
  return at < 0 ? "" : sample.slice(at + marker.length);
}

function countryName() {
  const selected = country.options[country.selectedIndex];
  const suffix = unavailableSuffix();
  let label = String(selected?.text || "");
  if (suffix && label.endsWith(suffix)) label = label.slice(0, -suffix.length);
  return label || (country.value === "REC" ? t("locationRec") : countryNameFor(country.value));
}

function managedList() {
  return state.proxyMode === "allowlist" ? state.allowlist : state.bypassSites;
}

function ruleCoversHost(rule, host) {
  return host === rule || host.endsWith(`.${rule}`);
}

// The PAC is built from the canonicalized + site-family-expanded domain list in
// the background service worker. Re-deriving the answer from the raw stored list
// here used to disagree with it (e.g. "gemini.google.com"/"www.google.com" both
// fold into "google.com"), which made this toggle show a state opposite to the
// one Chrome actually applied. Ask the background instead of guessing.
let activeSiteUsesVpn = null;

function siteUsesVpn() {
  if (activeSiteUsesVpn !== null) return activeSiteUsesVpn;
  if (!activeDomain) return false;
  const inList = managedList().some((rule) => ruleCoversHost(rule, activeDomain));
  return state.proxyMode === "allowlist" ? inList : !inList;
}

function renderMain() {
  const pending = Boolean(connectionTransition);
  const loading = connectionTransition === "loading";
  const connecting = connectionTransition === "connecting";
  const switching = connectionTransition === "switching";
  const disconnecting = connectionTransition === "disconnecting";
  connectionCard.classList.toggle("on", Boolean(state.enabled) && !pending);
  connectionCard.classList.toggle("off", !state.enabled && !pending);
  connectionCard.classList.toggle("pending", pending);
  headline.textContent = loading
    ? t("statusReading")
    : connecting
      ? t("statusConnecting")
      : switching
        ? t("statusSwitching")
        : disconnecting
          ? t("statusDisconnecting")
          : (state.enabled ? t("headlineOn") : t("headlineOff"));
  power.textContent = loading
    ? t("powerReading")
    : connecting
      ? t("powerConnecting")
      : switching
        ? t("powerSwitching")
        : disconnecting
          ? t("powerDisconnecting")
          : (state.enabled ? t("powerOff") : t("powerOn"));
  if (statusMark) statusMark.textContent = pending ? "…" : "✓";
  locationText.textContent = t("locationPrefix", countryName());
  modeHint.textContent = pending
    ? (loading
      ? t("modeHintChecking")
      : (disconnecting ? t("modeHintRestoring") : t("modeHintVerifying")))
    : (state.proxyMode === "allowlist"
      ? t("modeHintAllowlistCount", state.allowlist.length)
      : (state.bypassSites.length ? t("modeHintBlocklistCount", state.bypassSites.length) : t("modeHintBlocklistAll")));
  settingsSummary.textContent = state.proxyMode === "allowlist" ? t("modeAllowlist") : t("modeBlacklist");
  const showSiteControls = Boolean(state.enabled && activeDomain && !pending);
  siteRow.hidden = !showSiteControls;
  siteToggle.checked = showSiteControls && siteUsesVpn();
  siteRow?.classList.toggle("vpn-on-site", Boolean(showSiteControls && siteToggle.checked));
  siteToggle.disabled = busy || !showSiteControls;
  // setBusy re-enables everything it gated, so the unavailable/disabled state
  // has to be re-asserted on every render or it would silently be lost.
  applyBootstrapAvailability();
  renderCredentialFreshness();
}

// The imported Mozilla session token is only refreshed while Firefox itself is
// running, so a stale one silently breaks the tunnel later. Keep this to one
// quiet line instead of a banner, and stay silent while nothing is wrong.
function renderCredentialFreshness() {
  if (!credentialFreshness) return;
  const info = helper?.credential;
  credentialFreshness.classList.remove("warn", "bad");
  if (!helper?.credentials) { credentialFreshness.hidden = true; return; }
  if (!info || info.known !== true) { credentialFreshness.hidden = true; return; }

  const failures = Number(info.failures || 0);
  const ageHours = typeof info.lastSuccessAgoHours === "number" ? info.lastSuccessAgoHours : null;
  const refreshHint = t("credRefreshHint");

  if (failures > 0) {
    credentialFreshness.textContent = t("credRenewalFailures", failures, refreshHint);
    credentialFreshness.classList.add("bad");
    credentialFreshness.hidden = false;
    return;
  }
  if (ageHours === null) { credentialFreshness.hidden = true; return; }
  if (ageHours >= 24 * 14) {
    credentialFreshness.textContent = t("credStaleDays", Math.round(ageHours / 24), refreshHint);
    credentialFreshness.classList.add("warn");
  } else if (ageHours >= 24 * 3) {
    credentialFreshness.textContent = t("credStaleDaysShort", Math.round(ageHours / 24));
    credentialFreshness.classList.add("warn");
  } else {
    credentialFreshness.textContent = t("credVerifiedHours", Math.max(1, Math.round(ageHours)));
  }
  credentialFreshness.hidden = false;
}

function renderSettings() {
  const allow = state.proxyMode === "allowlist";
  autoConnectToggle.checked = Boolean(state.autoConnect);
  webRtcLeakToggle.checked = Boolean(state.webRtcLeakProtection);
  dnsPredictionToggle.checked = Boolean(state.dnsPredictionProtection);
  fingerprintShieldToggle.checked = Boolean(state.fingerprintShieldEnabled);
  regionShieldToggle.checked = Boolean(state.regionShieldEnabled);

  // The fingerprint shield runs independently of the tunnel, so its detail line
  // never reports a "standby" state the way the route-scoped toggles do.
  fingerprintShieldDetail.textContent = state.fingerprintShieldEnabled
    ? t("fingerprintActive")
    : t("fingerprintOff");

  const rtc = privacyStatus?.webRtc;
  if (state.webRtcLeakProtection && rtc?.supported && rtc.effective === "disable_non_proxied_udp") {
    webRtcPrivacyDetail.textContent = t("webrtcActive");
  } else if (state.webRtcLeakProtection && rtc && (rtc.levelOfControl === "controlled_by_other_extensions" || rtc.levelOfControl === "not_controllable")) {
    webRtcPrivacyDetail.textContent = t("webrtcBlocked");
  } else if (!state.webRtcLeakProtection) {
    webRtcPrivacyDetail.textContent = t("webrtcOff");
  } else {
    webRtcPrivacyDetail.textContent = t("webrtcDetailDefault");
  }

  const dns = privacyStatus?.dnsPrediction;
  if (!state.dnsPredictionProtection) {
    dnsPrivacyDetail.textContent = t("dnsOff");
  } else if (!state.enabled) {
    dnsPrivacyDetail.textContent = t("dnsStandby");
  } else if (dns?.supported && dns?.active) {
    dnsPrivacyDetail.textContent = t("dnsRouteScoped");
  } else if (state.proxyMode === "allowlist" && !state.allowlist.length) {
    dnsPrivacyDetail.textContent = t("dnsEmptyAllowlist");
  } else if (dns && dns.supported === false) {
    dnsPrivacyDetail.textContent = t("dnsUnsupported");
  } else {
    dnsPrivacyDetail.textContent = t("dnsSyncing");
  }
  const rp = regionStatus?.profile;
  if (!state.regionShieldEnabled) {
    regionShieldDetail.textContent = t("regionOff");
  } else if (!state.enabled) {
    regionShieldDetail.textContent = t("regionStandby");
  } else if (regionStatus?.active) {
    regionShieldDetail.textContent = t("regionActive");
  } else {
    regionShieldDetail.textContent = t("regionWaiting");
  }
  regionProfileText.textContent = rp
    ? t("regionProfileCurrent", countryNameFor(rp.country, rp.country), rp.locale, rp.timeZone)
    : t("regionProfilePending");
  modeAllowlist.classList.toggle("active", allow);
  modeBlacklist.classList.toggle("active", !allow);
  modeDescription.textContent = allow
    ? t("modeDescAllowlist")
    : t("modeDescBlocklist");
  listTitle.textContent = allow ? t("listTitleAllowlist") : t("listTitleBlocklist");
  const domains = managedList();
  siteCount.textContent = String(domains.length);
  domainList.innerHTML = "";
  if (!domains.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = allow ? t("listEmptyAllowlist") : t("listEmptyBlocklist");
    domainList.appendChild(empty);
  } else {
    for (const domain of domains) {
      const row = document.createElement("div");
      row.className = "domain-item";
      const label = document.createElement("span");
      label.textContent = domain;
      label.title = domain;
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = t("removeDomainTitle", domain);
      remove.addEventListener("click", () => removeDomain(domain));
      row.append(label, remove);
      domainList.appendChild(row);
    }
  }
}

async function getActiveDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/i.test(tab.url)) return "";
    return new URL(tab.url).hostname.toLowerCase();
  } catch (_) { return ""; }
}

async function refreshRegionPageDiagnostics() {
  if (!regionPageDiagText) return;
  if (!state.regionShieldEnabled) {
    regionPageDiagText.textContent = t("diagRegionOff");
    return;
  }
  if (!state.enabled) {
    regionPageDiagText.textContent = t("diagVpnOff");
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      regionPageDiagText.textContent = t("diagUnsupportedPage");
      return;
    }
    const probeText = t("diagFontProbeText");
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (probe) => {
        const test = probe;
        let fontLeak = null;
        try {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.font = "72px monospace";
            const base = ctx.measureText(test).width;
            ctx.font = '72px "Microsoft YaHei", monospace';
            const probe = ctx.measureText(test).width;
            fontLeak = Math.abs(probe - base) > 0.5;
          }
        } catch (_) {}
        return {
          language: navigator.language || "",
          languages: Array.from(navigator.languages || []),
          locale: Intl.DateTimeFormat().resolvedOptions().locale || "",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
          offset: new Date().getTimezoneOffset(),
          fontLeak
        };
      },
      args: [probeText]
    });
    if (!result) throw new Error(t("diagNoResult"));
    const expected = regionStatus?.profile;
    const langOk = !expected || String(result.language).toLowerCase() === String(expected.locale).toLowerCase();
    const tzOk = !expected || result.timeZone === expected.timeZone;
    const fontOk = result.fontLeak !== true;
    const ok = langOk && tzOk && fontOk;
    const fontText = result.fontLeak == null ? t("diagFontUnknown") : (result.fontLeak ? t("diagFontLeak") : t("diagFontMasked"));
    const suffix = ok ? t("diagOkSuffix") : t("diagPartialSuffix");
    regionPageDiagText.textContent = t("diagLine", result.language || "?", result.timeZone || "?", fontText, suffix);
  } catch (_) {
    regionPageDiagText.textContent = t("diagNotInjected");
  }
}

function adoptStatusResponse(response) {
  state = { ...state, ...(response?.state || {}) };
  helper = response?.helper || helper;
  privacyStatus = response?.privacy || privacyStatus;
  regionStatus = response?.region || regionStatus;
  return response;
}

async function reconcileAfterCommandFailure() {
  try {
    adoptStatusResponse(await send({ type: "status" }));
  } catch (_) {
    // If the background worker cannot be queried, do not leave a stale green
    // VPN state in the popup after a command has already failed open.
    state = { ...state, enabled: false };
  }
}

async function refreshStatus() {
  setBusy(true);
  connectionTransition = "loading";
  renderMain();
  showNotice(t("noticeReadingStatus"));
  // Status and locations are independent requests; run them concurrently so
  // the popup is not serialized behind two native-messaging round trips.
  // A hard deadline matters: setBusy(true) disables every control, so a promise
  // that never settles would leave the whole popup permanently unclickable.
  const locationsPromise = send({ type: "locations" }).then(
    (response) => ({ ok: true, response }),
    (error) => ({ ok: false, error })
  );
  const deadline = new Promise((resolve) => setTimeout(
    () => resolve({ ok: false, error: new Error(t("errLocationListTimeout")) }), 12000
  ));
  try {
    const response = await send({ type: "status" });
    state = { ...state, ...(response.state || {}) };
    helper = response.helper || {};
    privacyStatus = response.privacy || null;
    regionStatus = response.region || null;
    let locationWarning = "";
    // Keep a useful fallback if the server list cannot be refreshed right now.
    const locationResult = await Promise.race([locationsPromise, deadline]);
    if (locationResult.ok) {
      populateLocations(locationResult.response.locations || []);
    } else {
      populateLocations([]);
      locationWarning = t("warnLocationListStale", translateUiError(locationResult.error.message));
    }
    country.value = [...country.options].some(o => o.value === (state.country || "REC")) ? (state.country || "REC") : "REC";
    activeDomain = await getActiveDomain();
    currentSite.textContent = activeDomain || t("siteNotConfigurable");
    activeSiteUsesVpn = null;
    if (activeDomain) {
      try {
        const route = await send({ type: "routeFor", host: activeDomain });
        activeSiteUsesVpn = Boolean(route?.usesVpn);
      } catch (_) { activeSiteUsesVpn = null; }
    }
    installPath.textContent = helper.installRoot || t("installPathUnknown");
    installPath.title = helper.installRoot || "";
    credentialStatus.textContent = helper.credentials ? t("credStatusImported") : (helper.available ? t("credStatusNotSignedIn") : t("credStatusBridgeUnavailable"));
    // While the background still owes an auto-connect for this session, the
    // last error is expected to be transient. Say what is happening instead of
    // surfacing a red failure the user cannot act on.
    const autoConnectRetrying = !state.enabled && state.autoConnect && state.autoConnectPending;
    if (autoConnectRetrying) showNotice(t("noticeAutoConnectRetrying"));
    else if (response.helperError) showNotice(response.helperError, "error");
    else if (state.lastError) showNotice(state.lastError, "error");
    else if (locationWarning) showNotice(locationWarning, "error");
    else showNotice("");
    renderMain();
    renderSettings();
    applyBootstrapAvailability();
    // Reopening the popup must not orphan a login flow the host is still
    // running: resume mirroring its progress instead of showing a dead UI.
    if (helper.bootstrap?.running === true && !bootstrapPollActive) {
      showBootstrapProgress(t("noticeWaitingBrowserLogin"));
      // A reopened popup must re-offer whatever the host still waits for.
      renderBootstrapChallenge(helper.bootstrap);
      pollBootstrapStatus();
    }
    await refreshRegionPageDiagnostics();
  } catch (error) {
    showNotice(error.message, "error");
    credentialStatus.textContent = t("credStatusBridgeMissing");
  } finally {
    connectionTransition = "";
    setBusy(false);
    renderMain();
  }
}

// Last-resort guard: nothing in the popup may stay disabled. setBusy(true)
// gates every control, so a single un-awaited await used to be able to leave
// the whole panel dead with no visible cause.
setInterval(() => { if (busy) setBusy(false); }, 15000);

power.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  const next = !state.enabled;
  connectionTransition = next ? "connecting" : "disconnecting";
  renderMain();
  showNotice(next ? t("noticeConnectingService") : t("noticeDisconnecting"));
  try {
    const response = await send({ type: "toggle", enabled: next, country: country.value });
    // Verify both connect and disconnect. A successful command acknowledgement
    // is not enough if Chrome retained an extension-owned PAC or the child died
    // between the command and the UI update.
    const verified = adoptStatusResponse(await send({ type: "status" }));
    if (verified.health?.healthy !== true || Boolean(state.enabled) !== next ||
        (next && helper.running !== true)) {
      throw new Error(verified.helperError || (next
        ? t("errSocksNotKeptAlive")
        : t("errDirectNotConfirmedReload")));
    }
    if (next && response?.resolvedCountry && country.value === "REC") {
      showNotice(t("noticeConnectedRecommended", countryNameFor(response.resolvedCountry, response.resolvedCountry)), "good");
    }
    if (!(next && response?.resolvedCountry && country.value === "REC")) showNotice(next ? t("noticeConnected") : t("noticeDisconnected"), "good");
  } catch (error) {
    showNotice(error.message, "error");
    state.enabled = false;
  } finally {
    try {
      const [privacyResponse, regionResponse] = await Promise.all([
        send({ type: "privacyStatus" }),
        send({ type: "regionStatus" })
      ]);
      privacyStatus = privacyResponse.privacy || privacyStatus;
      regionStatus = regionResponse.region || regionStatus;
    } catch (_) {}
    connectionTransition = "";
    setBusy(false);
    renderMain();
    renderSettings();
    await refreshRegionPageDiagnostics();
  }
});

country.addEventListener("change", async () => {
  const selected = country.value;
  const wasEnabled = Boolean(state.enabled);
  connectionTransition = wasEnabled ? "switching" : "";
  setBusy(true);
  renderMain();
  try {
    await send({ type: "country", country: selected });
    const verified = adoptStatusResponse(await send({ type: "status" }));
    if (verified.health?.healthy !== true || (wasEnabled && (!state.enabled || helper.running !== true))) {
      throw new Error(verified.helperError || t("errCountrySwitchUnverified"));
    }
    state.country = selected;
    showNotice(state.enabled ? t("noticeCountrySwitched") : t("noticeCountrySaved"), "good");
  } catch (error) {
    showNotice(error.message, "error");
    await reconcileAfterCommandFailure();
  }
  finally { connectionTransition = ""; setBusy(false); renderMain(); renderSettings(); }
});

siteToggle.addEventListener("change", async () => {
  if (!activeDomain) return;
  const desired = siteToggle.checked;
  setBusy(true);
  try {
    const response = await send({ type: "setSiteRule", domain: activeDomain, useVpn: desired });
    state.allowlist = response.allowlist || state.allowlist;
    state.bypassSites = response.bypassSites || state.bypassSites;
    // Re-read the authoritative decision so the switch cannot render a state
    // that differs from the PAC Chrome actually installed.
    try {
      const route = await send({ type: "routeFor", host: activeDomain });
      activeSiteUsesVpn = Boolean(route?.usesVpn);
    } catch (_) { activeSiteUsesVpn = null; }
    showNotice(
      desired
        ? t("noticeSiteUsesVpn", activeDomain)
        : t("noticeSiteDirect", activeDomain),
      "good"
    );
  } catch (error) {
    showNotice(error.message, "error");
    await reconcileAfterCommandFailure();
  }
  finally { setBusy(false); renderMain(); renderSettings(); }
});

async function changeMode(mode) {
  if (busy || state.proxyMode === mode) return;
  setBusy(true);
  try {
    await send({ type: "proxyMode", mode });
    state.proxyMode = mode;
    showNotice(mode === "allowlist" ? t("noticeModeAllowlist") : t("noticeModeBlocklist"), "good");
  } catch (error) {
    showNotice(error.message, "error");
    await reconcileAfterCommandFailure();
  }
  finally { setBusy(false); renderMain(); renderSettings(); }
}
modeAllowlist.addEventListener("click", () => changeMode("allowlist"));
modeBlacklist.addEventListener("click", () => changeMode("blacklist"));

autoConnectToggle.addEventListener("change", async () => {
  const desired = autoConnectToggle.checked;
  autoConnectToggle.disabled = true;
  try {
    const response = await send({ type: "autoConnect", enabled: desired });
    state.autoConnect = Boolean(response.autoConnect);
    showNotice(state.autoConnect
      ? t("noticeAutoConnectOn")
      : t("noticeAutoConnectOff"), "good");
  } catch (error) {
    autoConnectToggle.checked = Boolean(state.autoConnect);
    showNotice(error.message, "error");
  } finally {
    autoConnectToggle.disabled = false;
  }
});


async function changePrivacyOption(option, desired) {
  const toggle = option === "webRtcLeakProtection" ? webRtcLeakToggle : dnsPredictionToggle;
  toggle.disabled = true;
  try {
    const response = await send({ type: "privacyOption", option, enabled: desired });
    state[option] = Boolean(response[option]);
    privacyStatus = response.privacy || privacyStatus;
    if (option === "webRtcLeakProtection") {
      showNotice(state.webRtcLeakProtection
        ? t("noticeWebrtcOn")
        : t("noticeWebrtcOff"), "good");
    } else {
      showNotice(state.dnsPredictionProtection
        ? (state.enabled ? t("noticeDnsOnActive") : t("noticeDnsOnStandby"))
        : t("noticeDnsOff"), "good");
    }
  } catch (error) {
    toggle.checked = Boolean(state[option]);
    showNotice(error.message, "error");
  } finally {
    toggle.disabled = false;
    renderSettings();
  }
}

webRtcLeakToggle.addEventListener("change", () => changePrivacyOption("webRtcLeakProtection", webRtcLeakToggle.checked));
dnsPredictionToggle.addEventListener("change", () => changePrivacyOption("dnsPredictionProtection", dnsPredictionToggle.checked));

fingerprintShieldToggle.addEventListener("change", async () => {
  const desired = fingerprintShieldToggle.checked;
  fingerprintShieldToggle.disabled = true;
  try {
    const response = await send({ type:"fingerprintShield", option:"enabled", value:desired });
    state.fingerprintShieldEnabled = Boolean(response.fingerprintShieldEnabled);
    showNotice(state.fingerprintShieldEnabled
      ? t("noticeFingerprintOn")
      : t("noticeFingerprintOff"), "good");
  } catch (error) {
    fingerprintShieldToggle.checked = Boolean(state.fingerprintShieldEnabled);
    showNotice(error.message, "error");
  } finally { fingerprintShieldToggle.disabled = false; renderSettings(); }
});

regionShieldToggle.addEventListener("change", async () => {
  const desired = regionShieldToggle.checked;
  regionShieldToggle.disabled = true;
  try {
    const response = await send({ type:"regionShield", option:"enabled", value:desired });
    state.regionShieldEnabled = Boolean(response.regionShieldEnabled);
    regionStatus = response.region || regionStatus;
    showNotice(state.regionShieldEnabled
      ? t("noticeRegionOn")
      : t("noticeRegionOff"), "good");
  } catch (error) {
    regionShieldToggle.checked = Boolean(state.regionShieldEnabled);
    showNotice(error.message, "error");
  } finally { regionShieldToggle.disabled = false; renderSettings(); await refreshRegionPageDiagnostics(); }
});



async function addManaged() {
  const value = domainInput.value.trim();
  if (!value) return;
  setBusy(true);
  try {
    const response = await send({ type: "addManagedDomain", domain: value });
    state.allowlist = response.allowlist || state.allowlist;
    state.bypassSites = response.bypassSites || state.bypassSites;
    domainInput.value = "";
    showNotice(t("noticeRuleAdded"), "good");
  } catch (error) {
    showNotice(error.message, "error");
    await reconcileAfterCommandFailure();
  }
  finally { setBusy(false); renderMain(); renderSettings(); }
}
addDomain.addEventListener("click", addManaged);
domainInput.addEventListener("keydown", (event) => { if (event.key === "Enter") addManaged(); });

// Rules live in chrome.storage.local, which never syncs, so moving them
// between browsers or Chrome profiles is a deliberate copy/paste step.
// The textarea stays visible so "导出 -> 粘贴 -> 导入" is one straight flow and
// the text can still be moved by hand when the clipboard is unavailable.
function setRuleImportOpen(open) {
  ruleImportPanel.hidden = !open;
  toggleRuleImport.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) setTimeout(() => ruleImportText.focus(), 0);
}
toggleRuleImport.addEventListener("click", () => setRuleImportOpen(ruleImportPanel.hidden));

// Clipboard access can be denied inside a popup document, so every copy also
// puts the text in the textarea the user can select and copy manually.
async function putText(text, successMessage) {
  ruleImportText.value = text;
  setRuleImportOpen(true);
  try {
    await navigator.clipboard.writeText(text);
    showNotice(successMessage, "good");
  } catch (_) {
    showNotice(t("noticeCopiedToBox"), "error");
  }
}

copyRules.addEventListener("click", async () => {
  setBusy(true);
  try {
    const response = await send({ type: "exportManagedDomains" });
    const domains = response.domains || [];
    if (!domains.length) {
      showNotice(state.proxyMode === "allowlist" ? t("noticeExportEmptyAllowlist") : t("noticeExportEmptyBlocklist"), "error");
      return;
    }
    const kind = response.mode === "allowlist" ? t("exportKindAllowlist") : t("exportKindBlocklist");
    const text = [t("exportHeaderTitle", kind), t("exportHeaderCount", domains.length), ...domains].join("\n");
    await putText(text, t("noticeCopiedRules", domains.length));
  } catch (error) {
    showNotice(error.message, "error");
  } finally { setBusy(false); }
});

copyFromBox.addEventListener("click", async () => {
  const text = ruleImportText.value.trim();
  if (!text) { showNotice(t("errBoxEmpty"), "error"); return; }
  try {
    await navigator.clipboard.writeText(text);
    showNotice(t("noticeBoxCopied"), "good");
  } catch (_) {
    showNotice(t("errClipboardUnavailable"), "error");
  }
});

clearRuleImport.addEventListener("click", () => {
  ruleImportText.value = "";
  ruleImportText.focus();
});

ruleImportText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) confirmRuleImport.click();
});

confirmRuleImport.addEventListener("click", async () => {
  const text = ruleImportText.value.trim();
  if (!text) { showNotice(t("errPasteRulesFirst"), "error"); return; }
  setBusy(true);
  try {
    const response = await send({ type: "importManagedDomains", text });
    state.allowlist = response.allowlist || [];
    state.bypassSites = response.bypassSites || [];
    ruleImportText.value = "";
    const kind = response.mode === "allowlist" ? t("importKindAllowlist") : t("importKindBlocklist");
    showNotice(response.added > 0
      ? t("noticeImportMerged", response.added, kind, response.total)
      : t("noticeImportNothingNew", kind, response.total), "good");
  } catch (error) {
    showNotice(error.message, "error");
  } finally { setBusy(false); renderMain(); renderSettings(); }
});

async function removeDomain(domain) {
  setBusy(true);
  try {
    const response = await send({ type: "removeManagedDomain", domain });
    state.allowlist = response.allowlist || [];
    state.bypassSites = response.bypassSites || [];
    showNotice(t("noticeRuleRemoved"), "good");
  } catch (error) {
    showNotice(error.message, "error");
    await reconcileAfterCommandFailure();
  }
  finally { setBusy(false); renderMain(); renderSettings(); }
}

function toggleSettings(force) {
  const open = force === undefined ? settingsPanel.hidden : Boolean(force);
  settingsPanel.hidden = !open;
  settingsButton.classList.toggle("open", open);
}
settingsButton.addEventListener("click", () => toggleSettings());
infoButton.addEventListener("click", () => { toggleSettings(true); settingsPanel.scrollTop = settingsPanel.scrollHeight; });

importFirefox.addEventListener("click", async () => {
  setBusy(true);
  showBootstrapMessage(t("noticeImportingFirefox"));
  try {
    const response = await send({ type: "importFirefox" });
    credentialStatus.textContent = response.accountLabel || t("credStatusImportedVerified");
    helper.credentials = true;
    showBootstrapMessage(t("noticeFirefoxImported"), "ok");
  } catch (error) { showBootstrapMessage(error.message, "bad"); }
  finally { setBusy(false); }
});

// Browser login is fire-and-poll: the host drives its own flow, the popup only
// mirrors progress and collects email/password/captcha input in-page (a console
// window garbles Chinese IME). No setBusy here on purpose — the user
// must stay able to click the same button again to cancel.
const BOOTSTRAP_STAGE_TEXT = {
  starting: () => t("bootstrapStageStarting"),
  browser: () => t("bootstrapStageBrowser"),
  waiting: () => t("bootstrapStageWaiting"),
  exchanging: () => t("bootstrapStageExchanging")
};
// Resolved lazily: the catalogue must be read after the popup document is
// alive, and a stage the host adds later must not render an empty line.
function bootstrapStageText(stage) {
  const resolve = BOOTSTRAP_STAGE_TEXT[stage];
  return typeof resolve === "function" ? resolve() : t("bootstrapWaitingLogin");
}
const BOOTSTRAP_POLL_INTERVAL_MS = 3000;
// The emailed confirmation code can take several minutes to arrive, so the
// popup must keep watching well past the browser/captcha phase.
const BOOTSTRAP_POLL_LIMIT_MS = 15 * 60 * 1000;

function setBootstrapButton(text) {
  if (bootstrapLogin) bootstrapLogin.textContent = text;
}

function showBootstrapProgress(text, kind = "") {
  if (!bootstrapProgress) return;
  bootstrapProgress.textContent = text;
  bootstrapProgress.className = `detail bootstrap-progress ${kind}`.trim();
  bootstrapProgress.hidden = !text;
}

// The global #notice banner sits at the very top of the popup, which is
// scrolled out of view once the user is looking at the settings block. Every
// login-related message therefore also lands inline, directly under the form
// the user is interacting with.
function showBootstrapMessage(text, kind = "") {
  showBootstrapProgress(text, kind);
  if (text) showNotice(text, kind === "bad" ? "error" : "");
}

function finishBootstrapPolling() {
  bootstrapPollActive = false;
  setBootstrapButton(t("browserLoginButton"));
  showBootstrapProgress("");
  renderBootstrapChallenge(null);
}

async function pollBootstrapStatus() {
  if (bootstrapPollActive) return;
  bootstrapPollActive = true;
  setBootstrapButton(t("bootstrapButtonSigningIn"));
  const startedAt = Date.now();
  while (bootstrapPollActive) {
    try {
      const response = await send({ type: "bootstrapStatus" });
      if (!bootstrapPollActive) return;
      const info = response.bootstrap || {};
      const detail = String(info.detail || "").trim();
      const stageText = bootstrapStageText(info.stage);
      showBootstrapProgress(detail || stageText);
      // Mirror whatever the host still waits for: the popup shows the code or
      // captcha input only while the host actually asks for one.
      renderBootstrapChallenge(info);
      if (info.running === false) {
        if (info.success === true) {
          helper.credentials = true;
          credentialStatus.textContent = info.accountLabel || t("credStatusSignedIn");
          renderCredentialFreshness();
          showBootstrapMessage(t("noticeLoginSuccess"), "ok");
        } else {
          showBootstrapMessage(detail || t("bootstrapIncomplete"), "bad");
        }
        finishBootstrapPolling();
        return;
      }
    } catch (error) {
      if (!bootstrapPollActive) return;
      finishBootstrapPolling();
      showBootstrapMessage(error.message, "bad");
      return;
    }
    if (Date.now() - startedAt >= BOOTSTRAP_POLL_LIMIT_MS) {
      // Hard stop: a stuck host flow must not poll the popup forever.
      finishBootstrapPolling();
      showBootstrapMessage(t("bootstrapTimeout"), "bad");
      return;
    }
    await sleepMs(BOOTSTRAP_POLL_INTERVAL_MS);
  }
}

// The host reports what it still waits for via need: null hides the area,
// "email_code" shows the 6-digit input, "captcha" swaps in the JPEG it sent.
function renderBootstrapChallenge(info) {
  const need = (info && info.running === true && info.need) || null;
  const previousNeed = bootstrapChallengeNeed;
  bootstrapChallengeNeed = need;
  if (!bootstrapChallenge) return;
  if (!need) {
    bootstrapChallenge.hidden = true;
    bootstrapCodeInput.hidden = true;
    bootstrapCaptchaInput.hidden = true;
    bootstrapCaptchaImg.hidden = true;
    return;
  }
  bootstrapChallenge.hidden = false;
  const isCaptcha = need === "captcha";
  const isTotp = need === "totp_code";
  bootstrapChallengeHint.textContent = isCaptcha
    ? t("bootstrapHintCaptcha")
    : (isTotp ? t("bootstrapHintTotp") : t("bootstrapHintEmail"));
  bootstrapCaptchaImg.hidden = !isCaptcha;
  if (isCaptcha && typeof info.captchaB64 === "string" && info.captchaB64) {
    bootstrapCaptchaImg.src = `data:image/jpeg;base64,${info.captchaB64}`;
  }
  bootstrapCodeInput.hidden = isCaptcha;
  bootstrapCaptchaInput.hidden = !isCaptcha;
  // A challenge appears below the fold of the settings panel, so without a
  // notice and a scroll it looks like the flow silently stopped after the
  // credentials were submitted. Only announce the transition, not every poll.
  if (previousNeed !== need) {
    showBootstrapMessage(isCaptcha
      ? t("bootstrapNeedCaptcha")
      : (isTotp ? t("bootstrapNeedTotp")
                : t("bootstrapNeedEmail")));
    try { bootstrapChallenge.scrollIntoView({ block: "nearest" }); } catch (_) {}
    const target = isCaptcha ? bootstrapCaptchaInput : bootstrapCodeInput;
    try { target.focus(); } catch (_) {}
  }
}

async function submitBootstrapChallenge() {
  const need = bootstrapChallengeNeed;
  const input = need === "captcha" ? bootstrapCaptchaInput : bootstrapCodeInput;
  const value = String(input?.value || "").trim();
  if (!value) {
    showBootstrapMessage(need === "captcha" ? t("bootstrapErrCaptchaEmpty") : t("bootstrapErrCodeEmpty"), "bad");
    return;
  }
  if (bootstrapChallengeSubmit.disabled) return;
  bootstrapChallengeSubmit.disabled = true;
  try {
    await send({ type: "bootstrapSubmit", value });
    // Hide only on success so a rejected answer keeps the input for a retry.
    showBootstrapProgress(t("bootstrapSubmitted"));
    if (need === "captcha") bootstrapCaptchaInput.value = "";
    else bootstrapCodeInput.value = "";
    renderBootstrapChallenge(null);
  } catch (error) {
    showBootstrapMessage(error.message, "bad");
  } finally {
    bootstrapChallengeSubmit.disabled = false;
  }
}

bootstrapChallengeSubmit.addEventListener("click", submitBootstrapChallenge);
// Enter inside either challenge input submits, matching the button.
for (const input of [bootstrapCodeInput, bootstrapCaptchaInput]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); submitBootstrapChallenge(); }
  });
}

bootstrapFormCancel.addEventListener("click", () => { bootstrapForm.hidden = true; });

// Live feedback while typing: the user should never have to press the button to
// discover that the address is not an address. Suppressed while a login flow is
// running so it cannot overwrite real progress.
for (const field of [bootstrapEmail, bootstrapPassword]) {
  field.addEventListener("input", () => {
    if (bootstrapPollActive) return;
    const email = String(bootstrapEmail.value || "").trim();
    const password = String(bootstrapPassword.value || "");
    if (email && !email.includes("@")) {
      showBootstrapProgress(t("bootstrapErrEmailAt"), "bad");
      return;
    }
    if (email.includes("@") && !password) {
      showBootstrapProgress(t("bootstrapErrPassword"), "bad");
      return;
    }
    showBootstrapProgress("");
  });
}

bootstrapStart.addEventListener("click", async () => {
  const email = String(bootstrapEmail.value || "").trim();
  const password = String(bootstrapPassword.value || "");
  if (!email || !email.includes("@") || !password) {
    showBootstrapMessage(t("bootstrapErrFormIncomplete"), "bad");
    try { bootstrapEmail.focus(); } catch (_) {}
    return;
  }
  if (bootstrapStart.disabled) return;
  bootstrapStart.disabled = true;
  // Wipe the password before awaiting the send: it must not linger in the DOM
  // while the request is in flight, nor end up in a log line or notification.
  bootstrapPassword.value = "";
  try {
    await send({ type: "bootstrapLogin", email, password });
  } catch (error) {
    bootstrapStart.disabled = false;
    showBootstrapMessage(error.message, "bad");
    return;
  }
  bootstrapStart.disabled = false;
  bootstrapForm.hidden = true;
  showBootstrapMessage(t("bootstrapOpening"));
  pollBootstrapStatus();
});

bootstrapLogin.addEventListener("click", () => {
  if (bootstrapPollActive) {
    // The button doubles as "cancel" while the flow runs; keep polling so the
    // user sees the flow actually end instead of a frozen state.
    (async () => {
      try {
        await send({ type: "bootstrapCancel" });
        showBootstrapMessage(t("bootstrapCancelRequested"));
      } catch (error) {
        finishBootstrapPolling();
        showBootstrapMessage(error.message, "bad");
      }
    })();
    return;
  }
  // Typing moves into the popup so the console's IME can no longer garble it;
  // the form is a toggle and never starts the flow by itself.
  bootstrapForm.hidden = !bootstrapForm.hidden;
});

function applyBootstrapAvailability() {
  if (!bootstrapLogin) return;
  const info = helper?.bootstrap;
  if (info && info.available === false) {
    bootstrapLogin.disabled = true;
    bootstrapLogin.title = t("bootstrapUnavailableTitle");
  } else {
    bootstrapLogin.title = helper?.credentials
      ? t("bootstrapReloginTitle")
      : t("bootstrapLoginTitle");
  }
}

usageButton.addEventListener("click", async () => {
  usageButton.disabled = true;
  usageText.textContent = t("usageQuerying");
  try { const response = await send({ type: "usage" }); usageText.textContent = formatUsageText(response.usage); }
  catch (error) { usageText.textContent = translateUiError(error.message); }
  finally { usageButton.disabled = false; }
});

openFolder.addEventListener("click", async () => { try { await send({ type: "openInstallFolder" }); } catch (error) { showNotice(error.message, "error"); } });
removeLocal.addEventListener("click", async () => {
  if (!confirm(t("confirmRemoveLocal"))) return;
  setBusy(true);
  try { await send({ type: "prepareRemoveLocal" }); showNotice(t("noticeRemovingLocal"), "good"); setTimeout(() => window.close(), 500); }
  catch (error) { showNotice(error.message, "error"); setBusy(false); }
});
fullUninstall.addEventListener("click", async () => {
  if (!confirm(t("confirmFullUninstall"))) return;
  setBusy(true);
  let token = null;
  try {
    const response = await send({ type: "prepareFullUninstall" });
    token = response.cleanupToken || null;
    await chrome.management.uninstallSelf({ showConfirmDialog: false });
  } catch (error) {
    if (token) { try { await send({ type: "cancelCleanup", token }); } catch (_) {} }
    showNotice(t("errUninstallFailed", error.message), "error");
    setBusy(false);
  }
});

refreshStatus();

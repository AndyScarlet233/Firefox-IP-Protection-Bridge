const HOST_NAME = "org.firefox_ip_protection.chrome_bridge";
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 1090;
const DEFAULT_STATE = {
  autoConnect: false,
  webRtcLeakProtection: true,
  dnsPredictionProtection: true,
  regionShieldEnabled: true,
  country: "REC",
  proxyMode: "allowlist",
  allowlist: [],
  bypassSites: [],
  lastError: "",
  runtimeStateSchema: 1
};

// Some services are not a single hostname. Their page, API, images and media
// live on several vendor-owned domains. A user-facing "site bypass" should
// therefore bypass the whole first-party site family, not only www.example.com.
// Keep this list conservative: shared third-party CDNs are excluded unless the
// hostname is clearly dedicated to the service.
const SITE_FAMILIES = {
  // Core first-party domains used by ChatGPT. Third-party analytics/payment/CDN
  // providers are intentionally not included.
  "chatgpt.com": [
    "chatgpt.com",
    "openai.com",
    "oaistatic.com",
    "oaiusercontent.com",
    "oaistatsig.com",
    "openaimerge.com"
  ],
  // Anthropic documents these domains as Claude/Anthropic service endpoints.
  "claude.ai": [
    "claude.ai",
    "claude.com",
    "anthropic.com"
  ],
  "bilibili.com": [
    "bilibili.com",
    "biliapi.com",
    "biliapi.net",
    "biliimg.com",
    "bilicdn1.com",
    "bilivideo.com",
    "bilivideo.cn",
    "bilivideo.net",
    "bilibilivideo.com",
    "hdslb.com",
    "hdslb.net",
    "acg.tv",
    "acgvideo.com",
    "b23.tv",
    "bigfun.cn",
    "bigfunapp.cn",
    "biligame.cn",
    "biligame.com",
    "biligame.net",
    "bilibili.tv",
    "bilibili.co",
    "bilicomic.com",
    "bilicomics.com",
    "im9.com",
    "smtcdns.net",
    "upos-hz-mirrorakam.akamaized.net"
  ]
};

const SITE_FAMILY_ALIASES = {
  "www.bilibili.com": "bilibili.com",
  "chat.openai.com": "chatgpt.com",
  "www.chatgpt.com": "chatgpt.com",
  "claude.com": "claude.ai",
  "www.claude.com": "claude.ai",
  "www.claude.ai": "claude.ai"
};

function normalizeProxyMode(value) {
  if (value === "blacklist" || value === "all") return "blacklist";
  return "allowlist";
}

let nativePort = null;
let nextRequestId = 1;
const pending = new Map();

// Proxy ownership is a process-wide side effect, while MV3 event handlers can
// arrive concurrently (popup actions, startup, window close and native-host
// disconnect). Serialize lifecycle changes and advance the generation as soon
// as a newer operation is requested. A stale start must never install a PAC
// after a newer stop or restart has already been requested.
let lifecycleQueue = Promise.resolve();
let lifecycleGeneration = 0;
const expectedNativeDisconnects = new WeakSet();

function queueOperation(operation, { invalidateLifecycle = false } = {}) {
  const generation = invalidateLifecycle ? ++lifecycleGeneration : lifecycleGeneration;
  const task = lifecycleQueue.catch(() => {}).then(() => operation(generation));
  lifecycleQueue = task.catch(() => {});
  return task;
}

function queueLifecycleOperation(operation) {
  return queueOperation(operation, { invalidateLifecycle: true });
}

function queueStateOperation(operation) {
  return queueOperation(operation);
}

function isCurrentLifecycleGeneration(generation) {
  return generation === lifecycleGeneration;
}

function disconnectNativePort(port = nativePort) {
  if (!port) return;
  expectedNativeDisconnects.add(port);
  if (nativePort === port) nativePort = null;
  try { port.disconnect(); } catch (_) {}
}

function translateBridgeError(message = "") {
  const text = String(message || "").trim();
  if (!text) return "";
  const replacements = [
    [/Specified native messaging host not found\.?/i, "未找到本地桥接程序。请运行 INSTALL-OR-REPAIR.cmd 修复本地桥接；修复后扩展目录可以移动或改名。"],
    [/Error when communicating with the native messaging host\.?/i, "与本地桥接程序通信失败。请确认已安装 runtime\\vpn_bridge_host.exe，并运行 INSTALL-OR-REPAIR.cmd 修复后重启浏览器。"],
    [/Access to the specified native messaging host is forbidden\.?/i, "Chrome 无权访问本地桥接程序。请确认扩展已由当前安装脚本注册。"],
    [/Native host has exited\.?/i, "本地桥接程序已退出。"],
    [/Native bridge returned no response/i, "本地桥接程序没有返回结果。"],
    [/Native bridge timeout while running (.+)/i, (_, cmd) => `本地桥接程序执行 ${cmd} 时超时。`],
    [/Native bridge disconnected/i, "本地桥接程序已断开连接。"],
    [/Chrome proxy is controlled by another extension or policy\.?/i, "Chrome 代理正被其他扩展或管理员策略控制。"]
  ];
  for (const [pattern, replacement] of replacements) {
    const match = text.match(pattern);
    if (match) return typeof replacement === "function" ? replacement(...match) : replacement;
  }
  return text
    .replace(/\bNative bridge\b/g, "本地桥接程序")
    .replace(/\bhelper\b/gi, "桥接程序")
    .replace(/\bFirefox IP Protection\b/g, "Firefox IP 保护");
}

function normalizeDomain(input) {
  let value = String(input || "").trim().toLowerCase();
  if (!value) throw new Error("请输入网站域名。");
  value = value.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
  try {
    if (value.includes("://") || value.includes("/") || value.includes(":") || value.includes("?")) {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      value = url.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
    } else {
      const url = new URL(`https://${value}`);
      value = url.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
    }
  } catch (_) {
    throw new Error("这个网站地址看起来无效。");
  }
  if (!value || value.length > 253 || value.includes(" ")) throw new Error("这个网站地址看起来无效。");
  return value;
}

function normalizeDomainArray(values) {
  const result = [];
  for (const item of Array.isArray(values) ? values : []) {
    try {
      const domain = normalizeDomain(item);
      if (!result.includes(domain)) result.push(domain);
    } catch (_) {}
  }
  return result.sort();
}

function canonicalManagedDomain(input) {
  const domain = normalizeDomain(input);
  return SITE_FAMILY_ALIASES[domain] || domain;
}

function normalizeManagedDomainArray(values) {
  const result = [];
  for (const item of Array.isArray(values) ? values : []) {
    try {
      const domain = canonicalManagedDomain(item);
      if (!result.includes(domain)) result.push(domain);
    } catch (_) {}
  }
  return result.sort();
}

function expandRouteDomains(values) {
  const managed = normalizeManagedDomainArray(values);
  const expanded = new Set(managed);
  for (const rule of managed) {
    const family = SITE_FAMILIES[rule];
    if (family) for (const domain of family) expanded.add(domain);
  }
  return [...expanded].sort();
}

function routeUsesVpnForState(state, hostInput) {
  let host = "";
  try { host = normalizeDomain(hostInput); } catch (_) { return false; }
  const mode = normalizeProxyMode(state.proxyMode);
  const routed = mode === "allowlist" ? state.allowlist : state.bypassSites;
  const matched = listCoversHost(expandRouteDomains(routed), host);
  return mode === "allowlist" ? matched : !matched;
}

function hostnameFromUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.hostname.toLowerCase();
  } catch (_) { return ""; }
}

function ruleCoversHost(rule, host) {
  return host === rule || host.endsWith(`.${rule}`);
}

function listCoversHost(list, host) {
  return normalizeDomainArray(list).some((rule) => ruleCoversHost(rule, host));
}

async function getStoredState() {
  const [data, runtime] = await Promise.all([
    chrome.storage.local.get(DEFAULT_STATE),
    chrome.storage.session.get({ enabled: false, resolvedCountry: "" })
  ]);
  return {
    enabled: Boolean(runtime.enabled),
    autoConnect: Boolean(data.autoConnect),
    webRtcLeakProtection: data.webRtcLeakProtection !== false,
    dnsPredictionProtection: data.dnsPredictionProtection !== false,
    regionShieldEnabled: data.regionShieldEnabled !== false,
    resolvedCountry: String(runtime.resolvedCountry || ""),
    country: data.country || "REC",
    proxyMode: normalizeProxyMode(data.proxyMode),
    allowlist: normalizeManagedDomainArray(data.allowlist),
    bypassSites: normalizeManagedDomainArray(data.bypassSites),
    lastError: String(data.lastError || "")
  };
}

async function saveState(patch) {
  const persistent = { ...patch };
  const sessionPatch = {};
  if (Object.prototype.hasOwnProperty.call(persistent, "enabled")) {
    sessionPatch.enabled = Boolean(persistent.enabled);
    delete persistent.enabled;
  }
  if (Object.prototype.hasOwnProperty.call(persistent, "resolvedCountry")) {
    sessionPatch.resolvedCountry = String(persistent.resolvedCountry || "");
    delete persistent.resolvedCountry;
  }
  if (Object.keys(sessionPatch).length) await chrome.storage.session.set(sessionPatch);
  if (Object.keys(persistent).length) await chrome.storage.local.set(persistent);
}

function connectNative() {
  if (nativePort) return Promise.resolve(nativePort);
  return new Promise((resolve, reject) => {
    try {
      const port = chrome.runtime.connectNative(HOST_NAME);
      nativePort = port;
      port.onMessage.addListener((message) => {
        if (!message || typeof message !== "object") return;
        const id = message.id;
        if (id !== undefined && pending.has(id)) {
          const waiter = pending.get(id);
          if (waiter.port && waiter.port !== port) return;
          const { resolve: ok, reject: bad, timer } = waiter;
          pending.delete(id);
          clearTimeout(timer);
          if (message.ok === false) bad(new Error(translateBridgeError(message.error || "本地桥接程序出错。")));
          else ok(message);
        }
      });
      port.onDisconnect.addListener(() => {
        const err = translateBridgeError(chrome.runtime.lastError?.message || "Native bridge disconnected");
        const expected = expectedNativeDisconnects.has(port);
        const isCurrentPort = nativePort === port;
        expectedNativeDisconnects.delete(port);
        if (isCurrentPort) nativePort = null;
        for (const [id, waiter] of pending) {
          if (waiter.port && waiter.port !== port) continue;
          clearTimeout(waiter.timer);
          pending.delete(id);
          waiter.reject(new Error(err));
        }
        if (expected || !isCurrentPort) return;

        // An unexpected Native Messaging disconnect invalidates any in-flight
        // lifecycle operation and is itself serialized with start/stop. This
        // closes a stale PAC even when Chrome never reports the child exit via
        // the popup or a browser-startup event.
        queueLifecycleOperation(async () => {
          const state = await getStoredState();
          if (!state.enabled) {
            await clearChromeProxy();
            return { ok: true, recovered: false };
          }
          await failOpenNow(err, { stopNative: false });
          return { ok: true, recovered: true };
        }).catch(() => {});
      });
      resolve(port);
    } catch (error) {
      nativePort = null;
      reject(error);
    }
  });
}

async function nativeRequest(command, payload = {}, timeoutMs = 120000, retryPost = true) {
  const port = await connectNative();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // A timed-out persistent host is no longer trustworthy. Disconnecting it
      // prevents a late response from applying an old lifecycle command.
      if (nativePort === port) disconnectNativePort(port);
      reject(new Error(translateBridgeError(`Native bridge timeout while running ${command}`)));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, port });
    try {
      port.postMessage({ id, command, ...payload });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      if (nativePort === port) disconnectNativePort(port);
      if (retryPost) {
        nativeRequest(command, payload, timeoutMs, false).then(resolve, reject);
      } else {
        reject(error);
      }
    }
  });
}

async function nativeOneShot(command, payload = {}, timeoutMs = 120000) {
  const message = { id: nextRequestId++, command, ...payload };
  const request = chrome.runtime.sendNativeMessage(HOST_NAME, message).then((response) => {
    if (!response) throw new Error(translateBridgeError("Native bridge returned no response"));
    if (response.ok === false) throw new Error(translateBridgeError(response.error || "本地桥接程序出错。"));
    return response;
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(translateBridgeError(`Native bridge timeout while running ${command}`))), timeoutMs);
  });
  return Promise.race([request, timeout]);
}

async function requestForCurrentState(command, payload = {}, timeoutMs = 120000) {
  const state = await getStoredState();
  return state.enabled ? nativeRequest(command, payload, timeoutMs) : nativeOneShot(command, payload, timeoutMs);
}


function privacyControlBlocked(details) {
  return details?.levelOfControl === "controlled_by_other_extensions" ||
    details?.levelOfControl === "not_controllable";
}

async function setPrivacyChromeSetting(setting, value, label) {
  if (!setting?.get || !setting?.set) {
    throw new Error(`${label}：当前 Chrome 不支持此隐私设置。`);
  }
  const details = await setting.get({});
  if (privacyControlBlocked(details)) {
    throw new Error(`${label}无法修改：该设置正被其他扩展或管理员策略控制。`);
  }
  await setting.set({ value, scope: "regular" });
  return setting.get({});
}

async function clearPrivacyChromeSetting(setting) {
  if (!setting?.get || !setting?.clear) return null;
  const details = await setting.get({});
  if (details?.levelOfControl === "controlled_by_this_extension") {
    await setting.clear({ scope: "regular" });
  }
  return setting.get({});
}

async function applyWebRtcLeakProtection(enabled) {
  const setting = chrome.privacy?.network?.webRTCIPHandlingPolicy;
  if (!setting) return { supported: false, effective: null, levelOfControl: "not_controllable" };
  if (enabled) {
    const details = await setPrivacyChromeSetting(setting, "disable_non_proxied_udp", "WebRTC 防泄漏");
    return { supported: true, effective: details.value, levelOfControl: details.levelOfControl };
  }
  const details = await clearPrivacyChromeSetting(setting);
  return { supported: true, effective: details?.value ?? null, levelOfControl: details?.levelOfControl ?? "controllable_by_this_extension" };
}

async function clearLegacyGlobalDnsPredictionOverride() {
  try { await clearPrivacyChromeSetting(chrome.privacy?.network?.networkPredictionEnabled); } catch (_) {}
}

const DNS_PREFETCH_RULE_ID = 91002;

async function clearDnsPrefetchRule() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [DNS_PREFETCH_RULE_ID] }); } catch (_) {}
}

function routedRequestConditionForState(state, resourceTypes = null) {
  const mode = normalizeProxyMode(state.proxyMode);
  const condition = { regexFilter: "^https?://" };
  if (Array.isArray(resourceTypes) && resourceTypes.length) condition.resourceTypes = resourceTypes;
  if (mode === "allowlist") {
    const requestDomains = expandRouteDomains(state.allowlist);
    if (!requestDomains.length) return null;
    condition.requestDomains = requestDomains;
  } else {
    const excludedRequestDomains = expandRouteDomains(state.bypassSites);
    if (excludedRequestDomains.length) condition.excludedRequestDomains = excludedRequestDomains;
  }
  return condition;
}

async function applyDnsPredictionProtection(enabled, state) {
  // v0.6.x used chrome.privacy.networkPredictionEnabled, which is Chrome-wide.
  // Always release that legacy override. Route-scoped protection now uses the
  // per-document X-DNS-Prefetch-Control response header instead, so DIRECT pages
  // keep Chrome's normal DNS prefetch/preconnect acceleration.
  await clearLegacyGlobalDnsPredictionOverride();
  const supported = Boolean(chrome.declarativeNetRequest?.updateDynamicRules);
  if (!supported || !enabled || !state?.enabled) {
    await clearDnsPrefetchRule();
    return { supported, active: false, effective: null, levelOfControl: supported ? "controlled_by_this_extension" : "not_controllable" };
  }
  const condition = routedRequestConditionForState(state, ["main_frame", "sub_frame"]);
  if (!condition) {
    await clearDnsPrefetchRule();
    return { supported: true, active: false, effective: null, levelOfControl: "controlled_by_this_extension" };
  }
  const rule = {
    id: DNS_PREFETCH_RULE_ID,
    priority: 2,
    action: {
      type: "modifyHeaders",
      responseHeaders: [{ header: "x-dns-prefetch-control", operation: "set", value: "off" }]
    },
    condition
  };
  // Replace the rule in one update so a transient add failure does not leave a
  // half-updated route (and a transient remove failure cannot create a duplicate).
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule], removeRuleIds: [DNS_PREFETCH_RULE_ID] });
  return { supported: true, active: true, effective: "route_scoped", levelOfControl: "controlled_by_this_extension" };
}

async function syncPrivacySettings(stateOverride = null) {
  const state = stateOverride || await getStoredState();
  const result = { webRtc: null, dnsPrediction: null, errors: [] };
  try {
    result.webRtc = await applyWebRtcLeakProtection(Boolean(state.webRtcLeakProtection));
  } catch (error) {
    result.errors.push(error.message);
  }
  try {
    result.dnsPrediction = await applyDnsPredictionProtection(Boolean(state.dnsPredictionProtection), state);
  } catch (error) {
    result.errors.push(error.message);
  }
  return result;
}

async function getPrivacyStatus(stateOverride = null) {
  const state = stateOverride || await getStoredState();
  const result = {
    webRtc: { requested: Boolean(state.webRtcLeakProtection), supported: false, effective: null, levelOfControl: "not_controllable" },
    dnsPrediction: { requested: Boolean(state.dnsPredictionProtection), active: false, supported: Boolean(chrome.declarativeNetRequest?.getDynamicRules), effective: null, levelOfControl: chrome.declarativeNetRequest?.getDynamicRules ? "controlled_by_this_extension" : "not_controllable" }
  };
  try {
    const setting = chrome.privacy?.network?.webRTCIPHandlingPolicy;
    if (setting?.get) {
      const details = await setting.get({});
      result.webRtc = { ...result.webRtc, supported: true, effective: details.value, levelOfControl: details.levelOfControl };
    }
  } catch (_) {}
  try {
    if (chrome.declarativeNetRequest?.getDynamicRules) {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const active = rules.some((rule) => rule.id === DNS_PREFETCH_RULE_ID);
      result.dnsPrediction = { ...result.dnsPrediction, supported: true, active, effective: active ? "route_scoped" : null };
    }
  } catch (_) {}
  return result;
}

async function setPrivacyOptionNow(option, enabled) {
  const state = await getStoredState();
  if (option === "webRtcLeakProtection") {
    await applyWebRtcLeakProtection(Boolean(enabled));
    await saveState({ webRtcLeakProtection: Boolean(enabled) });
    return { ok: true, webRtcLeakProtection: Boolean(enabled), privacy: await getPrivacyStatus({ ...state, webRtcLeakProtection: Boolean(enabled) }) };
  }
  if (option === "dnsPredictionProtection") {
    const next = { ...state, dnsPredictionProtection: Boolean(enabled) };
    await applyDnsPredictionProtection(Boolean(enabled), next);
    await saveState({ dnsPredictionProtection: Boolean(enabled) });
    return { ok: true, dnsPredictionProtection: Boolean(enabled), privacy: await getPrivacyStatus(next) };
  }
  throw new Error("未知的隐私设置。");
}

async function clearAllPrivacyOverrides() {
  try { await clearPrivacyChromeSetting(chrome.privacy?.network?.webRTCIPHandlingPolicy); } catch (_) {}
  await clearLegacyGlobalDnsPredictionOverride();
  await clearDnsPrefetchRule();
}


const REGION_HEADER_RULE_ID = 91001;
const REGION_TZ = {
  AT:"Europe/Vienna", AU:"Australia/Sydney", BE:"Europe/Brussels", BG:"Europe/Sofia",
  CA:"America/Toronto", CH:"Europe/Zurich", CL:"America/Santiago", CO:"America/Bogota",
  DE:"Europe/Berlin", DK:"Europe/Copenhagen", ES:"Europe/Madrid", FI:"Europe/Helsinki",
  FR:"Europe/Paris", GB:"Europe/London", HK:"Asia/Hong_Kong", IE:"Europe/Dublin",
  IT:"Europe/Rome", JP:"Asia/Tokyo", MX:"America/Mexico_City", MY:"Asia/Kuala_Lumpur",
  NL:"Europe/Amsterdam", NO:"Europe/Oslo", NZ:"Pacific/Auckland", PL:"Europe/Warsaw",
  PT:"Europe/Lisbon", SE:"Europe/Stockholm", SG:"Asia/Singapore", TH:"Asia/Bangkok",
  TW:"Asia/Taipei", US:"America/New_York", ZA:"Africa/Johannesburg"
};
function regionProfileForState(state) {
  const raw = String(state.resolvedCountry || (state.country !== "REC" ? state.country : "US") || "US").toUpperCase();
  const country = /^[A-Z]{2}$/.test(raw) ? raw : "US";
  const locale = `en-${country}`;
  return { country, locale, languages:[locale, "en"], timeZone: REGION_TZ[country] || "America/New_York" };
}
function regionShieldIsActive(state) { return Boolean(state.regionShieldEnabled && state.enabled); }

function regionContentConfigForState(state, host = "") {
  const routedThroughVpn = host ? routeUsesVpnForState(state, host) : true;
  return { active: Boolean(regionShieldIsActive(state) && routedThroughVpn), profile: regionProfileForState(state) };
}

async function broadcastRegionContentConfig(state) {
  const fallback = regionContentConfigForState(state);
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => {
        const host = hostnameFromUrl(tab.url);
        const config = regionContentConfigForState(state, host);
        return chrome.tabs.sendMessage(tab.id, { type: "regionConfigPush", config }).catch(() => null);
      }));
  } catch (_) {}
  return fallback;
}
async function clearRegionHeaderRule() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds:[REGION_HEADER_RULE_ID] }); } catch (_) {}
}
async function syncRegionHeaderRule(state) {
  if (!regionShieldIsActive(state)) {
    await clearRegionHeaderRule();
    return;
  }
  const profile = regionProfileForState(state);
  const condition = routedRequestConditionForState(state);
  if (!condition) {
    await clearRegionHeaderRule();
    return;
  }
  const rule = {
    id: REGION_HEADER_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header:"accept-language", operation:"set", value:`${profile.locale},en;q=0.9` }]
    },
    condition
  };
  // Atomic replacement keeps the previous valid rule if Chrome rejects the
  // new condition, instead of creating a silent protection gap.
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules:[rule], removeRuleIds:[REGION_HEADER_RULE_ID] });
}
async function syncRegionGeolocation(state) {
  if (!chrome.contentSettings?.location) return;
  await chrome.contentSettings.location.clear({ scope:"regular" });
  if (!regionShieldIsActive(state)) return;
  await chrome.contentSettings.location.set({ primaryPattern:"<all_urls>", setting:"block", scope:"regular" });
}
async function syncRegionShield(stateOverride=null) {
  const state = stateOverride || await getStoredState();
  const errors = [];
  try { await syncRegionHeaderRule(state); } catch (e) { errors.push(`语言请求头：${e.message}`); }
  try { await syncRegionGeolocation(state); } catch (e) { errors.push(`地理定位：${e.message}`); }
  // Push the session-dependent state to already-open pages immediately.
  // `enabled` and `resolvedCountry` live in storage.session, which content
  // scripts cannot reliably observe directly. Without this push, a tab that
  // was opened before VPN activation would remain in active=false forever.
  await broadcastRegionContentConfig(state);
  return { active:regionShieldIsActive(state), profile:regionProfileForState(state), errors };
}
async function setRegionShieldOptionNow(option, value) {
  if (option !== "enabled") throw new Error("未知的区域隐私保护设置。");
  const state = await getStoredState();
  const regionShieldEnabled = Boolean(value);
  const next = { ...state, regionShieldEnabled };
  try {
    const region = await syncRegionShield(next);
    if (region.errors?.length) throw new Error(region.errors.join("；"));
    await saveState({ regionShieldEnabled });
    return { ok:true, regionShieldEnabled, region };
  } catch (error) {
    // Restore the previously committed profile/rules before surfacing the
    // failure, so storage and the browser's actual protections stay aligned.
    await syncRegionShield(state).catch(() => {});
    throw error;
  }
}
async function regionContentConfig(host = "") {
  const state = await getStoredState();
  return regionContentConfigForState(state, host);
}
async function clearAllRegionShieldOverrides() {
  await clearRegionHeaderRule();
  try { await chrome.contentSettings?.location?.clear({ scope:"regular" }); } catch (_) {}
}

async function proxyControlInfo() {
  return chrome.proxy.settings.get({ incognito: false });
}

function sleepMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const PROXY_SETTLE_TIMEOUT_MS = 2200;
const PROXY_SETTLE_INTERVAL_MS = 80;

async function readProxyControlInfoWithRetry(attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await proxyControlInfo(); }
    catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleepMs(60 * (attempt + 1));
    }
  }
  throw lastError || new Error("无法读取 Chrome 代理状态。");
}

async function waitForProxyCondition(predicate, timeoutMs = PROXY_SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await proxyControlInfo();
      if (predicate(last)) return last;
    } catch (_) {}
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleepMs(Math.min(PROXY_SETTLE_INTERVAL_MS, remaining));
  }
  try {
    last = await proxyControlInfo();
    if (predicate(last)) return last;
  } catch (_) {}
  return last;
}

function pacForState(state) {
  const mode = normalizeProxyMode(state.proxyMode);
  const domains = mode === "allowlist" ? state.allowlist : state.bypassSites;
  const encoded = JSON.stringify(expandRouteDomains(domains));
  const proxy = `SOCKS5 ${PROXY_HOST}:${PROXY_PORT}`;
  return `
function FindProxyForURL(url, host) {
  host = (host || "").toLowerCase();
  if (!host || isPlainHostName(host) || host === "localhost" || host === "127.0.0.1" || host === "::1") return "DIRECT";
  var domains = ${encoded};
  var matched = false;
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (host === d || dnsDomainIs(host, "." + d)) { matched = true; break; }
  }
  if (${JSON.stringify(mode)} === "allowlist") return matched ? ${JSON.stringify(proxy)} : "DIRECT";
  return matched ? "DIRECT" : ${JSON.stringify(proxy)};
}`.trim();
}

function proxyIsOwnedPac(info) {
  return info?.levelOfControl === "controlled_by_this_extension" && info?.value?.mode === "pac_script";
}

function proxyMatchesPac(info, pacData) {
  if (!proxyIsOwnedPac(info)) return false;
  const actual = info?.value?.pacScript?.data;
  // Some Chromium builds omit pacScript.data from get(); ownership is still a
  // useful postcondition there. When it is exposed, require the new PAC so an
  // old route cannot win a start/route-update race.
  return typeof actual !== "string" || actual === pacData;
}

async function applyChromeProxy(stateOverride = null) {
  const current = await readProxyControlInfoWithRetry();
  if (current.levelOfControl === "controlled_by_other_extensions" || current.levelOfControl === "not_controllable") {
    throw new Error("Chrome 代理正被另一个扩展或管理员策略控制。");
  }
  const state = stateOverride || await getStoredState();
  const pacData = pacForState(state);
  const config = {
    mode: "pac_script",
    pacScript: {
      mandatory: true,
      data: pacData
    }
  };
  await chrome.proxy.settings.set({ value: config, scope: "regular" });
  const applied = await waitForProxyCondition((info) => proxyMatchesPac(info, pacData));
  if (!proxyMatchesPac(applied, pacData)) {
    throw new Error("Chrome 代理设置未及时生效，请重试。");
  }
}

async function clearChromeProxy() {
  // Fail-open must win over everything else, but never overwrite another
  // extension or administrator policy when Chrome cannot tell us who owns
  // the setting. Mutate only after positive ownership confirmation, then poll
  // until the old localhost PAC is gone from Chrome's network service.
  let current;
  try { current = await readProxyControlInfoWithRetry(); }
  catch (_) { return { ok: false, verified: false, owned: true, error: "无法读取 Chrome 代理状态。" }; }

  if (current?.levelOfControl !== "controlled_by_this_extension") {
    return { ok: true, verified: true, owned: false, levelOfControl: current?.levelOfControl || "unknown" };
  }

  const direct = { value: { mode: "direct" }, scope: "regular" };
  try { await chrome.proxy.settings.set(direct); }
  catch (_) {}
  let after = await waitForProxyCondition((info) => !proxyIsOwnedPac(info), 1100);

  // Clear the extension-owned direct value as well, but only while ownership is
  // still ours. If another extension takes control, stop mutating immediately.
  if (after && after.levelOfControl === "controlled_by_this_extension" && !proxyIsOwnedPac(after)) {
    try { await chrome.proxy.settings.clear({ scope: "regular" }); }
    catch (_) {}
    after = await waitForProxyCondition((info) => !proxyIsOwnedPac(info), 700);
  }

  // A Chromium network-service race can re-publish the previous PAC after the
  // first write. One final DIRECT write is safe only while we still own it.
  if (proxyIsOwnedPac(after)) {
    try { await chrome.proxy.settings.set(direct); }
    catch (_) {}
    after = await waitForProxyCondition((info) => !proxyIsOwnedPac(info), 900);
  }

  if (!after) {
    return { ok: false, verified: false, owned: true, error: "无法确认 Chrome 代理是否已恢复直连。" };
  }
  const owned = proxyIsOwnedPac(after);
  return {
    ok: !owned,
    verified: true,
    owned,
    levelOfControl: after?.levelOfControl || "unknown",
    value: after?.value || null
  };
}

async function updateAction(enabled, proxyMode = "allowlist") {
  try {
    await chrome.action.setBadgeText({ text: enabled ? "VPN" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#00a400" : "#737373" });
    await chrome.action.setTitle({ title: enabled ? `VPN 已开启 · ${normalizeProxyMode(proxyMode) === "allowlist" ? "白名单" : "黑名单"}` : "VPN 已关闭" });
  } catch (_) {}
}

async function waitForNativePortRelease(timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await nativeOneShot("status", {}, 2500);
      if (response?.status?.portOpen !== true) return true;
    } catch (_) {
      // If a one-shot host cannot be started, there is no reliable way to
      // inspect the old process. Keep polling until the bounded deadline.
    }
    await sleepMs(250);
  }
  return false;
}

async function stopNativeHelper(timeoutMs = 6000) {
  const port = nativePort;
  if (!port) return true;
  try { await nativeRequest("stop", {}, timeoutMs); } catch (_) {}
  if (nativePort === port) disconnectNativePort(port);
  return waitForNativePortRelease(Math.max(9000, timeoutMs));
}

async function failOpenNow(reason = "", { stopNative = true } = {}) {
  let current;
  try { current = await getStoredState(); }
  catch (_) { current = { ...DEFAULT_STATE, enabled: true, resolvedCountry: "" }; }
  const message = String(reason || "").trim();
  // Restore DIRECT before persisting state or stopping anything. Storage can be
  // unavailable during browser shutdown, but a dead SOCKS listener must never
  // remain the browser's only route.
  let proxyCleanup = null;
  try { proxyCleanup = await clearChromeProxy(); }
  catch (_) { proxyCleanup = { ok: false, verified: false, owned: true }; }
  let storageError = "";
  try {
    await saveState({
      enabled: false,
      resolvedCountry: "",
      lastError: message || current.lastError || ""
    });
  } catch (error) {
    storageError = String(error?.message || "无法保存 VPN 状态。");
  }
  let offState = { ...current, enabled: false, resolvedCountry: "" };
  try { offState = { ...(await getStoredState()), enabled: false, resolvedCountry: "" }; }
  catch (_) {}
  await Promise.allSettled([
    syncRegionShield(offState),
    syncPrivacySettings(offState)
  ]);
  await updateAction(false, offState.proxyMode);
  if (stopNative) await stopNativeHelper();
  let finalCleanup = proxyCleanup;
  try { finalCleanup = await clearChromeProxy(); }
  catch (_) {}
  if (storageError && !message) offState.lastError = storageError;
  return { ...offState, proxyCleanup: finalCleanup };
}

async function startVpnNow(country, generation) {
  if (!isCurrentLifecycleGeneration(generation)) return { ok: true, superseded: true };
  const selected = country || "REC";
  try {
    // Always bootstrap the localhost helper while Chrome is direct. Only install the
    // PAC script after the SOCKS listener has reported ready. This prevents a stale
    // localhost proxy from black-holing startup traffic.
    const cleanup = await clearChromeProxy();
    if (!cleanup?.ok) throw new Error(cleanup?.error || "无法确认 Chrome 已恢复直连。");
    await saveState({ enabled: false, resolvedCountry: "", country: selected, lastError: "" });
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    const response = await nativeRequest("start", { country: selected }, 180000);
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }

    // Confirm the helper still owns a live listener immediately before the PAC is
    // installed. A TCP port can remain open briefly after the child has failed, so
    // status is a second liveness check rather than trusting start() alone.
    const helperCheck = await nativeRequest("status", {}, 15000);
    const helperHealthy = helperCheck?.status?.healthy === undefined
      ? helperCheck?.status?.running === true
      : helperCheck.status.healthy === true;
    if (helperCheck?.status?.running !== true || !helperHealthy) {
      throw new Error("本地 SOCKS5 代理启动后未通过上游连接检查。");
    }
    const state = await getStoredState();
    const nextState = { ...state, enabled: true, country: selected, lastError: "" };
    // SOCKS5 is ready. Install route-scoped DNS prefetch protection (when requested)
    // before installing the PAC proxy, then switch browser traffic to the tunnel.
    await syncPrivacySettings(nextState);
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    await applyChromeProxy(nextState);
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    const resolvedCountry = String(response?.resolvedCountry || (selected !== "REC" ? selected : ""));
    await saveState({ enabled: true, resolvedCountry, country: selected, lastError: "" });
    await syncRegionShield({ ...nextState, resolvedCountry });
    await updateAction(true, nextState.proxyMode);
    return response;
  } catch (error) {
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    // Failure during startup must become DIRECT immediately; do not wait for the
    // helper to acknowledge a stop before restoring browser connectivity.
    await failOpenNow(error.message, { stopNative: true });
    throw error;
  }
}

async function stopVpnNow() {
  // Restore DIRECT first. State persistence may fail during browser shutdown,
  // but it must not prevent proxy cleanup or helper termination.
  let firstCleanup = null;
  try { firstCleanup = await clearChromeProxy(); }
  catch (_) { firstCleanup = { ok: false, verified: false, owned: true }; }
  try { await saveState({ enabled: false, resolvedCountry: "", lastError: "" }); }
  catch (_) {}
  let offState = { ...DEFAULT_STATE, enabled: false, resolvedCountry: "" };
  try { offState = { ...(await getStoredState()), enabled: false, resolvedCountry: "" }; }
  catch (_) {}
  await Promise.allSettled([
    syncRegionShield(offState),
    syncPrivacySettings(offState)
  ]);
  await updateAction(false, offState.proxyMode);
  const nativeStopped = await stopNativeHelper(6000);
  let finalCleanup = null;
  try { finalCleanup = await clearChromeProxy(); }
  catch (_) { finalCleanup = { ok: false, verified: false, owned: true }; }
  if (!firstCleanup?.ok || !finalCleanup?.ok || nativeStopped === false) {
    return { ok: false, error: nativeStopped === false
      ? "本地代理进程仍在释放，请稍后重试关闭或重新加载扩展。"
      : "无法确认 Chrome 已恢复直连，请重新加载扩展或重启 Chrome。" };
  }
  return { ok: true };
}

async function changeCountryNow(country, generation) {
  if (!isCurrentLifecycleGeneration(generation)) return { ok: true, superseded: true };
  const selected = country || "REC";
  try {
    const state = await getStoredState();
    if (!state.enabled) {
      const cleanup = await clearChromeProxy();
      if (!cleanup?.ok) throw new Error(cleanup?.error || "无法确认 Chrome 已恢复直连。");
      await saveState({ country: selected });
      return { ok: true, restarted: false };
    }

    // Disable the old route only after DIRECT has been positively verified.
    const cleanup = await clearChromeProxy();
    if (!cleanup?.ok) throw new Error(cleanup?.error || "无法确认 Chrome 已恢复直连。");
    await saveState({ country: selected, enabled: false, resolvedCountry: "" });
    await syncRegionShield({ ...state, enabled: false, resolvedCountry: "", country: selected });
    await syncPrivacySettings({ ...state, enabled: false, country: selected });
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }

    const response = await nativeRequest("start", { country: selected }, 180000);
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    const helperCheck = await nativeRequest("status", {}, 15000);
    const helperHealthy = helperCheck?.status?.healthy === undefined
      ? helperCheck?.status?.running === true
      : helperCheck.status.healthy === true;
    if (helperCheck?.status?.running !== true || !helperHealthy) {
      throw new Error("切换位置后本地 SOCKS5 代理未通过上游连接检查。");
    }
    const nextState = { ...state, country: selected, enabled: true };
    await syncPrivacySettings(nextState);
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    await applyChromeProxy(nextState);
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    const resolvedCountry = String(response?.resolvedCountry || (selected !== "REC" ? selected : ""));
    await saveState({ enabled: true, resolvedCountry, country: selected, lastError: "" });
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    await syncRegionShield({ ...nextState, resolvedCountry });
    await updateAction(true, nextState.proxyMode);
    return { ...response, restarted: true };
  } catch (error) {
    if (!isCurrentLifecycleGeneration(generation)) {
      await failOpenNow("", { stopNative: true });
      return { ok: true, superseded: true };
    }
    await failOpenNow(error.message, { stopNative: true });
    throw error;
  }
}

function startVpn(country) {
  return queueLifecycleOperation((generation) => startVpnNow(country, generation));
}

// Region data lives behind Native Messaging, and while the VPN is off every
// request cold-starts the helper exe. Cache the list in memory so opening the
// popup stays instant; a manual sync or a service-worker restart refreshes it.
const LOCATIONS_CACHE_TTL_MS = 600000;
let locationsCache = { items: null, fetchedAt: 0 };

async function getLocations() {
  const fresh = locationsCache.items && (Date.now() - locationsCache.fetchedAt) < LOCATIONS_CACHE_TTL_MS;
  if (fresh) return { ok: true, locations: locationsCache.items, cached: true };
  const response = await requestForCurrentState("locations", {}, 45000);
  locationsCache = { items: Array.isArray(response.locations) ? response.locations : [], fetchedAt: Date.now() };
  return response;
}

function stopVpn() {
  return queueLifecycleOperation((generation) => stopVpnNow(generation));
}

function changeCountry(country) {
  return queueLifecycleOperation((generation) => changeCountryNow(country, generation));
}

async function setAutoConnect(enabled) {
  const autoConnect = Boolean(enabled);
  await saveState({ autoConnect });
  return { ok: true, autoConnect };
}

async function syncRouteDependentProtections(state) {
  await syncPrivacySettings(state);
  await syncRegionShield(state);
}

async function commitRouteMutation(state, next, patch) {
  try {
    if (state.enabled) {
      // Apply the new PAC before publishing the corresponding route state. If
      // either operation fails, fail-open removes both the old and new PAC.
      await applyChromeProxy(next);
    } else {
      const cleanup = await clearChromeProxy();
      if (!cleanup?.ok) throw new Error(cleanup?.error || "无法确认 Chrome 已恢复直连。");
    }
    await saveState(patch);
    await syncRouteDependentProtections(next);
    await updateAction(state.enabled, next.proxyMode);
  } catch (error) {
    await failOpenNow(error.message, { stopNative: true });
    throw error;
  }
}

async function setProxyModeNow(mode) {
  const proxyMode = normalizeProxyMode(mode);
  const state = await getStoredState();
  const next = { ...state, proxyMode };
  await commitRouteMutation(state, next, { proxyMode });
  return { ok: true, proxyMode };
}

async function setSiteRuleNow(domainInput, useVpn) {
  const domain = canonicalManagedDomain(domainInput);
  const state = await getStoredState();
  let allowlist = [...state.allowlist];
  let bypassSites = [...state.bypassSites];
  if (normalizeProxyMode(state.proxyMode) === "allowlist") {
    if (useVpn) {
      if (!listCoversHost(allowlist, domain)) allowlist = [...allowlist, domain];
    } else {
      allowlist = allowlist.filter((rule) => !ruleCoversHost(rule, domain));
    }
  } else {
    if (useVpn) {
      bypassSites = bypassSites.filter((rule) => !ruleCoversHost(rule, domain));
    } else if (!listCoversHost(bypassSites, domain)) {
      bypassSites = [...bypassSites, domain];
    }
  }
  allowlist = normalizeManagedDomainArray(allowlist);
  bypassSites = normalizeManagedDomainArray(bypassSites);
  const next = { ...state, allowlist, bypassSites };
  await commitRouteMutation(state, next, { allowlist, bypassSites });
  return { ok: true, domain, useVpn: Boolean(useVpn), allowlist, bypassSites };
}

async function addManagedDomainNow(domainInput) {
  const domain = canonicalManagedDomain(domainInput);
  const state = await getStoredState();
  let allowlist = [...state.allowlist];
  let bypassSites = [...state.bypassSites];
  if (normalizeProxyMode(state.proxyMode) === "allowlist") {
    allowlist = normalizeManagedDomainArray([...allowlist, domain]);
  } else {
    bypassSites = normalizeManagedDomainArray([...bypassSites, domain]);
  }
  const next = { ...state, allowlist, bypassSites };
  await commitRouteMutation(state, next, { allowlist, bypassSites });
  return { ok: true, allowlist, bypassSites };
}

async function removeManagedDomainNow(domainInput) {
  const domain = canonicalManagedDomain(domainInput);
  const state = await getStoredState();
  const allowlist = state.allowlist.filter((x) => x !== domain);
  const bypassSites = state.bypassSites.filter((x) => x !== domain);
  const next = { ...state, allowlist, bypassSites };
  await commitRouteMutation(state, next, { allowlist, bypassSites });
  return { ok: true, allowlist, bypassSites };
}

function setPrivacyOption(option, enabled) {
  return queueStateOperation(() => setPrivacyOptionNow(option, enabled));
}

function setRegionShieldOption(option, value) {
  return queueStateOperation(() => setRegionShieldOptionNow(option, value));
}

function setProxyMode(mode) {
  return queueStateOperation(() => setProxyModeNow(mode));
}

function setSiteRule(domainInput, useVpn) {
  return queueStateOperation(() => setSiteRuleNow(domainInput, useVpn));
}

function addManagedDomain(domainInput) {
  return queueStateOperation(() => addManagedDomainNow(domainInput));
}

function removeManagedDomain(domainInput) {
  return queueStateOperation(() => removeManagedDomainNow(domainInput));
}


async function prepareCleanup(mode) {
  const cleanup = await clearChromeProxy();
  if (!cleanup?.ok) {
    await failOpenNow(cleanup.error || "无法确认 Chrome 已恢复直连。", { stopNative: true });
    throw new Error(cleanup.error || "无法确认 Chrome 已恢复直连，未执行本地清理。");
  }
  let stopError = null;
  try {
    if (nativePort) await nativeRequest("stop", {}, 15000);
  } catch (error) {
    stopError = error;
  } finally {
    try { await saveState({ enabled: false, resolvedCountry: "", lastError: "" }); }
    catch (_) {}
    if (mode === "full") {
      await Promise.allSettled([clearAllPrivacyOverrides(), clearAllRegionShieldOverrides()]);
    } else {
      let offState = { ...DEFAULT_STATE, enabled: false, resolvedCountry: "" };
      try { offState = { ...(await getStoredState()), enabled: false, resolvedCountry: "" }; }
      catch (_) {}
      await Promise.allSettled([syncRegionShield(offState), syncPrivacySettings(offState)]);
    }
    await updateAction(false);
    await clearChromeProxy();
  }
  if (stopError) throw stopError;
  const result = await nativeRequest("prepare_cleanup", { mode }, 15000);
  if (nativePort) disconnectNativePort(nativePort);
  return result;
}

async function fullStatusNow() {
  let state;
  try { state = await getStoredState(); }
  catch (error) {
    try { await clearChromeProxy(); } catch (_) {}
    throw error;
  }
  // Opening the popup is also a self-heal point for any PAC that survived an
  // unclean browser/helper shutdown while the logical VPN state is off.
  let proxyCleanup = null;
  if (!state.enabled) {
    try { proxyCleanup = await clearChromeProxy(); }
    catch (_) { proxyCleanup = { ok: false, verified: false, owned: true }; }
    if (nativePort) await stopNativeHelper(9000);
  }
  let helper = { available: false, running: false, credentials: false };
  let helperError = "";
  try {
    const response = state.enabled ? await nativeRequest("status", {}, 15000) : await nativeOneShot("status", {}, 15000);
    helper = response.status || helper;
  } catch (error) { helperError = error.message; }

  let proxy = await readProxyControlInfoWithRetry().catch(() => null);
  let recovered = false;
  if (state.enabled) {
    const proxyOwnedByUs = proxyIsOwnedPac(proxy);
    const helperHealthy = helper.healthy === undefined
      ? helper.running === true
      : helper.healthy === true;
    const healthy = !helperError && helper.running === true && helperHealthy && proxyOwnedByUs;
    if (!healthy) {
      const reason = helperError ||
        (helper.running !== true
          ? "本地 SOCKS5 代理已停止，已恢复浏览器直连。"
          : "Chrome 代理状态异常，已恢复浏览器直连。");
      // A dead child is the exact failure mode that leaves Chrome showing
      // ERR_PROXY_CONNECTION_FAILED. Repair it while the popup is opening,
      // before returning a misleading enabled=true state to the UI.
      await failOpenNow(reason, { stopNative: true });
      recovered = true;
      state = await getStoredState();
      helperError = reason;
      proxy = await readProxyControlInfoWithRetry().catch(() => null);
    }
  }

  const [privacy, region] = await Promise.all([
    getPrivacyStatus(state),
    syncRegionShield(state)
  ]);
  const proxyOwnedByUs = proxyIsOwnedPac(proxy);
  const helperHealthy = helper.healthy === undefined
    ? helper.running === true
    : helper.healthy === true;
  const proxySafe = Boolean(proxy) && !proxyOwnedByUs && proxyCleanup?.ok !== false;
  if (!state.enabled && !proxySafe && !helperError) {
    helperError = "无法确认 Chrome 已恢复直连，请重新加载扩展或重启 Chrome。";
  }
  const healthy = state.enabled
    ? (helper.running === true && helperHealthy && proxyOwnedByUs && Boolean(proxy))
    : proxySafe;
  return {
    ok: true,
    state,
    helper,
    helperError,
    proxyLevel: proxy?.levelOfControl || "unknown",
    privacy,
    region,
    health: { healthy, recovered, proxySafe }
  };
}

let healthCheckInFlight = false;

async function monitorActiveVpnHealth() {
  if (healthCheckInFlight) return { ok: true, skipped: true };
  healthCheckInFlight = true;
  try {
    return await queueLifecycleOperation(async (generation) => {
      const state = await getStoredState();
      if (!state.enabled) return { ok: true, active: false };

      let helperResponse;
      let proxy;
      try {
        helperResponse = await nativeRequest("status", {}, 15000);
        proxy = await readProxyControlInfoWithRetry();
      } catch (error) {
        // A transient Native Messaging/Chrome API failure is handled by the
        // same restart path as a dead SOCKS process; startVpnNow still fails
        // open if the second attempt cannot establish a verified tunnel.
        helperResponse = { status: { running: false, healthy: false } };
        proxy = null;
        state.lastError = error.message;
      }

      const helper = helperResponse?.status || {};
      const helperHealthy = helper.healthy === undefined
        ? helper.running === true
        : helper.healthy === true;
      const healthy = helper.running === true && helperHealthy && proxyIsOwnedPac(proxy);
      if (healthy || !isCurrentLifecycleGeneration(generation)) {
        return { ok: true, active: true, healthy };
      }

      const reason = state.lastError || (helper.running !== true
        ? "本地 SOCKS5 代理已停止，正在自动恢复。"
        : "本地 SOCKS5 代理健康检查失败，正在自动恢复。");
      try {
        await startVpnNow(state.country, generation);
        return { ok: true, active: true, recovered: true };
      } catch (error) {
        // startVpnNow has already restored DIRECT and persisted a useful error.
        return { ok: false, active: true, recovered: false, error: error.message || reason };
      }
    });
  } finally {
    healthCheckInFlight = false;
  }
}

function fullStatus() {
  return queueStateOperation(() => fullStatusNow());
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "status": return fullStatus();
      case "toggle": return message.enabled ? startVpn(message.country) : stopVpn();
      case "country": return changeCountry(message.country);
      case "autoConnect": return setAutoConnect(Boolean(message.enabled));
      case "privacyOption": return setPrivacyOption(message.option, Boolean(message.enabled));
      case "privacyStatus": return { ok: true, privacy: await getPrivacyStatus() };
      case "regionShield": return setRegionShieldOption(message.option, message.value);
      case "regionStatus": return queueStateOperation(async () => { const state = await getStoredState(); return { ok:true, region:await syncRegionShield(state) }; });
      case "regionContentConfig": return { ok:true, config:await regionContentConfig(message.host || "") };
      case "proxyMode": return setProxyMode(message.mode);
      case "setSiteRule": return setSiteRule(message.domain, Boolean(message.useVpn));
      case "addManagedDomain": return addManagedDomain(message.domain);
      case "removeManagedDomain": return removeManagedDomain(message.domain);
      case "importFirefox": return requestForCurrentState("import_firefox", {}, 150000);
      case "usage": return requestForCurrentState("usage", {}, 90000);
      case "locations": return getLocations();
      case "sync": {
        const syncResponse = await requestForCurrentState("sync", {}, 90000);
        locationsCache = { items: null, fetchedAt: 0 };
        return syncResponse;
      }
      case "openInstallFolder": return requestForCurrentState("open_folder", {}, 10000);
      case "prepareRemoveLocal": return queueLifecycleOperation(() => prepareCleanup("local"));
      case "prepareFullUninstall": return queueLifecycleOperation(() => prepareCleanup("full"));
      case "cancelCleanup": return nativeOneShot("cancel_cleanup", { token: message.token }, 10000);
      default: throw new Error("未知的扩展命令。");
    }
  })().then(sendResponse).catch((error) => {
    saveState({ lastError: error.message }).finally(() => sendResponse({ ok: false, error: error.message }));
  });
  return true;
});


async function stopVpnWhenLastWindowCloses() {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (windows.length !== 0) return;
    const state = await getStoredState();
    if (state.enabled) await stopVpn();
  } catch (_) {
    // The Native Messaging pipe + Windows Job Object are still the final safety net.
  }
}

chrome.windows.onRemoved.addListener(() => {
  // Let Chrome finish removing the window before counting remaining windows.
  setTimeout(stopVpnWhenLastWindowCloses, 200);
});

const VPN_HEALTH_ALARM = "vpn-health-watchdog";
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === VPN_HEALTH_ALARM) monitorActiveVpnHealth().catch(() => {});
  });
}

async function armVpnHealthWatchdog() {
  if (!chrome.alarms?.create) return;
  try { await chrome.alarms.create(VPN_HEALTH_ALARM, { periodInMinutes: 1 }); }
  catch (_) {}
}

async function resetVpnForFreshBrowserSession(reason = "") {
  // Chrome can persist extension-owned proxy settings across an unclean browser/OS shutdown.
  // Never point a fresh Chrome session at a localhost SOCKS port before the helper is ready.
  const cleanup = await clearChromeProxy();
  // A persistent Native Messaging port may still own the old pool process. Ask
  // it to stop and wait for 1090 to be released before auto-connect can start.
  if (nativePort) await stopNativeHelper(9000);
  if (!cleanup?.ok) throw new Error(cleanup.error || "无法确认 Chrome 已恢复直连。");
  const state = await getStoredState();
  await saveState({ enabled: false, resolvedCountry: "", lastError: reason || "" });
  await syncRegionShield({ ...state, enabled: false, resolvedCountry: "" });
  await syncPrivacySettings({ ...state, enabled: false });
  await updateAction(false, state.proxyMode);
}

async function migrateRoutingModeAndDnsScopeOnce() {
  const raw = await chrome.storage.local.get(["proxyMode", "routingModeSchema"]);
  if (Number(raw.routingModeSchema || 0) >= 2) {
    // Even after migration, release any stale v0.6.x global DNS predictor override.
    await clearLegacyGlobalDnsPredictionOverride();
    return;
  }
  // Fresh installs start in allowlist mode. Existing legacy "all" mode maps to
  // blacklist so an update never silently reroutes every site in the opposite way.
  const proxyMode = raw.proxyMode === undefined ? "allowlist" : normalizeProxyMode(raw.proxyMode);
  await chrome.storage.local.set({ proxyMode, routingModeSchema: 2 });
  await clearLegacyGlobalDnsPredictionOverride();
  const state = await getStoredState();
  await syncPrivacySettings(state);
  await syncRegionShield(state);
}

async function migrateRuntimeStateOnce() {
  // v0.5.6 and earlier stored `enabled` persistently. If Windows killed Chrome while
  // VPN was on, both enabled=true and the PAC proxy could survive into the next launch.
  const old = await chrome.storage.local.get({ runtimeStateSchema: 0, enabled: false });
  if (Number(old.runtimeStateSchema || 0) >= 1) return;
  await clearChromeProxy();
  await chrome.storage.local.remove("enabled");
  await chrome.storage.local.set({ runtimeStateSchema: 1 });
  await chrome.storage.session.set({ enabled: false, resolvedCountry: "" });
  const state = await getStoredState();
  await syncPrivacySettings({ ...state, enabled: false });
  await updateAction(false, state.proxyMode);
}

async function handleBrowserStartup() {
  await armVpnHealthWatchdog();
  // Always begin fail-open: remove any stale PAC/SOCKS state before doing network work.
  await queueLifecycleOperation(async () => {
    await resetVpnForFreshBrowserSession();
    return { ok: true };
  });
  const state = await getStoredState();
  if (!state.autoConnect) return;
  try {
    // The tunnel bootstrap takes several seconds; surface that on the toolbar
    // icon right away instead of leaving the browser-startup state ambiguous.
    // startVpn/failOpenNow overwrite the title when they finish.
    try { await chrome.action.setTitle({ title: "正在自动连接 VPN…" }); } catch (_) {}
    // startVpn() launches the Native Messaging helper first, waits for SOCKS5 readiness,
    // and only then installs Chrome's PAC script. A failure therefore leaves Chrome direct.
    await startVpn(state.country);
  } catch (error) {
    await failOpenNow(`启动时自动连接失败：${error.message}`, { stopNative: true });
  }
}

chrome.runtime.onStartup.addListener(() => {
  handleBrowserStartup().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  armVpnHealthWatchdog().catch(() => {});
  // Reload/update must also fail open: a Native Messaging host may have been killed
  // while Chrome still remembers the old PAC script.
  queueLifecycleOperation(() => resetVpnForFreshBrowserSession()).catch(() => {});
});

// One-time migration executes immediately after upgrading/reloading from <= 0.5.6,
// so a stale PAC setting is cleared without waiting for the next browser restart.
(async () => {
  await armVpnHealthWatchdog();
  await migrateRuntimeStateOnce();
  await migrateRoutingModeAndDnsScopeOnce();
})().catch(() => {});

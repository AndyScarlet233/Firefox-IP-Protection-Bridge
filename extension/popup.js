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
const importFirefox = $("importFirefox");
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
const regionShieldToggle = $("regionShieldToggle");
const regionShieldDetail = $("regionShieldDetail");
const regionProfileText = $("regionProfileText");
const regionPageDiagText = $("regionPageDiagText");

let state = { enabled: false, autoConnect: false, webRtcLeakProtection: true, dnsPredictionProtection: true, regionShieldEnabled: true, resolvedCountry: "", country: "REC", proxyMode: "allowlist", allowlist: [], bypassSites: [] };
let privacyStatus = null;
let regionStatus = null;
let helper = {};
let activeDomain = "";
let busy = false;
let connectionTransition = "";
let availableLocations = [];

const COUNTRY_NAMES_ZH = {
  AT: "奥地利", AU: "澳大利亚", BE: "比利时", BG: "保加利亚", CA: "加拿大",
  CH: "瑞士", CL: "智利", CO: "哥伦比亚", DE: "德国", DK: "丹麦",
  ES: "西班牙", FI: "芬兰", FR: "法国", GB: "英国", IE: "爱尔兰",
  IT: "意大利", JP: "日本", MX: "墨西哥", MY: "马来西亚", NL: "荷兰",
  NO: "挪威", NZ: "新西兰", PL: "波兰", PT: "葡萄牙", SE: "瑞典",
  SG: "新加坡", TH: "泰国", US: "美国", ZA: "南非"
};

function populateLocations(items = []) {
  availableLocations = Array.isArray(items) ? items : [];
  const previous = state.country || country.value || "REC";
  const availableCodes = new Set(availableLocations.filter(x => x && x.available !== false).map(x => String(x.code || "").toUpperCase()));
  const seenCodes = new Set(availableLocations.map(x => String(x.code || "").toUpperCase()).filter(Boolean));
  const allCodes = new Set([...Object.keys(COUNTRY_NAMES_ZH), ...seenCodes]);

  country.innerHTML = "";
  const recommended = document.createElement("option");
  recommended.value = "REC";
  recommended.textContent = "推荐（自动）";
  country.appendChild(recommended);

  for (const code of [...allCodes].sort((a, b) => (COUNTRY_NAMES_ZH[a] || a).localeCompare(COUNTRY_NAMES_ZH[b] || b, "zh-CN"))) {
    const info = availableLocations.find(x => String(x.code || "").toUpperCase() === code) || {};
    const option = document.createElement("option");
    option.value = code;
    option.disabled = !availableCodes.has(code);
    const name = COUNTRY_NAMES_ZH[code] || info.name || code;
    option.textContent = option.disabled ? `${name}（不可用）` : name;
    country.appendChild(option);
  }

  const optionExists = [...country.options].some(o => o.value === previous);
  country.value = optionExists ? previous : "REC";
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.ok === false) throw new Error(response?.error || "操作失败");
  return response;
}


function translateUiError(message = "") {
  const text = String(message || "").trim();
  if (!text) return "";
  const known = [
    [/Specified native messaging host not found\.?/i, "未找到本地桥接程序。请运行 INSTALL-OR-REPAIR.cmd 修复本地桥接；修复后扩展目录可以移动或改名。"],
    [/Error when communicating with the native messaging host\.?/i, "与本地桥接程序通信失败。请确认已安装 runtime\\vpn_bridge_host.exe，并运行 INSTALL-OR-REPAIR.cmd 修复后重启浏览器。"],
    [/Native host has exited\.?/i, "本地桥接程序已退出。请重试，或运行 INSTALL-OR-REPAIR.cmd 修复本地桥接。"],
    [/Access to the specified native messaging host is forbidden\.?/i, "Chrome 无权访问本地桥接程序。请确认扩展 ID 与安装脚本一致。"],
    [/Native bridge returned no response/i, "本地桥接程序没有返回结果。"],
    [/Native bridge timeout while running (.+)/i, (_, cmd) => `本地桥接程序执行 ${cmd} 时超时。`],
    [/Native bridge disconnected/i, "本地桥接程序已断开连接。"],
    [/Chrome proxy is controlled by another extension or policy\.?/i, "Chrome 代理当前被其他扩展或管理员策略控制。"],
    [/Unknown extension command/i, "扩展收到了未知命令。"],
    [/no listeners started/i, "所选地区当前没有可用节点，请换一个地区。"],
    [/exported 0 nodes/i, "所选地区当前没有可用节点，请换一个地区。"],
    [/代理进程提前退出.*no listeners started/i, "所选地区当前没有可用节点，请换一个地区。"],
    [/missing FxA access token for Guardian usage query/i, "检测到旧版后台仍在运行。请运行 1.0.0 的 INSTALL-OR-REPAIR.cmd，然后在扩展管理页重新加载本扩展。"],
    [/missing Firefox renewal credentials for Guardian usage query/i, "未找到可续期的 Firefox 登录状态。请先点击“从 Firefox 导入登录状态”，然后再查询流量。"],
    [/Firefox Account session requires re-authentication for Guardian usage query/i, "Firefox 账户登录状态已失效，请在 Firefox 中重新登录后再次导入。"],
    [/Firefox Account OAuth usage query was rate-limited/i, "Mozilla 暂时限制了账户查询频率，请稍后再试。"],
    [/temporary Firefox Account\/Guardian usage query failure/i, "Mozilla 流量查询暂时失败，请稍后重试。"],
    [/Guardian usage request failed with HTTP 403/i, "当前 Mozilla 账户没有可用的 Firefox IP 保护资格。"],
    [/Guardian usage request failed with HTTP 401/i, "Firefox 账户授权已失效，请重新导入登录状态。"],
    [/HTTP 451|service_restricted|service is restricted/i, "Mozilla 拒绝了当前网络出口的请求（HTTP 451，与账户无关）。通常是出口地区暂时受限：请稍后重试；隧道建立后凭据续期会自动改走隧道出口。如反复出现，可将可用的 HTTP 代理写入 runtime 的 tokens/refresh_proxy.txt。"],
    [/automatic renewal is paused \(service_restricted\)/i, "当前网络出口暂时被 Mozilla 拒绝（HTTP 451），请稍后重试；这不是账户问题。"]
  ];
  for (const [pattern, replacement] of known) {
    const match = text.match(pattern);
    if (match) return typeof replacement === 'function' ? replacement(...match) : replacement;
  }
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
  if (!Number.isFinite(amount) || amount < 0) return "未知";
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)} GB`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(1)} MB`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(1)} KB`;
  return `${Math.round(amount)} B`;
}

function formatQuotaReset(value) {
  const raw = String(value || "").trim();
  if (!raw) return "未知";
  return raw.replace(/Z$/, " UTC").replace("T", " ");
}

function formatUsageText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "未返回可读的用量信息。";
  try {
    const usage = JSON.parse(raw);
    if (usage && typeof usage === "object") {
      if (usage.unlimited === true) return "本月流量：不限量";
      const limit = Number(usage.limit);
      const remaining = Number(usage.remaining);
      if (Number.isFinite(limit) && Number.isFinite(remaining) && limit >= 0 && remaining >= 0) {
        const used = Math.max(0, limit - remaining);
        let text = `套餐 ${formatQuotaBytes(limit)} · 已使用 ${formatQuotaBytes(used)} · 剩余 ${formatQuotaBytes(remaining)}`;
        if (usage.reset) text += ` · 重置 ${formatQuotaReset(usage.reset)}`;
        return text;
      }
    }
  } catch (_) {}
  return raw;
}

function setBusy(value) {
  busy = value;
  for (const el of [power, country, siteToggle, autoConnectToggle, webRtcLeakToggle, dnsPredictionToggle, regionShieldToggle, modeAllowlist, modeBlacklist, domainInput, addDomain, importFirefox, openFolder, removeLocal, fullUninstall]) {
    if (el) el.disabled = value;
  }
}

function countryName() {
  const selected = country.options[country.selectedIndex];
  return selected?.text?.replace("（不可用）", "") || (country.value === "REC" ? "推荐（自动）" : COUNTRY_NAMES_ZH[country.value] || country.value);
}

function managedList() {
  return state.proxyMode === "allowlist" ? state.allowlist : state.bypassSites;
}

function ruleCoversHost(rule, host) {
  return host === rule || host.endsWith(`.${rule}`);
}

function siteUsesVpn(domain = activeDomain) {
  if (!domain) return false;
  const inList = managedList().some((rule) => ruleCoversHost(rule, domain));
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
    ? "正在读取状态…"
    : connecting
      ? "正在连接…"
      : switching
        ? "正在切换位置…"
        : disconnecting
          ? "正在关闭…"
          : (state.enabled ? "VPN 已开启" : "VPN 已关闭");
  power.textContent = loading
    ? "正在读取…"
    : connecting
      ? "正在连接…"
      : switching
        ? "正在切换…"
        : disconnecting
          ? "正在关闭…"
          : (state.enabled ? "关闭 VPN" : "开启 VPN");
  if (statusMark) statusMark.textContent = pending ? "…" : "✓";
  locationText.textContent = `位置：${countryName()}`;
  modeHint.textContent = pending
    ? (loading
      ? "正在检查本地代理…"
      : (disconnecting ? "正在恢复浏览器直连…" : "正在验证本地代理…"))
    : (state.proxyMode === "allowlist"
      ? `白名单 · ${state.allowlist.length} 个网站`
      : (state.bypassSites.length ? `黑名单 · ${state.bypassSites.length} 个直连网站` : "黑名单 · 默认全走 VPN"));
  settingsSummary.textContent = state.proxyMode === "allowlist" ? "白名单" : "黑名单";
  const showSiteControls = Boolean(state.enabled && activeDomain && !pending);
  siteRow.hidden = !showSiteControls;
  siteToggle.checked = showSiteControls && siteUsesVpn();
  siteRow?.classList.toggle("vpn-on-site", Boolean(showSiteControls && siteToggle.checked));
  siteToggle.disabled = busy || !showSiteControls;
}

function renderSettings() {
  const allow = state.proxyMode === "allowlist";
  autoConnectToggle.checked = Boolean(state.autoConnect);
  webRtcLeakToggle.checked = Boolean(state.webRtcLeakProtection);
  dnsPredictionToggle.checked = Boolean(state.dnsPredictionProtection);
  regionShieldToggle.checked = Boolean(state.regionShieldEnabled);

  const rtc = privacyStatus?.webRtc;
  if (state.webRtcLeakProtection && rtc?.supported && rtc.effective === "disable_non_proxied_udp") {
    webRtcPrivacyDetail.textContent = "已阻止 WebRTC 使用非代理 UDP；VPN 关闭时也继续生效。";
  } else if (state.webRtcLeakProtection && rtc && (rtc.levelOfControl === "controlled_by_other_extensions" || rtc.levelOfControl === "not_controllable")) {
    webRtcPrivacyDetail.textContent = "当前未能接管此设置：它被其他扩展或管理员策略控制。";
  } else if (!state.webRtcLeakProtection) {
    webRtcPrivacyDetail.textContent = "已关闭；Chrome 使用原本的 WebRTC IP 策略。";
  } else {
    webRtcPrivacyDetail.textContent = "阻止 WebRTC 绕过代理暴露真实 IP；VPN 关闭时也可以继续保护。";
  }

  const dns = privacyStatus?.dnsPrediction;
  if (!state.dnsPredictionProtection) {
    dnsPrivacyDetail.textContent = "已关闭；所有网站使用 Chrome 原本的 DNS 预解析。";
  } else if (!state.enabled) {
    dnsPrivacyDetail.textContent = "待命；VPN 开启后只保护实际走 VPN 的页面，直连网站不受影响。";
  } else if (dns?.supported && dns?.active) {
    dnsPrivacyDetail.textContent = "已按路由生效：VPN 页面关闭 DNS 预解析，直连页面保留原生预解析/预连接。";
  } else if (state.proxyMode === "allowlist" && !state.allowlist.length) {
    dnsPrivacyDetail.textContent = "白名单为空；当前没有网页走 VPN，因此 DNS 防护无需生效。";
  } else if (dns && dns.supported === false) {
    dnsPrivacyDetail.textContent = "当前 Chrome 不支持按路由修改 DNS 预解析控制。";
  } else {
    dnsPrivacyDetail.textContent = "正在同步按路由 DNS 防护规则。";
  }
  const rp = regionStatus?.profile;
  if (!state.regionShieldEnabled) {
    regionShieldDetail.textContent = "已关闭；网站会看到 Chrome 原本的语言、时区、字体与定位线索。";
  } else if (!state.enabled) {
    regionShieldDetail.textContent = "待命；VPN 连接后只对实际走 VPN 的网页生效。";
  } else if (regionStatus?.active) {
    regionShieldDetail.textContent = "正在对实际走 VPN 的网页减少语言、时区、定位与中文字体线索。";
  } else {
    regionShieldDetail.textContent = "已开启；正在等待 VPN 连接。";
  }
  regionProfileText.textContent = rp
    ? `当前配置：${rp.country} · ${rp.locale} · ${rp.timeZone}。已打开网页会自动同步。`
    : "当前配置将在 VPN 连接后自动生成。";
  modeAllowlist.classList.toggle("active", allow);
  modeBlacklist.classList.toggle("active", !allow);
  modeDescription.textContent = allow
    ? "只有白名单里的域名及其站点族走 VPN；其余网站直接连接。"
    : "除黑名单中的直连网站外，其余网站默认走 VPN。";
  listTitle.textContent = allow ? "使用 VPN 的白名单" : "直接连接的黑名单";
  const domains = managedList();
  siteCount.textContent = String(domains.length);
  domainList.innerHTML = "";
  if (!domains.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = allow ? "白名单为空，当前不会有网站走 VPN。" : "黑名单为空，当前所有网站都会走 VPN。";
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
      remove.title = `删除 ${domain}`;
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
    regionPageDiagText.textContent = "当前网页实测：区域隐私保护已关闭。";
    return;
  }
  if (!state.enabled) {
    regionPageDiagText.textContent = "当前网页实测：VPN 未连接，区域保护待命。";
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      regionPageDiagText.textContent = "当前网页实测：此页面不支持检测。";
      return;
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const test = "中文字体检测ABCabc012";
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
      }
    });
    if (!result) throw new Error("没有返回结果");
    const expected = regionStatus?.profile;
    const langOk = !expected || String(result.language).toLowerCase() === String(expected.locale).toLowerCase();
    const tzOk = !expected || result.timeZone === expected.timeZone;
    const fontOk = result.fontLeak !== true;
    const ok = langOk && tzOk && fontOk;
    const fontText = result.fontLeak == null ? "字体未知" : (result.fontLeak ? "中文字体仍可探测" : "中文字体已遮罩");
    regionPageDiagText.textContent = `当前网页实测：${result.language || "?"} · ${result.timeZone || "?"} · ${fontText}${ok ? " ✓" : "（未完全生效，请刷新网页）"}`;
  } catch (_) {
    regionPageDiagText.textContent = "当前网页实测：尚未载入保护脚本，请刷新此网页。";
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
  showNotice("正在读取 VPN 状态…");
  // Status and locations are independent requests; run them concurrently so
  // the popup is not serialized behind two native-messaging round trips.
  const locationsPromise = send({ type: "locations" }).then(
    (response) => ({ ok: true, response }),
    (error) => ({ ok: false, error })
  );
  try {
    const response = await send({ type: "status" });
    state = { ...state, ...(response.state || {}) };
    helper = response.helper || {};
    privacyStatus = response.privacy || null;
    regionStatus = response.region || null;
    let locationWarning = "";
    // Keep a useful fallback if the server list cannot be refreshed right now.
    const locationResult = await locationsPromise;
    if (locationResult.ok) {
      populateLocations(locationResult.response.locations || []);
    } else {
      populateLocations([]);
      locationWarning = `可用地区列表暂时无法刷新：${translateUiError(locationResult.error.message)}`;
    }
    country.value = [...country.options].some(o => o.value === (state.country || "REC")) ? (state.country || "REC") : "REC";
    activeDomain = await getActiveDomain();
    currentSite.textContent = activeDomain || "当前页面无法单独设置（仅支持 http/https 网页）";
    installPath.textContent = helper.installRoot || "未返回安装位置";
    installPath.title = helper.installRoot || "";
    credentialStatus.textContent = helper.credentials ? "已导入，可自动续期访问凭据" : (helper.available ? "尚未导入 Firefox 登录状态" : "本地桥接程序不可用");
    if (response.helperError) showNotice(response.helperError, "error");
    else if (state.lastError) showNotice(state.lastError, "error");
    else if (locationWarning) showNotice(locationWarning, "error");
    else showNotice("");
    renderMain();
    renderSettings();
    await refreshRegionPageDiagnostics();
  } catch (error) {
    showNotice(error.message, "error");
    credentialStatus.textContent = "未找到本地桥接程序，请重新运行安装或更新脚本。";
  } finally {
    connectionTransition = "";
    setBusy(false);
    renderMain();
  }
}

power.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  const next = !state.enabled;
  connectionTransition = next ? "connecting" : "disconnecting";
  renderMain();
  showNotice(next ? "正在连接 Firefox IP 保护服务…" : "正在断开连接…");
  try {
    const response = await send({ type: "toggle", enabled: next, country: country.value });
    // Verify both connect and disconnect. A successful command acknowledgement
    // is not enough if Chrome retained an extension-owned PAC or the child died
    // between the command and the UI update.
    const verified = adoptStatusResponse(await send({ type: "status" }));
    if (verified.health?.healthy !== true || Boolean(state.enabled) !== next ||
        (next && helper.running !== true)) {
      throw new Error(verified.helperError || (next
        ? "本地 SOCKS5 代理未能保持运行，已恢复浏览器直连。"
        : "无法确认 Chrome 已恢复直连，请重新加载扩展或重启 Chrome。"));
    }
    if (next && response?.resolvedCountry && country.value === "REC") {
      showNotice(`VPN 已连接，推荐位置当前使用 ${COUNTRY_NAMES_ZH[response.resolvedCountry] || response.resolvedCountry}。`, "good");
    }
    if (!(next && response?.resolvedCountry && country.value === "REC")) showNotice(next ? "VPN 已连接。" : "VPN 已关闭。", "good");
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
      throw new Error(verified.helperError || "位置切换后 VPN 状态未能通过检查。");
    }
    state.country = selected;
    showNotice(state.enabled ? "位置已切换。" : "位置已保存。", "good");
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
    showNotice(desired ? `${activeDomain} 将使用 VPN。` : `${activeDomain} 将直接连接。`, "good");
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
    showNotice(mode === "allowlist" ? "已切换为白名单模式。" : "已切换为黑名单模式。", "good");
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
      ? "已启用启动时自动连接；下次启动 Chrome 会先启动本地组件，连接就绪后再启用 VPN。"
      : "已关闭启动时自动连接。", "good");
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
        ? "WebRTC 防泄漏已开启；即使 VPN 关闭也会继续保护。"
        : "WebRTC 防泄漏已关闭，已恢复 Chrome 原本的 WebRTC 策略。", "good");
    } else {
      showNotice(state.dnsPredictionProtection
        ? (state.enabled ? "DNS 预解析防护已按 VPN 路由生效；直连网站不受影响。" : "DNS 预解析防护已开启，将在 VPN 连接时按路由生效。")
        : "DNS 预解析防护已关闭；Chrome 保持原本的 DNS 预解析行为。", "good");
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

regionShieldToggle.addEventListener("change", async () => {
  const desired = regionShieldToggle.checked;
  regionShieldToggle.disabled = true;
  try {
    const response = await send({ type:"regionShield", option:"enabled", value:desired });
    state.regionShieldEnabled = Boolean(response.regionShieldEnabled);
    regionStatus = response.region || regionStatus;
    showNotice(state.regionShieldEnabled
      ? "区域隐私保护已开启；VPN 连接后只对实际走 VPN 的网页生效。"
      : "区域隐私保护已关闭。", "good");
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
    showNotice("网站规则已添加。", "good");
  } catch (error) {
    showNotice(error.message, "error");
    await reconcileAfterCommandFailure();
  }
  finally { setBusy(false); renderMain(); renderSettings(); }
}
addDomain.addEventListener("click", addManaged);
domainInput.addEventListener("keydown", (event) => { if (event.key === "Enter") addManaged(); });

async function removeDomain(domain) {
  setBusy(true);
  try {
    const response = await send({ type: "removeManagedDomain", domain });
    state.allowlist = response.allowlist || [];
    state.bypassSites = response.bypassSites || [];
    showNotice("网站规则已删除。", "good");
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
  showNotice("正在从本机 Firefox 导入登录状态…");
  try {
    const response = await send({ type: "importFirefox" });
    credentialStatus.textContent = response.accountLabel || "已成功导入并验证";
    helper.credentials = true;
    showNotice("Firefox 登录状态已成功导入。", "good");
  } catch (error) { showNotice(error.message, "error"); }
  finally { setBusy(false); }
});

usageButton.addEventListener("click", async () => {
  usageButton.disabled = true;
  usageText.textContent = "正在查询 Mozilla 本月用量…";
  try { const response = await send({ type: "usage" }); usageText.textContent = formatUsageText(response.usage); }
  catch (error) { usageText.textContent = translateUiError(error.message); }
  finally { usageButton.disabled = false; }
});

openFolder.addEventListener("click", async () => { try { await send({ type: "openInstallFolder" }); } catch (error) { showNotice(error.message, "error"); } });
removeLocal.addEventListener("click", async () => {
  if (!confirm("删除本地组件？\n\n扩展会保留，但 VPN 将无法使用，直到重新安装本地组件。")) return;
  setBusy(true);
  try { await send({ type: "prepareRemoveLocal" }); showNotice("本地组件正在删除。", "good"); setTimeout(() => window.close(), 500); }
  catch (error) { showNotice(error.message, "error"); setBusy(false); }
});
fullUninstall.addEventListener("click", async () => {
  if (!confirm("完整卸载 Firefox IP Protection Bridge？\n\n这会关闭 VPN、删除本地组件和凭据，并从 Chrome 卸载扩展。")) return;
  setBusy(true);
  let token = null;
  try {
    const response = await send({ type: "prepareFullUninstall" });
    token = response.cleanupToken || null;
    await chrome.management.uninstallSelf({ showConfirmDialog: false });
  } catch (error) {
    if (token) { try { await send({ type: "cancelCleanup", token }); } catch (_) {} }
    showNotice(`卸载失败：${error.message}`, "error");
    setBusy(false);
  }
});

refreshStatus();

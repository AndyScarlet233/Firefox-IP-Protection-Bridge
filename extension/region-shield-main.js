(() => {
  // executeScript() can run this file on a frame that is already instrumented
  // (for example when the shield is switched on for tabs that were already
  // open). A second copy would capture the already-patched getters as its
  // "native" originals, which makes the overrides impossible to undo cleanly.
  if (globalThis.__ffipRegionShieldMainLoaded) return;
  globalThis.__ffipRegionShieldMainLoaded = true;

  const SOURCE = "ffip-region-shield";
  let config = { active:false, profile:{ country:"US", locale:"en-US", languages:["en-US","en"], timeZone:"America/New_York" } };
  let installed = false;

  const CN_FONTS = [
    "Microsoft YaHei", "Microsoft YaHei UI", "SimSun", "NSimSun", "SimHei", "KaiTi", "FangSong", "DengXian",
    "PingFang SC", "Hiragino Sans GB", "STHeiti", "STSong", "Songti SC", "Source Han Sans CN", "Source Han Sans SC",
    "Noto Sans CJK SC", "Noto Serif CJK SC", "WenQuanYi Micro Hei", "WenQuanYi Zen Hei",
    "MiSans", "MIUI", "HarmonyOS Sans SC", "HarmonyOS Sans", "HONOR Sans", "OPPO Sans", "vivo Sans",
    "Alibaba PuHuiTi", "Alibaba Sans", "DingTalk JinBuTi", "Douyin Sans", "HYQiHei",
    "FZShuSong-Z01S", "FZKai-Z03S", "FZHei-B01S", "FZFangSong-Z02S"
  ];
  const escapedFonts = CN_FONTS.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const cnFontRe = new RegExp(`(?:^|[\\s,'\"])(?:${escapedFonts.join("|")})(?=$|[\\s,'\"])`, "i");

  const native = {
    navLanguage: Object.getOwnPropertyDescriptor(Navigator.prototype, "language"),
    navLanguages: Object.getOwnPropertyDescriptor(Navigator.prototype, "languages"),
    getTimezoneOffset: Date.prototype.getTimezoneOffset,
    toLocaleString: Date.prototype.toLocaleString,
    toLocaleDateString: Date.prototype.toLocaleDateString,
    toLocaleTimeString: Date.prototype.toLocaleTimeString,
    dateToString: Date.prototype.toString,
    dateToTimeString: Date.prototype.toTimeString,
    intl: {},
    canvasMeasureText: globalThis.CanvasRenderingContext2D?.prototype?.measureText,
    offscreenMeasureText: globalThis.OffscreenCanvasRenderingContext2D?.prototype?.measureText,
    fontCheck: document?.fonts ? Object.getPrototypeOf(document.fonts)?.check : null
  };
  for (const name of ["DateTimeFormat","NumberFormat","Collator","RelativeTimeFormat","ListFormat","PluralRules","DisplayNames"]) {
    if (typeof Intl[name] === "function") native.intl[name] = Intl[name];
  }

  const wrappers = { intl:{} };
  function activeProfile() { return config?.active ? config.profile : null; }
  function safeDefine(target, prop, descriptor) { try { Object.defineProperty(target, prop, descriptor); return true; } catch (_) { return false; } }

  wrappers.navLanguageGet = function() {
    const p = activeProfile();
    if (p) return p.locale;
    return native.navLanguage?.get ? native.navLanguage.get.call(this) : undefined;
  };
  wrappers.navLanguagesGet = function() {
    const p = activeProfile();
    if (p) return Object.freeze([...p.languages]);
    return native.navLanguages?.get ? native.navLanguages.get.call(this) : undefined;
  };

  const NativeDTF = native.intl.DateTimeFormat || Intl.DateTimeFormat;
  function timezoneOffsetFor(date, timeZone) {
    try {
      const parts = new NativeDTF("en-US", {
        timeZone, year:"numeric", month:"2-digit", day:"2-digit",
        hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23"
      }).formatToParts(date);
      const m = Object.fromEntries(parts.filter(x => x.type !== "literal").map(x => [x.type, x.value]));
      const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
      return -Math.round((asUtc - date.getTime()) / 60000);
    } catch (_) { return native.getTimezoneOffset.call(date); }
  }

  wrappers.getTimezoneOffset = function() {
    const p = activeProfile();
    return p ? timezoneOffsetFor(this, p.timeZone) : native.getTimezoneOffset.call(this);
  };
  function makeDateLocaleWrapper(original) {
    return function(locales, options) {
      const p = activeProfile();
      if (!p) return original.call(this, locales, options);
      const nextLocales = locales == null ? p.locale : locales;
      const nextOptions = { ...(options || {}) };
      if (!nextOptions.timeZone) nextOptions.timeZone = p.timeZone;
      return original.call(this, nextLocales, nextOptions);
    };
  }
  wrappers.toLocaleString = makeDateLocaleWrapper(native.toLocaleString);
  wrappers.toLocaleDateString = makeDateLocaleWrapper(native.toLocaleDateString);
  wrappers.toLocaleTimeString = makeDateLocaleWrapper(native.toLocaleTimeString);
  wrappers.dateToString = function() {
    const p = activeProfile();
    if (!p) return native.dateToString.call(this);
    try { return new NativeDTF(p.locale, { timeZone:p.timeZone, dateStyle:"full", timeStyle:"long" }).format(this); }
    catch (_) { return native.dateToString.call(this); }
  };
  wrappers.dateToTimeString = function() {
    const p = activeProfile();
    if (!p) return native.dateToTimeString.call(this);
    try { return new NativeDTF(p.locale, { timeZone:p.timeZone, timeStyle:"long" }).format(this); }
    catch (_) { return native.dateToTimeString.call(this); }
  };

  function makeIntlWrapper(name, withTimeZone=false) {
    const Original = native.intl[name];
    if (typeof Original !== "function") return null;
    const normalize = (args) => {
      const p = activeProfile();
      if (!p) return args;
      const out = [...args];
      if (out[0] == null) out[0] = p.locale;
      if (withTimeZone) {
        const opts = { ...(out[1] || {}) };
        if (!opts.timeZone) opts.timeZone = p.timeZone;
        out[1] = opts;
      }
      return out;
    };
    return new Proxy(Original, {
      apply(target, thisArg, args) { return Reflect.construct(target, normalize(args), target); },
      construct(target, args, newTarget) { return Reflect.construct(target, normalize(args), newTarget); }
    });
  }
  wrappers.intl.DateTimeFormat = makeIntlWrapper("DateTimeFormat", true);
  for (const name of ["NumberFormat","Collator","RelativeTimeFormat","ListFormat","PluralRules","DisplayNames"]) wrappers.intl[name] = makeIntlWrapper(name, false);

  function fallbackFontFrom(cssFont) {
    const raw = String(cssFont || "");
    const match = raw.match(/^(.*?\b\d+(?:\.\d+)?(?:px|pt|em|rem|%))\s+(.+)$/i);
    const prefix = match ? match[1] : "72px";
    const families = (match ? match[2] : raw).split(",");
    const safe = families.filter((part) => !cnFontRe.test(part));
    return `${prefix} ${safe.length ? safe.join(",") : "sans-serif"}`;
  }
  function makeMeasureTextWrapper(nativeFn) {
    return function(text) {
      if (!activeProfile() || !cnFontRe.test(String(this.font || ""))) return nativeFn.call(this, text);
      const oldFont = this.font;
      try { this.font = fallbackFontFrom(oldFont); return nativeFn.call(this, text); }
      finally { try { this.font = oldFont; } catch (_) {} }
    };
  }
  wrappers.canvasMeasureText = typeof native.canvasMeasureText === "function" ? makeMeasureTextWrapper(native.canvasMeasureText) : null;
  wrappers.offscreenMeasureText = typeof native.offscreenMeasureText === "function" ? makeMeasureTextWrapper(native.offscreenMeasureText) : null;
  wrappers.fontCheck = typeof native.fontCheck === "function" ? function(font, text) {
    if (activeProfile() && cnFontRe.test(String(font || ""))) return false;
    return native.fontCheck.call(this, font, text);
  } : null;

  function installPatches() {
    if (installed || !config?.active) return;
    safeDefine(Navigator.prototype, "language", { configurable:true, get:wrappers.navLanguageGet });
    safeDefine(Navigator.prototype, "languages", { configurable:true, get:wrappers.navLanguagesGet });
    Date.prototype.getTimezoneOffset = wrappers.getTimezoneOffset;
    Date.prototype.toLocaleString = wrappers.toLocaleString;
    Date.prototype.toLocaleDateString = wrappers.toLocaleDateString;
    Date.prototype.toLocaleTimeString = wrappers.toLocaleTimeString;
    Date.prototype.toString = wrappers.dateToString;
    Date.prototype.toTimeString = wrappers.dateToTimeString;
    for (const [name, wrapper] of Object.entries(wrappers.intl)) if (wrapper) { try { Intl[name] = wrapper; } catch (_) {} }
    if (wrappers.canvasMeasureText && globalThis.CanvasRenderingContext2D?.prototype) globalThis.CanvasRenderingContext2D.prototype.measureText = wrappers.canvasMeasureText;
    if (wrappers.offscreenMeasureText && globalThis.OffscreenCanvasRenderingContext2D?.prototype) globalThis.OffscreenCanvasRenderingContext2D.prototype.measureText = wrappers.offscreenMeasureText;
    const fontProto = document?.fonts ? Object.getPrototypeOf(document.fonts) : null;
    if (fontProto && wrappers.fontCheck) fontProto.check = wrappers.fontCheck;
    installed = true;
  }

  function uninstallPatches() {
    if (!installed) return;
    try {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "language");
      if (d?.get === wrappers.navLanguageGet && native.navLanguage) Object.defineProperty(Navigator.prototype, "language", native.navLanguage);
    } catch (_) {}
    try {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "languages");
      if (d?.get === wrappers.navLanguagesGet && native.navLanguages) Object.defineProperty(Navigator.prototype, "languages", native.navLanguages);
    } catch (_) {}
    const restoreMethod = (obj, name, wrapper, original) => { try { if (obj[name] === wrapper) obj[name] = original; } catch (_) {} };
    restoreMethod(Date.prototype, "getTimezoneOffset", wrappers.getTimezoneOffset, native.getTimezoneOffset);
    restoreMethod(Date.prototype, "toLocaleString", wrappers.toLocaleString, native.toLocaleString);
    restoreMethod(Date.prototype, "toLocaleDateString", wrappers.toLocaleDateString, native.toLocaleDateString);
    restoreMethod(Date.prototype, "toLocaleTimeString", wrappers.toLocaleTimeString, native.toLocaleTimeString);
    restoreMethod(Date.prototype, "toString", wrappers.dateToString, native.dateToString);
    restoreMethod(Date.prototype, "toTimeString", wrappers.dateToTimeString, native.dateToTimeString);
    for (const [name, wrapper] of Object.entries(wrappers.intl)) if (wrapper && native.intl[name]) restoreMethod(Intl, name, wrapper, native.intl[name]);
    if (globalThis.CanvasRenderingContext2D?.prototype && wrappers.canvasMeasureText) restoreMethod(globalThis.CanvasRenderingContext2D.prototype, "measureText", wrappers.canvasMeasureText, native.canvasMeasureText);
    if (globalThis.OffscreenCanvasRenderingContext2D?.prototype && wrappers.offscreenMeasureText) restoreMethod(globalThis.OffscreenCanvasRenderingContext2D.prototype, "measureText", wrappers.offscreenMeasureText, native.offscreenMeasureText);
    const fontProto = document?.fonts ? Object.getPrototypeOf(document.fonts) : null;
    if (fontProto && wrappers.fontCheck) restoreMethod(fontProto, "check", wrappers.fontCheck, native.fontCheck);
    installed = false;
  }

  function applyConfig(next) {
    if (!next || typeof next !== "object") return;
    config = next;
    if (config.active) installPatches(); else uninstallPatches();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data?.type !== "config") return;
    applyConfig(event.data.config);
  });
  try { window.postMessage({ source: SOURCE, type: "request" }, "*"); } catch (_) {}
})();

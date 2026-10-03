(() => {
  // executeScript() can run this file on a frame that is already instrumented
  // (for example when the shield is switched on for tabs that were already
  // open). A second copy would stack duplicate listeners and handlers.
  if (window.__ffipRegionShieldBridgeLoaded) return;
  window.__ffipRegionShieldBridgeLoaded = true;

  const SOURCE = "ffip-region-shield";

  function publish(config) {
    try { window.postMessage({ source: SOURCE, type: "config", config }, "*"); } catch (_) {}
  }

  async function refresh() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "regionContentConfig", host: location.hostname || "" });
      if (response?.ok && response.config) publish(response.config);
    } catch (_) {
      publish({ active:false, profile:{ country:"US", locale:"en-US", languages:["en-US","en"], timeZone:"America/New_York" } });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data?.type !== "request") return;
    refresh();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "regionConfigPush" && message.config) {
      publish(message.config);
    }
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    // local holds the user preference; session holds VPN enabled/resolvedCountry.
    // Session changes may not be exposed to content scripts on every Chrome
    // build, so the Service Worker push above is the authoritative path.
    if (area === "local" || area === "session") refresh();
  });
  refresh();
})();

(() => {
  // Isolated-world half of the fingerprint shield: it asks the service worker
  // for this origin's configuration and forwards it to the MAIN-world patcher.
  // The seed is per-origin and per-session, so it has to be requested with the
  // hostname rather than read from storage here.
  if (window.__ffipFingerprintShieldBridgeLoaded) return;
  window.__ffipFingerprintShieldBridgeLoaded = true;

  const SOURCE = "ffip-fingerprint-shield";

  function publish(config) {
    try { window.postMessage({ source: SOURCE, type: "config", config }, "*"); } catch (_) {}
  }

  async function refresh() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "fingerprintContentConfig", host: location.hostname || "" });
      if (response?.ok && response.config) publish(response.config);
      else publish({ active: false, seed: 0 });
    } catch (_) {
      publish({ active: false, seed: 0 });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data?.type !== "request") return;
    refresh();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "fingerprintConfigPush" && message.config) publish(message.config);
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local" || area === "session") refresh();
  });
  refresh();
})();

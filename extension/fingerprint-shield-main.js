(() => {
  // Runs in the page's MAIN world at document_start, before any page script.
  //
  // What this can and cannot do is worth stating plainly, because the limits are
  // structural rather than a matter of effort:
  //
  // Brave randomises canvas, WebGL and audio readback inside the engine (C++),
  // so the perturbation is invisible to JavaScript and covers every readback
  // path. An extension can only wrap the JavaScript entry points, which means
  //   * only the paths reachable from script are covered,
  //   * the wrappers are detectable in principle, and
  //   * a detectable wrapper is itself a fingerprint if it is rare.
  //
  // So the design goals here are narrower and honest: make the *values* a site
  // reads unstable across sessions and origins, while keeping them stable within
  // one origin's session so that pages relying on self-consistency keep working.
  // Function.prototype.toString is patched so the wrappers do not advertise
  // themselves, which removes the cheapest detection route.
  //
  // Deliberately NOT done: ad or tracker blocking (a separate content blocker
  // already covers it), font-list restriction and screen-size spoofing (both
  // need engine support; faking them from script breaks layout), and blocking
  // permission-gated device APIs (low entropy once a permission is required).
  //
  // Known gap, measured rather than assumed: the configuration arrives over an
  // asynchronous message, so an inline page script that reads at parse time sees
  // the unpatched values. Everything from document_start onwards is covered. A
  // synchronous channel does not exist for an extension content script, so this
  // is the structural cost of doing the work in JavaScript at all.
  if (globalThis.__ffipFingerprintShieldMainLoaded) return;
  globalThis.__ffipFingerprintShieldMainLoaded = true;

  const SOURCE = "ffip-fingerprint-shield";
  let config = { active: false, seed: 0 };
  let installed = false;

  // -------------------------------------------------------------------------
  // Deterministic noise. Every value derives from (seed, position) and never
  // from a call counter: a fingerprinting script typically reads twice and
  // compares, so per-call randomness would both break pages and stand out.
  // -------------------------------------------------------------------------
  function mix(value) {
    let x = value | 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return (x ^ (x >>> 16)) >>> 0;
  }
  function noiseUnit(position) {
    // 0..1, deterministic for a given (seed, position)
    return mix((config.seed | 0) ^ mix(position | 0)) / 4294967296;
  }
  function sign(position) {
    return noiseUnit(position) < 0.5 ? -1 : 1;
  }

  // -------------------------------------------------------------------------
  // Detection hardening. Replacing a method without this is trivially visible:
  //   HTMLCanvasElement.prototype.toDataURL.toString()  ->  "function () { ... }"
  // Wrappers register their original source text so they report it back.
  // -------------------------------------------------------------------------
  const nativeToString = Function.prototype.toString;
  const reportedSource = new WeakMap();
  function hardenedToString() {
    const fake = reportedSource.get(this);
    if (typeof fake === "string") return fake;
    return nativeToString.call(this);
  }
  reportedSource.set(hardenedToString, nativeToString.call(nativeToString));

  function disguise(wrapper, original) {
    try {
      // If the original is already one of our wrappers (a re-install after the
      // seed changed, or an undo that could not restore), inherit its reported
      // source instead of copying the wrapper body, which would expose the
      // patch through toString.
      const inherited = reportedSource.get(original);
      reportedSource.set(wrapper, typeof inherited === "string" ? inherited : nativeToString.call(original));
    } catch (_) {}
    return wrapper;
  }
  function replaceMethod(target, name, factory) {
    if (!target) return null;
    const original = target[name];
    if (typeof original !== "function") return null;
    const wrapper = disguise(factory(original), original);
    try { target[name] = wrapper; } catch (_) { return null; }
    return { target, name, wrapper, original };
  }

  const undo = [];
  function safeDefine(target, prop, descriptor) {
    try { Object.defineProperty(target, prop, descriptor); return true; } catch (_) { return false; }
  }

  // -------------------------------------------------------------------------
  // Canvas
  // -------------------------------------------------------------------------
  function perturbPixels(data) {
    // Flip the low bit of one channel on a sparse, deterministic set of pixels.
    // Visually imperceptible (a 1/255 step on a subset of pixels) but enough to
    // change any hash a fingerprinter computes.
    const pixelCount = data.length >> 2;
    if (pixelCount <= 0) return data;
    const step = Math.max(1, Math.floor(pixelCount / 64));
    for (let pixel = 0; pixel < pixelCount; pixel += step) {
      const offset = pixel << 2;
      const channel = mix(pixel ^ config.seed) % 3; // never touch alpha
      const index = offset + channel;
      const delta = sign(pixel * 3 + channel);
      const next = data[index] + delta;
      data[index] = next < 0 ? 0 : next > 255 ? 255 : next;
    }
    return data;
  }

  function canvasCopyOf(source) {
    const width = source.width | 0;
    const height = source.height | 0;
    if (!width || !height) return null;
    const copy = document.createElement("canvas");
    copy.width = width;
    copy.height = height;
    const context = copy.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    try { context.drawImage(source, 0, 0); } catch (_) { return null; }
    return { copy, context };
  }

  function wrapCanvasReadback(proto, name) {
    // The receiver stays the canvas: toDataURL/toBlob are canvas methods, and
    // calling them on the staging context would throw "Illegal invocation".
    return replaceMethod(proto, name, (original) => function (...args) {
      if (!config.active) return original.apply(this, args);
      try {
        const staged = canvasCopyOf(this);
        if (staged) {
          const image = staged.context.getImageData(0, 0, staged.copy.width, staged.copy.height);
          perturbPixels(image.data);
          staged.context.putImageData(image, 0, 0);
          return original.apply(staged.copy, args);
        }
      } catch (_) { /* fall through to the untouched original */ }
      return original.apply(this, args);
    });
  }

  function wrapImageDataReadback(proto, name) {
    return replaceMethod(proto, name, (original) => function (...args) {
      const result = original.apply(this, args);
      if (config.active && result && result.data) {
        try { perturbPixels(result.data); } catch (_) {}
      }
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // WebGL
  // -------------------------------------------------------------------------
  // A small set of common adapter strings. Reporting a plausible one removes the
  // GPU model from the fingerprint without claiming hardware the machine lacks
  // in any way a shader compiler would notice.
  const GPU_VENDORS = ["Google Inc. (Intel)", "Google Inc. (NVIDIA)", "Google Inc. (AMD)"];
  const GPU_RENDERERS = [
    "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  ];
  const UNMASKED_VENDOR = 0x9245;
  const UNMASKED_RENDERER = 0x9246;

  function wrapWebGLGetParameter(proto) {
    return replaceMethod(proto, "getParameter", (original) => function (parameter) {
      if (config.active) {
        try {
          if (parameter === UNMASKED_VENDOR) return GPU_VENDORS[mix(config.seed) % GPU_VENDORS.length];
          if (parameter === UNMASKED_RENDERER) return GPU_RENDERERS[mix(config.seed ^ 0x9e37) % GPU_RENDERERS.length];
        } catch (_) {}
      }
      return original.call(this, parameter);
    });
  }

  function wrapWebGLReadPixels(proto) {
    return replaceMethod(proto, "readPixels", (original) => function (...args) {
      const result = original.apply(this, args);
      if (config.active) {
        // The destination is a typed array; perturb a few bytes in place.
        const pixels = args[6];
        try {
          if (pixels && typeof pixels.length === "number" && pixels.length) {
            const step = Math.max(1, Math.floor(pixels.length / 64));
            for (let i = 0; i < pixels.length; i += step) {
              const delta = sign(i ^ config.seed);
              const next = pixels[i] + delta;
              if (next >= 0 && next <= 255) pixels[i] = next;
            }
          }
        } catch (_) {}
      }
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------
  function perturbFloatArray(array) {
    if (!array || typeof array.length !== "number") return;
    const step = Math.max(1, Math.floor(array.length / 64));
    for (let i = 0; i < array.length; i += step) {
      const value = array[i];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      // Relative epsilon: inaudible, but far above the exact float a
      // fingerprinter hashes.
      array[i] = value + sign(i ^ config.seed) * (Math.abs(value) + 1e-9) * 1e-7;
    }
  }
  function perturbByteArray(array) {
    if (!array || typeof array.length !== "number") return;
    const step = Math.max(1, Math.floor(array.length / 64));
    for (let i = 0; i < array.length; i += step) {
      const value = array[i];
      if (typeof value !== "number") continue;
      const next = value + sign(i ^ config.seed);
      if (next >= 0 && next <= 255) array[i] = next;
    }
  }
  function wrapAudioArrayRead(proto, name, perturb) {
    return replaceMethod(proto, name, (original) => function (...args) {
      const result = original.apply(this, args);
      if (config.active) {
        try {
          // getChannelData returns the buffer; the others fill the argument.
          perturb(result && typeof result.length === "number" ? result : args[0]);
        } catch (_) {}
      }
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // Hardware hints. These are worth normalising rather than spoofing wildly:
  // pages size worker pools and buffers from them, so the value stays plausible
  // and only the exact machine-specific number is dropped.
  // -------------------------------------------------------------------------
  const CPU_CHOICES = [4, 8, 12, 16];
  const MEMORY_CHOICES = [4, 8];
  function normalizeTo(value, choices) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return value;
    let best = choices[0];
    for (const choice of choices) {
      if (Math.abs(choice - value) < Math.abs(best - value)) best = choice;
    }
    return best;
  }

  function installPatches() {
    if (installed || !config.active) return;

    // Canvas
    for (const proto of [globalThis.HTMLCanvasElement?.prototype, globalThis.OffscreenCanvas?.prototype]) {
      if (!proto) continue;
      const record = wrapCanvasReadback(proto, "toDataURL");
      if (record) undo.push(record);
    }
    for (const proto of [globalThis.HTMLCanvasElement?.prototype]) {
      if (!proto) continue;
      const record = wrapCanvasReadback(proto, "toBlob");
      if (record) undo.push(record);
    }
    const dataReadbacks = [
      [globalThis.CanvasRenderingContext2D?.prototype, "getImageData"],
      [globalThis.OffscreenCanvasRenderingContext2D?.prototype, "getImageData"]
    ];
    for (const [proto, name] of dataReadbacks) {
      if (!proto) continue;
      const record = wrapImageDataReadback(proto, name);
      if (record) undo.push(record);
    }

    // WebGL (both generations)
    for (const name of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
      const proto = globalThis[name]?.prototype;
      if (!proto) continue;
      const a = wrapWebGLGetParameter(proto);
      if (a) undo.push(a);
      const b = wrapWebGLReadPixels(proto);
      if (b) undo.push(b);
    }

    // Audio
    const analyser = globalThis.AnalyserNode?.prototype;
    if (analyser) {
      const a = wrapAudioArrayRead(analyser, "getFloatFrequencyData", perturbFloatArray);
      if (a) undo.push(a);
      const b = wrapAudioArrayRead(analyser, "getByteFrequencyData", perturbByteArray);
      if (b) undo.push(b);
      const c = wrapAudioArrayRead(analyser, "getFloatTimeDomainData", perturbFloatArray);
      if (c) undo.push(c);
    }
    const buffer = globalThis.AudioBuffer?.prototype;
    if (buffer) {
      const record = wrapAudioArrayRead(buffer, "getChannelData", perturbFloatArray);
      if (record) undo.push(record);
    }

    // Hardware hints
    const navProto = globalThis.Navigator?.prototype;
    if (navProto) {
      const cpuDescriptor = Object.getOwnPropertyDescriptor(navProto, "hardwareConcurrency");
      if (cpuDescriptor?.get) {
        const original = cpuDescriptor.get;
        const wrapper = disguise(function () { return normalizeTo(original.call(this), CPU_CHOICES); }, original);
        if (safeDefine(navProto, "hardwareConcurrency", { configurable: true, get: wrapper })) {
          undo.push({ restore: () => safeDefine(navProto, "hardwareConcurrency", cpuDescriptor) });
        }
      }
      const memoryDescriptor = Object.getOwnPropertyDescriptor(navProto, "deviceMemory");
      if (memoryDescriptor?.get) {
        const original = memoryDescriptor.get;
        const wrapper = disguise(function () { return normalizeTo(original.call(this), MEMORY_CHOICES); }, original);
        if (safeDefine(navProto, "deviceMemory", { configurable: true, get: wrapper })) {
          undo.push({ restore: () => safeDefine(navProto, "deviceMemory", memoryDescriptor) });
        }
      }
    }

    // Last, so the wrappers installed above are already registered with it.
    try { Function.prototype.toString = disguise(hardenedToString, nativeToString); } catch (_) {}
    installed = true;
  }

  function uninstallPatches() {
    if (!installed) return;
    while (undo.length) {
      const record = undo.pop();
      try {
        if (record.restore) record.restore();
        else if (record.target[record.name] === record.wrapper) record.target[record.name] = record.original;
      } catch (_) {}
    }
    try { Function.prototype.toString = nativeToString; } catch (_) {}
    installed = false;
  }

  function applyConfig(next) {
    if (!next || typeof next !== "object") return;
    const wasActive = config.active;
    const seedChanged = next.seed !== config.seed;
    config = { active: Boolean(next.active), seed: Number(next.seed) || 0 };
    if (!config.active) { uninstallPatches(); return; }
    if (!wasActive || seedChanged) {
      // A new seed means new values, so the wrappers have to be rebuilt.
      uninstallPatches();
      installPatches();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data?.type !== "config") return;
    applyConfig(event.data.config);
  });
  try { window.postMessage({ source: SOURCE, type: "request" }, "*"); } catch (_) {}
})();

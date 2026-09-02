const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Parse theme config from additionalArguments (synchronous, available on first load)
const themeArg = process.argv.find(a => a.startsWith("--theme-config="));
const themeConfig = themeArg ? JSON.parse(themeArg.slice("--theme-config=".length)) : null;

contextBridge.exposeInMainWorld("themeConfig", themeConfig);

contextBridge.exposeInMainWorld("electronAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  // PR #751 Codex review #12 (rework batch B-8, non-blocking): normalize a
  // non-finite value (NaN, +/-Infinity, or anything main.js might someday
  // send that isn't a plain number) to 0 right at the IPC bridge boundary,
  // instead of trusting main.js to always send a legal number. The renderer
  // side already defends against this independently (renderer.js's own
  // offset handlers), but that's a second, redundant line of defense, not a
  // reason to let an illegal value cross the bridge in the first place.
  onViewportOffset: (cb) => ipcRenderer.on("viewport-offset", (_, offsetY) => cb(Number.isFinite(offsetY) ? offsetY : 0)),
  onViewportOffsetX: (cb) => ipcRenderer.on("viewport-offset-x", (_, offsetX) => cb(Number.isFinite(offsetX) ? offsetX : 0)),
  onPetTintChange: (cb) => ipcRenderer.on("pet-tint-change", (_, payload) => cb(payload)),
  onPetAccessoryChange: (cb) => ipcRenderer.on("pet-accessory-change", (_, payload) => cb(payload)),
  onPetAccessorySlotsChange: (cb) => ipcRenderer.on("pet-accessory-slots-change", (_, snapshot) => cb(snapshot)),
  // State sync from main
  onStateChange: (callback) => ipcRenderer.on("state-change", (_, requestOrState, legacySvg) => callback(requestOrState, legacySvg)),
  onKimiPermissionPulse: (callback) => ipcRenderer.on("kimi-permission-pulse", () => callback()),
  onEyeMove: (callback) => ipcRenderer.on("eye-move", (_, dx, dy) => callback(dx, dy)),
  onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload)),
  onRoamHeading: (callback) => ipcRenderer.on("roam-heading", (_, headingLeft) => callback(headingLeft)),
  onWakeFromDoze: (callback) => ipcRenderer.on("wake-from-doze", () => callback()),
  onDndChange: (callback) => ipcRenderer.on("dnd-change", (_, enabled) => callback(enabled)),
  onMiniModeChange: (cb) => ipcRenderer.on("mini-mode-change", (_, enabled, edge, options) => cb(enabled, edge, options)),
  onMiniClip: (cb) => ipcRenderer.on("mini-clip", (_, info) => cb(info)),
  onLowPowerIdleModeChange: (cb) => ipcRenderer.on("low-power-idle-mode-change", (_, enabled) => cb(enabled)),
  onSystemWake: (cb) => ipcRenderer.on("system-wake", (_, payload) => cb(payload)),
  // Reaction control (from main, relayed from hit window)
  onStartDragReaction: (cb) => ipcRenderer.on("start-drag-reaction", (_, requestOrDirection, legacyDirection) => cb(requestOrDirection, legacyDirection)),
  onEndDragReaction: (cb) => ipcRenderer.on("end-drag-reaction", () => cb()),
  onPlayClickReaction: (cb) => ipcRenderer.on("play-click-reaction", (_, requestOrSvg, duration) => cb(requestOrSvg, duration)),
  onPlayTestReaction: (cb) => ipcRenderer.on("play-test-reaction", (_, result) => {
    if (result === "pass" || result === "fail") cb(result);
  }),
  // Sound playback (from main)
  onPreloadSounds: (cb) => ipcRenderer.on("preload-sounds", (_, payload) => cb(payload)),
  onPlaySound: (cb) => ipcRenderer.on("play-sound", (_, payload) => cb(payload)),
  onInvalidateSoundCache: (cb) => ipcRenderer.on("invalidate-sound-cache", (_, url) => cb(url)),
  reportSoundPlaybackError: (payload) => ipcRenderer.send("sound-playback-error", payload),
  // Render window → main (cursor polling control during reactions)
  pauseCursorPolling: () => ipcRenderer.send("pause-cursor-polling"),
  resumeFromReaction: () => ipcRenderer.send("resume-from-reaction"),
  notifyPetVisualReady: () => ipcRenderer.send("pet-visual-ready"),
  notifyPetVisualSettled: (payload) => {
    if (!payload || typeof payload !== "object") return;
    const safe = {
      themeId: typeof payload.themeId === "string" ? payload.themeId : null,
      displayState: typeof payload.displayState === "string" ? payload.displayState : null,
      requestedFile: typeof payload.requestedFile === "string" ? payload.requestedFile : null,
      actualFile: typeof payload.actualFile === "string" ? payload.actualFile : null,
      channel: typeof payload.channel === "string" ? payload.channel : null,
      verified: payload.verified === true,
      visualGeneration: Number.isSafeInteger(payload.visualGeneration) ? payload.visualGeneration : null,
      outcome: typeof payload.outcome === "string" ? payload.outcome : null,
    };
    ipcRenderer.send("pet-visual-settled", safe);
  },
  setLowPowerIdlePaused: (paused) => ipcRenderer.send("low-power-idle-paused", !!paused),
  reportSystemWakeStatus: (payload) => ipcRenderer.send("system-wake-status", payload),
  reportAccessoryMirror: (mirrored) => ipcRenderer.send("accessory-mirror", !!mirrored),
});

// Default-off Linux/niri single-window input bridge. The render page receives
// only the same narrow interaction contract as preload-hit.js plus the two-step
// ownership handshake; no Electron object crosses the context bridge.
contextBridge.exposeInMainWorld("petInputAPI", {
  notifyReady: (payload) => ipcRenderer.send("pet-input-ready", payload),
  onBootstrap: (cb) => ipcRenderer.on("pet-input-bootstrap", (_, payload) => cb(payload)),
  ackBootstrap: (payload) => ipcRenderer.send("pet-input-bootstrap-ack", payload),
  onEnabled: (cb) => ipcRenderer.on("pet-input-enabled", (_, payload) => cb(payload)),
  ackEnabled: (payload) => ipcRenderer.send("pet-input-enabled-ack", payload),
  dragLock: (locked, details) => ipcRenderer.send(
    "drag-lock",
    locked ? { locked: true, ...(details || {}) } : { locked: false },
  ),
  dragMove: (payload) => ipcRenderer.send("drag-move", payload),
  dragEnd: () => ipcRenderer.send("drag-end"),
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ""; } catch (_) { return ""; }
  },
  dropPaths: (paths) => ipcRenderer.send("pet-drop-paths", paths),
  onDropAccepted: (cb) => ipcRenderer.on("pet-drop-accepted", () => cb()),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  showDashboard: () => ipcRenderer.send("pet-interaction:show-dashboard"),
  revealSessionHud: () => ipcRenderer.send("pet-interaction:reveal-session-hud"),
  startDragReaction: (direction) => ipcRenderer.send("start-drag-reaction", direction),
  endDragReaction: () => ipcRenderer.send("end-drag-reaction"),
  playClickReaction: (svg, duration) => ipcRenderer.send("play-click-reaction", svg, duration),
  // Keep the input controller's narrow hit config off the renderer's visual
  // theme channel. Both APIs live in this preload, so sharing "theme-config"
  // would deliver each incompatible payload to both consumers.
  onThemeConfig: (cb) => ipcRenderer.on("pet-input-theme-config", (_, config) => cb(config)),
  onStateSync: (cb) => ipcRenderer.on("hit-state-sync", (_, state) => cb(state)),
  onCancelReaction: (cb) => ipcRenderer.on("hit-cancel-reaction", () => cb()),
});

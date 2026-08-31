const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Parse hit-renderer theme config from additionalArguments (synchronous, available on first load)
const hitThemeArg = process.argv.find(a => a.startsWith("--hit-theme-config="));
const hitThemeConfig = hitThemeArg ? JSON.parse(hitThemeArg.slice("--hit-theme-config=".length)) : null;

// Parse platform from additionalArguments so hit-renderer can branch on
// macOS-specific input semantics (Cmd vs Ctrl, Ctrl-click = right-click, etc.).
const platformArg = process.argv.find(a => a.startsWith("--hit-platform="));
const platform = platformArg ? platformArg.slice("--hit-platform=".length) : process.platform;
// Main adds this private renderer argument only for CLAWD_WINDOW_DEBUG=1.
const dragDiagnosticsEnabled = process.argv.includes("--hit-drag-diagnostics=1");

contextBridge.exposeInMainWorld("hitThemeConfig", hitThemeConfig);
contextBridge.exposeInMainWorld("hitPlatform", {
  isMac: platform === "darwin",
  platform,
});
contextBridge.exposeInMainWorld("hitDiagnostics", {
  drag: dragDiagnosticsEnabled,
});

contextBridge.exposeInMainWorld("hitAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  // Sends → main
  dragLock: (locked, diagnosticSample) => (
    diagnosticSample === undefined
      ? ipcRenderer.send("drag-lock", locked)
      : ipcRenderer.send("drag-lock", locked, diagnosticSample)
  ),
  dragMove: (diagnosticSample) => (
    diagnosticSample === undefined
      ? ipcRenderer.send("drag-move")
      : ipcRenderer.send("drag-move", diagnosticSample)
  ),
  dragEnd: () => ipcRenderer.send("drag-end"),
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  focusTerminal: () => ipcRenderer.send("focus-terminal"),
  // OS file drop (#459). File → absolute path must resolve here in the
  // preload: Electron ≥32 removed File.path from the renderer, and
  // webUtils.getPathForFile only accepts a File passed across the bridge.
  // Returns "" for non-filesystem Files (e.g. images dragged from a browser).
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ""; } catch (_) { return ""; }
  },
  dropPaths: (paths) => ipcRenderer.send("pet-drop-paths", paths),
  onDropAccepted: (cb) => ipcRenderer.on("pet-drop-accepted", () => cb()),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  showDashboard: () => ipcRenderer.send("show-dashboard"),
  revealSessionHud: () => ipcRenderer.send("pet-interaction:reveal-session-hud"),
  // Reaction triggers → main → renderWin
  startDragReaction: (direction) => ipcRenderer.send("start-drag-reaction", direction),
  endDragReaction: () => ipcRenderer.send("end-drag-reaction"),
  playClickReaction: (svg, duration) => ipcRenderer.send("play-click-reaction", svg, duration),
  // State sync ← main
  onStateSync: (cb) => ipcRenderer.on("hit-state-sync", (_, data) => cb(data)),
  onCancelReaction: (cb) => ipcRenderer.on("hit-cancel-reaction", () => cb()),
});

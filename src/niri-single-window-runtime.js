"use strict";

const crypto = require("node:crypto");
const { parseOzonePlatformFromArgv } = require("./linux-ozone");
const { createLinuxX11InputRegion } = require("./linux-x11-input-region");
const { NiriDragController } = require("./niri-drag-controller");
const { createNiriEventStream, createNiriIpcClient } = require("./niri-ipc-client");
const { NiriPlacementState } = require("./niri-placement-state");
const { PetInputOwner } = require("./pet-input-owner");

const MODE = "niri-ipc-single";
const APP_ID = "clawd-on-desk";
const DEFAULT_TIMEOUT_MS = 3000;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function evaluateNiriSingleWindowGate(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  if (env.CLAWD_WINDOW_PLACEMENT !== MODE) return { enabled: false, reason: "not-requested" };
  if (platform !== "linux" || arch !== "x64") return { enabled: false, reason: "unsupported-platform" };
  if (!nonEmpty(env.NIRI_SOCKET)) return { enabled: false, reason: "missing-niri-socket" };
  if (!nonEmpty(env.DISPLAY)) return { enabled: false, reason: "missing-display" };
  const underWayland = String(env.XDG_SESSION_TYPE || "").trim().toLowerCase() === "wayland"
    || nonEmpty(env.WAYLAND_DISPLAY);
  if (!underWayland) return { enabled: false, reason: "not-wayland-session" };
  if (String(parseOzonePlatformFromArgv(argv) || "").trim().toLowerCase() !== "x11") {
    return { enabled: false, reason: "not-x11-ozone" };
  }
  return { enabled: true, reason: "enabled", socketPath: env.NIRI_SOCKET.trim() };
}

function createWindowTitle(randomBytes = crypto.randomBytes) {
  return `Clawd niri ${randomBytes(12).toString("hex")}`;
}

function validReady(payload) {
  return !!payload
    && Number.isFinite(payload.innerWidth)
    && Number.isFinite(payload.innerHeight)
    && payload.innerWidth > 0
    && payload.innerHeight > 0;
}

function sameReady(a, b) {
  return validReady(a) && validReady(b)
    && a.innerWidth === b.innerWidth
    && a.innerHeight === b.innerHeight;
}

function localHitRect(globalRect, windowRect) {
  if (!globalRect || !windowRect) throw new Error("niri input geometry is incomplete");
  const values = [globalRect.left, globalRect.top, globalRect.right, globalRect.bottom];
  if (!values.every(Number.isFinite)) throw new Error("niri hit rect is invalid");
  const rect = {
    x: globalRect.left - windowRect.x,
    y: globalRect.top - windowRect.y,
    width: globalRect.right - globalRect.left,
    height: globalRect.bottom - globalRect.top,
  };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) {
    throw new Error("niri local hit rect is empty or invalid");
  }
  return rect;
}

class NiriSingleWindowRuntime {
  constructor(options = {}) {
    this.socketPath = options.socketPath;
    this.title = options.title;
    this.appId = options.appId || APP_ID;
    this.getRenderWindow = options.getRenderWindow || (() => null);
    this.getHitWindow = options.getHitWindow || (() => null);
    this.getHitRectScreen = options.getHitRectScreen;
    this.getThemeConfig = options.getThemeConfig || (() => ({}));
    this.getInputState = options.getInputState || (() => ({}));
    this.sendToRender = options.sendToRender;
    this.setHitSuppressed = options.setHitSuppressed;
    this.hideHit = options.hideHit;
    this.showHit = options.showHit;
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.onFatal = typeof options.onFatal === "function" ? options.onFatal : () => {};
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : () => {};
    this.onDragSettled = typeof options.onDragSettled === "function" ? options.onDragSettled : () => {};
    this.onDragCancelled = typeof options.onDragCancelled === "function" ? options.onDragCancelled : () => {};
    this.canHandoffInput = typeof options.canHandoffInput === "function"
      ? options.canHandoffInput
      : () => true;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    if (!nonEmpty(this.socketPath) || !nonEmpty(this.title)) throw new TypeError("niri socketPath and title are required");
    for (const name of ["getHitRectScreen", "sendToRender", "setHitSuppressed", "hideHit", "showHit"]) {
      if (typeof this[name] !== "function") throw new TypeError(`${name} is required`);
    }

    const commandFactory = options.commandFactory || createNiriIpcClient;
    const eventFactory = options.eventFactory || createNiriEventStream;
    this.command = commandFactory({ socketPath: this.socketPath, timeoutMs: this.timeoutMs });
    this.state = options.placementState || new NiriPlacementState();
    this.stream = eventFactory({
      socketPath: this.socketPath,
      timeoutMs: this.timeoutMs,
      onEvent: (event) => this._onEvent(event),
      onError: (error) => this._failClosed(error, "event-stream"),
    });
    this.createInputRegion = options.createInputRegion || createLinuxX11InputRegion;
    this.status = "idle";
    this.windowId = null;
    this.inputRegion = null;
    this.ready = null;
    this.preparedRect = null;
    this.readyWaiters = [];
    this.windowWaiters = [];
    this.ackWaiters = new Map();
    this.generation = 0;
    this.refreshPromise = null;
    this.ownerTransition = null;
    this.pendingRefresh = false;
    this.disposed = false;
    this.fatalError = null;
    this.backendDisposed = false;
    this.drag = new NiriDragController({
      sendMove: (delta) => this.command.moveFloatingWindowAdjust({ id: this.windowId, ...delta }),
      readOrigin: () => this._readSnapshotOrigin(),
      getRefreshIntervalMs: () => this.state.getRefreshIntervalMs(this.windowId),
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onError: (error) => this._failClosed(error, "drag"),
      onDiagnostic: (entry) => this._diagnose("drag", entry),
    });
    this.owner = new PetInputOwner({
      prepareRender: () => this._prepareRender(),
      enableRender: () => this._enableRender(),
      disableRender: () => this._disableRender(),
      suppressRender: () => this.inputRegion && this.inputRegion.suppress(),
      applyRenderRegion: () => this._applyRenderRegion(),
      suppressHit: () => this.setHitSuppressed(true),
      canSwitchFromHit: () => this.canHandoffInput() === true,
      validatePreparedRender: () => this._validatePreparedRender(),
      restoreHit: async () => {
        this.showHit();
        this.setHitSuppressed(false);
      },
      hideHit: () => this.hideHit(),
      onError: (error, phase) => this._report(error, `input-owner:${phase}`),
    });
  }

  async start() {
    if (this.disposed || this.status !== "idle") return false;
    this.status = "starting";
    try {
      const version = await this.command.version();
      if (!/^26\.04(?:\b|\s|\()/.test(version)) {
        throw new Error(`unsupported niri version: ${version}`);
      }
      await this.stream.start();
      this._throwIfFailed();
      this.state.replaceOutputs(await this.command.outputs());
      this._throwIfFailed();
      const tracked = await this._waitForTrackedWindow();
      this._throwIfFailed();
      this.windowId = tracked.id;
      const rect = this.getBounds();
      if (!rect) throw new Error("tracked niri window has incomplete geometry");
      this.inputRegion = this.createInputRegion({
        window: this.getRenderWindow(),
        logicalSize: { width: rect.width, height: rect.height },
      });
      this.inputRegion.suppress();
      if (!await this.owner.activate()) throw new Error("input ownership activation failed");
      this.status = "active";
      this._diagnose("active", { windowId: this.windowId, rect });
      return true;
    } catch (error) {
      this.status = "fallback";
      this._report(error, "startup");
      this._disposeBackend();
      return false;
    }
  }

  handleRenderReady(payload) {
    if (this.disposed || !validReady(payload)) return false;
    this.ready = { innerWidth: payload.innerWidth, innerHeight: payload.innerHeight };
    while (this.readyWaiters.length) this.readyWaiters.shift().resolve(this.ready);
    if (!this.fatalError && this.status === "active" && this.owner.snapshot().state === "input-disabled") {
      this.scheduleRefresh("render-ready");
    } else if (!this.fatalError && this.status === "active" && this.ownerTransition) {
      void this.ownerTransition.then(() => this.scheduleRefresh("render-ready"));
    }
    return true;
  }

  handleBootstrapAck(payload) {
    return this._resolveAck("bootstrap", payload && payload.generation, payload);
  }

  handleEnabledAck(payload) {
    return this._resolveAck("enabled", payload && payload.generation, payload);
  }

  handleRenderLoading() {
    this.ready = null;
    this._rejectAcks(new Error("render document changed during input handshake"));
    if (this.status !== "active") return;
    const drag = this.drag.getSnapshot();
    if (drag.active || drag.ending || drag.inFlight) {
      this.drag.cancel();
      try { this.onDragCancelled(); } catch {}
    }
    if (this.ownerTransition) return;
    this.ownerTransition = this.owner.renderUnavailable()
      .finally(() => { this.ownerTransition = null; });
  }

  acceptsRenderInput() {
    return this.status === "active" && !this.fatalError && this.owner.accepts("render");
  }

  isActive() {
    return this.status === "active";
  }

  protectsMappedRender() {
    return this.status === "starting" || this.status === "active";
  }

  getBounds() {
    return Number.isSafeInteger(this.windowId) ? this.state.getWindowRect(this.windowId) : null;
  }

  applyBounds(bounds) {
    if (!this.isActive() || this.fatalError || !bounds) return null;
    const win = this.getRenderWindow();
    const current = this.getBounds();
    if (!win || !current) return null;
    const width = Math.round(bounds.width);
    const height = Math.round(bounds.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      && (width !== current.width || height !== current.height)
      && typeof win.setSize === "function") {
      win.setSize(width, height);
    }
    return { ...current };
  }

  syncInputGeometry(reason = "geometry") {
    if (!this.isActive() || this.fatalError) return { applied: false, deferred: false };
    this.scheduleRefresh(reason);
    return { applied: false, deferred: true };
  }

  scheduleRefresh(reason = "refresh") {
    if (this.disposed || this.fatalError || this.status !== "active") return Promise.resolve(false);
    if (this.drag.getSnapshot().active || this.drag.getSnapshot().ending) {
      this.pendingRefresh = true;
      return Promise.resolve(false);
    }
    if (this.refreshPromise) {
      this.pendingRefresh = true;
      return this.refreshPromise;
    }
    this.refreshPromise = this._refresh(reason).finally(() => {
      this.refreshPromise = null;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        void this.scheduleRefresh("coalesced");
      }
    });
    return this.refreshPromise;
  }

  async _refresh(reason) {
    if (this.ownerTransition) await this.ownerTransition;
    const snapshot = this.owner.snapshot();
    if (snapshot.state === "single-active") await this.owner.renderUnavailable();
    const ok = await this.owner.recoverSingle();
    this._diagnose("refresh", { reason, ok });
    if (!ok) this._report(new Error("render input recovery failed"), `refresh:${reason}`);
    return ok;
  }

  beginDrag(payload) {
    if (!this.acceptsRenderInput()) return false;
    const windowRect = this.getBounds();
    return this.drag.begin({ ...payload, windowRect });
  }

  moveDrag(payload) {
    if (!this.acceptsRenderInput()) return false;
    return this.drag.pointerMove(payload);
  }

  async endDrag() {
    const snapshot = await this.drag.end();
    try { this.onDragSettled(this.getBounds(), snapshot); } catch {}
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      void this.scheduleRefresh("after-drag");
    }
    return snapshot;
  }

  forwardControllerMessage(channel, ...args) {
    if (!this.isActive() || this.fatalError) return false;
    if (channel !== "hit-state-sync" && channel !== "theme-config" && channel !== "hit-cancel-reaction") {
      return false;
    }
    const renderChannel = channel === "theme-config" ? "pet-input-theme-config" : channel;
    this.sendToRender(renderChannel, ...args);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.status = "disposed";
    this._rejectAcks(new Error("niri single-window runtime disposed"));
    while (this.readyWaiters.length) this.readyWaiters.shift().reject(new Error("runtime disposed"));
    while (this.windowWaiters.length) this.windowWaiters.shift().reject(new Error("runtime disposed"));
    try { this._disableRender(); } catch {}
    try { if (this.inputRegion) this.inputRegion.suppress(); } catch {}
    this._disposeBackend();
  }

  async _prepareRender() {
    this.preparedRect = null;
    let ready = await this._waitForReady();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rect = this.getBounds();
      if (!rect) throw new Error("niri compositor geometry unavailable during bootstrap");
      this.inputRegion.recalibrate({ width: rect.width, height: rect.height });
      const hitRect = localHitRect(this.getHitRectScreen(rect), rect);
      const generation = ++this.generation;
      const logicalPerCss = {
        x: rect.width / ready.innerWidth,
        y: rect.height / ready.innerHeight,
      };
      const ackPromise = this._waitForAck("bootstrap", generation);
      this.sendToRender("pet-input-bootstrap", {
        generation,
        rect: hitRect,
        logicalPerCss,
        themeConfig: this.getThemeConfig() || {},
        state: this.getInputState() || {},
      });
      const ack = await ackPromise;
      if (!ack || ack.ok !== true || !validReady(ack)) throw new Error("render rejected input bootstrap");
      this.ready = { innerWidth: ack.innerWidth, innerHeight: ack.innerHeight };
      const current = this.getBounds();
      const geometryStable = current
        && current.x === rect.x && current.y === rect.y
        && current.width === rect.width && current.height === rect.height
        && current.output === rect.output && current.scale === rect.scale;
      if (sameReady(ready, ack) && geometryStable) {
        this.currentRegion = hitRect;
        this.preparedRect = { ...rect };
        return true;
      }
      ready = this.ready;
    }
    throw new Error("render input geometry did not stabilize during bootstrap");
  }

  async _enableRender() {
    const generation = this.generation;
    const ackPromise = this._waitForAck("enabled", generation);
    this.sendToRender("pet-input-enabled", { generation, enabled: true });
    const ack = await ackPromise;
    if (!ack || ack.ok !== true || ack.enabled !== true || !sameReady(this.ready, ack)) {
      throw new Error("render rejected input enable or changed viewport");
    }
  }

  _disableRender() {
    if (!this.generation) return;
    this.sendToRender("pet-input-enabled", { generation: this.generation, enabled: false });
  }

  _applyRenderRegion() {
    if (!this.currentRegion) throw new Error("render input region was not prepared");
    return this.inputRegion.applyLogicalRect(this.currentRegion);
  }

  _validatePreparedRender() {
    const current = this.getBounds();
    const prepared = this.preparedRect;
    return !!current && !!prepared
      && current.x === prepared.x && current.y === prepared.y
      && current.width === prepared.width && current.height === prepared.height
      && current.output === prepared.output && current.scale === prepared.scale;
  }

  _waitForReady() {
    if (this.ready) return Promise.resolve(this.ready);
    return this._wait(this.readyWaiters, "render input ready timeout");
  }

  _waitForTrackedWindow() {
    const current = this.state.findExactWindow({ title: this.title, appId: this.appId });
    if (current && this.state.getWindowRect(current.id)) return Promise.resolve(current);
    return this._wait(this.windowWaiters, "niri window discovery timeout");
  }

  _notifyTrackedWindowWaiters() {
    if (this.windowWaiters.length === 0) return;
    const tracked = this.state.findExactWindow({ title: this.title, appId: this.appId });
    if (!tracked || !this.state.getWindowRect(tracked.id)) return;
    while (this.windowWaiters.length) this.windowWaiters.shift().resolve(tracked);
  }

  _wait(list, message) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = this.setTimer(() => {
        const index = list.indexOf(waiter);
        if (index >= 0) list.splice(index, 1);
        reject(new Error(message));
      }, this.timeoutMs);
      const wrap = (fn) => (value) => { this.clearTimer(waiter.timer); fn(value); };
      waiter.resolve = wrap(resolve);
      waiter.reject = wrap(reject);
      list.push(waiter);
    });
  }

  _waitForAck(kind, generation) {
    const key = `${kind}:${generation}`;
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.ackWaiters.delete(key);
        reject(new Error(`${kind} acknowledgement timeout`));
      }, this.timeoutMs);
      this.ackWaiters.set(key, {
        resolve: (value) => { this.clearTimer(timer); resolve(value); },
        reject: (error) => { this.clearTimer(timer); reject(error); },
      });
    });
  }

  _resolveAck(kind, generation, payload) {
    if (!Number.isSafeInteger(generation)) return false;
    const key = `${kind}:${generation}`;
    const waiter = this.ackWaiters.get(key);
    if (!waiter) return false;
    this.ackWaiters.delete(key);
    waiter.resolve(payload);
    return true;
  }

  _rejectAcks(error) {
    for (const waiter of this.ackWaiters.values()) waiter.reject(error);
    this.ackWaiters.clear();
  }

  _onEvent(event) {
    if (this.disposed || this.fatalError) return;
    const before = this.getBounds();
    this.state.applyEvent(event);
    if (!Number.isSafeInteger(this.windowId)) this._notifyTrackedWindowWaiters();
    if (event && Object.prototype.hasOwnProperty.call(event, "ConfigLoaded")) {
      void this._refreshOutputs();
    }
    if (Number.isSafeInteger(this.windowId)
      && event && event.WindowClosed && event.WindowClosed.id === this.windowId) {
      this._failClosed(new Error("tracked niri window closed"), "window-closed");
      return;
    }
    const after = this.getBounds();
    if (after) this.drag.observeOrigin(after, "event");
    if (this.status === "active" && before && after
      && (before.width !== after.width || before.height !== after.height
        || before.output !== after.output || before.scale !== after.scale)) {
      this.scheduleRefresh("compositor-resize");
    }
  }

  async _refreshOutputs() {
    if (this.disposed || this.fatalError) return;
    try {
      const before = this.getBounds();
      this.state.replaceOutputs(await this.command.outputs());
      this._notifyTrackedWindowWaiters();
      const rect = this.getBounds();
      if (rect) this.drag.observeOrigin(rect, "outputs");
      if (this.status === "active" && before && rect
        && (before.width !== rect.width || before.height !== rect.height
          || before.output !== rect.output || before.scale !== rect.scale)) {
        this.scheduleRefresh("outputs-change");
      }
    } catch (error) {
      this._failClosed(error, "outputs-refresh");
    }
  }

  async _readSnapshotOrigin() {
    const windows = await this.command.windows();
    const snapshot = new NiriPlacementState();
    snapshot.outputs = new Map(this.state.outputs);
    snapshot.workspaces = new Map(this.state.workspaces);
    snapshot.replaceWindows(windows);
    return snapshot.getWindowRect(this.windowId);
  }

  _failClosed(error, phase) {
    if (this.disposed || this.status === "fallback" || this.fatalError) return;
    const wasActive = this.status === "active";
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    this._report(this.fatalError, phase);
    if (wasActive) {
      try { this.onFatal(this.fatalError, phase); } catch {}
    }
    this._rejectAcks(this.fatalError);
    while (this.readyWaiters.length) this.readyWaiters.shift().reject(this.fatalError);
    while (this.windowWaiters.length) this.windowWaiters.shift().reject(this.fatalError);
    if (wasActive) {
      void this.owner.renderUnavailable().finally(() => this._disposeBackend());
    } else {
      this._disposeBackend();
    }
  }

  _disposeBackend() {
    if (this.backendDisposed) return;
    this.backendDisposed = true;
    try { if (this.inputRegion) this.inputRegion.dispose(); } catch (error) { this._report(error, "input-region-dispose"); }
    this.inputRegion = null;
    try { this.stream.close(); } catch {}
    try { this.command.close(); } catch {}
  }

  _throwIfFailed() {
    if (this.fatalError) throw this.fatalError;
  }

  _report(error, phase) {
    try { this.onError(error instanceof Error ? error : new Error(String(error)), phase); } catch {}
  }

  _diagnose(type, payload) {
    try { this.onDiagnostic({ type, ...(payload || {}) }); } catch {}
  }
}

module.exports = {
  APP_ID,
  MODE,
  NiriSingleWindowRuntime,
  createWindowTitle,
  evaluateNiriSingleWindowGate,
  localHitRect,
};

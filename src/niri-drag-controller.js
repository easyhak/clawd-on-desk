"use strict";

const DEFAULT_MAX_STEP = 9;
const DEFAULT_EPSILON = 1e-6;

function finitePoint(point) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function samePoint(a, b, epsilon = DEFAULT_EPSILON) {
  return finitePoint(a) && finitePoint(b)
    && Math.abs(a.x - b.x) <= epsilon
    && Math.abs(a.y - b.y) <= epsilon;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function vectorLength(vector) {
  return Math.hypot(vector.x, vector.y);
}

function clampVector(vector, maxLength = DEFAULT_MAX_STEP) {
  const length = vectorLength(vector);
  if (!Number.isFinite(length) || length === 0) return { x: 0, y: 0 };
  if (length <= maxLength) return { x: vector.x, y: vector.y };
  const ratio = maxLength / length;
  return { x: vector.x * ratio, y: vector.y * ratio };
}

class NiriDragController {
  constructor(options = {}) {
    if (typeof options.sendMove !== "function") throw new TypeError("sendMove is required");
    if (typeof options.readOrigin !== "function") throw new TypeError("readOrigin is required");
    this.sendMove = options.sendMove;
    this.readOrigin = options.readOrigin;
    this.getRefreshIntervalMs = typeof options.getRefreshIntervalMs === "function"
      ? options.getRefreshIntervalMs
      : () => 16.667;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : () => {};
    this.maxStep = Number.isFinite(options.maxStep) && options.maxStep > 0
      ? Math.min(options.maxStep, 9.999)
      : DEFAULT_MAX_STEP;
    this.epsilon = Number.isFinite(options.epsilon) && options.epsilon > 0
      ? options.epsilon
      : DEFAULT_EPSILON;
    this.scaleTolerance = Number.isFinite(options.scaleTolerance) && options.scaleTolerance >= 0
      ? options.scaleTolerance
      : 0.01;
    this.reset();
  }

  reset() {
    if (this.inFlight && this.inFlight.timer) this.clearTimer(this.inFlight.timer);
    this.active = false;
    this.ending = false;
    this.failed = false;
    this.grab = null;
    this.scale = null;
    this.startOrigin = null;
    this.confirmedOrigin = null;
    this.latestPointer = null;
    this.latestP = { x: 0, y: 0 };
    this.pointerGeneration = 0;
    this.blockedPointerGeneration = null;
    this.inFlight = null;
    this.settleWaiters = [];
  }

  begin(payload = {}) {
    if (this.active || this.ending || this.inFlight) return false;
    const { grabX, grabY, innerWidth, innerHeight, windowRect } = payload;
    if (![grabX, grabY, innerWidth, innerHeight].every(Number.isFinite)) return false;
    if (innerWidth <= 0 || innerHeight <= 0 || !windowRect || !finitePoint(windowRect)) return false;
    if (!Number.isFinite(windowRect.width) || !Number.isFinite(windowRect.height)) return false;
    if (windowRect.width <= 0 || windowRect.height <= 0) return false;
    const scaleX = windowRect.width / innerWidth;
    const scaleY = windowRect.height / innerHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return false;
    if (Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) > this.scaleTolerance) return false;

    this.reset();
    this.active = true;
    this.grab = { x: grabX, y: grabY };
    this.scale = { x: scaleX, y: scaleY };
    this.startOrigin = { x: windowRect.x, y: windowRect.y };
    this.confirmedOrigin = { ...this.startOrigin };
    this.latestPointer = { x: grabX, y: grabY };
    this._diagnose("begin");
    return true;
  }

  pointerMove(payload = {}) {
    if (!this.active || this.ending || this.failed) return false;
    const point = { x: payload.clientX, y: payload.clientY };
    if (!finitePoint(point)) return false;
    if (samePoint(point, this.latestPointer, this.epsilon)) return true;
    this.latestPointer = point;
    this.latestP = {
      x: (point.x - this.grab.x) * this.scale.x,
      y: (point.y - this.grab.y) * this.scale.y,
    };
    this.pointerGeneration += 1;
    this.blockedPointerGeneration = null;
    this._diagnose("pointer");
    this._pump();
    return true;
  }

  observeOrigin(origin, source = "event") {
    if (this.failed || !finitePoint(origin)) return false;
    const next = { x: origin.x, y: origin.y };
    const changed = !samePoint(next, this.confirmedOrigin, this.epsilon);
    if (changed) {
      this.confirmedOrigin = next;
      if (this.blockedPointerGeneration === this.pointerGeneration) {
        this.blockedPointerGeneration = null;
      }
    }
    const pending = this.inFlight;
    if (pending && !samePoint(next, pending.beforeOrigin, this.epsilon)) {
      pending.observed = true;
      pending.observationSource = source;
      if (pending.handled) this._finishPending(false);
    }
    if (changed) {
      this._diagnose("origin", { source });
      if (!this.inFlight) this._pump();
    }
    return changed;
  }

  end() {
    this.active = false;
    this.ending = true;
    this._diagnose("end");
    if (!this.inFlight) {
      this.ending = false;
      return Promise.resolve(this.getSnapshot());
    }
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  cancel() {
    const waiters = this.settleWaiters.slice();
    this.reset();
    const snapshot = this.getSnapshot();
    for (const resolve of waiters) resolve(snapshot);
    this._diagnose("cancel");
    return snapshot;
  }

  getSnapshot() {
    const movement = this.startOrigin && this.confirmedOrigin
      ? subtract(this.confirmedOrigin, this.startOrigin)
      : { x: 0, y: 0 };
    return {
      active: this.active,
      ending: this.ending,
      failed: this.failed,
      pointerGeneration: this.pointerGeneration,
      blockedPointerGeneration: this.blockedPointerGeneration,
      P: { ...this.latestP },
      MConfirmed: movement,
      R: subtract(this.latestP, movement),
      inFlight: !!this.inFlight,
    };
  }

  _pump() {
    if (!this.active || this.ending || this.failed || this.inFlight) return;
    if (this.blockedPointerGeneration === this.pointerGeneration) return;
    const movement = subtract(this.confirmedOrigin, this.startOrigin);
    const remainder = subtract(this.latestP, movement);
    if (vectorLength(remainder) <= this.epsilon) return;
    const delta = clampVector(remainder, this.maxStep);
    const pending = {
      generation: this.pointerGeneration,
      beforeOrigin: { ...this.confirmedOrigin },
      delta,
      handled: false,
      observed: false,
      timer: null,
    };
    this.inFlight = pending;
    this._diagnose("send", { delta });
    let promise;
    try {
      promise = Promise.resolve(this.sendMove({ ...delta }));
    } catch (err) {
      this._fail(err);
      return;
    }
    promise.then(
      () => this._onHandled(pending),
      (err) => this._fail(err),
    );
  }

  _onHandled(pending) {
    if (this.failed || this.inFlight !== pending) return;
    pending.handled = true;
    this._diagnose("handled");
    if (pending.observed) {
      this._finishPending(false);
      return;
    }
    const refresh = Number(this.getRefreshIntervalMs());
    const delay = Math.max(1, Number.isFinite(refresh) && refresh > 0 ? refresh * 2 : 34);
    pending.timer = this.setTimer(() => this._readSettledOrigin(pending), delay);
  }

  _readSettledOrigin(pending) {
    if (this.failed || this.inFlight !== pending) return;
    pending.timer = null;
    let promise;
    try {
      promise = Promise.resolve(this.readOrigin());
    } catch (err) {
      this._fail(err);
      return;
    }
    promise.then((origin) => {
      if (this.failed || this.inFlight !== pending) return;
      if (!finitePoint(origin)) {
        this._fail(new Error("niri snapshot omitted the tracked window origin"));
        return;
      }
      this.observeOrigin(origin, "snapshot");
      if (this.inFlight === pending) this._finishPending(true);
    }, (err) => this._fail(err));
  }

  _finishPending(noOp) {
    const pending = this.inFlight;
    if (!pending) return;
    if (pending.timer) this.clearTimer(pending.timer);
    this.inFlight = null;
    if (noOp && samePoint(this.confirmedOrigin, pending.beforeOrigin, this.epsilon)) {
      this.blockedPointerGeneration = pending.generation;
      this._diagnose("no-op");
    } else {
      this._diagnose("observed", { source: pending.observationSource || "snapshot" });
    }
    if (this.ending || !this.active) {
      this.ending = false;
      this._resolveSettled();
      return;
    }
    this._pump();
  }

  _fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.active = false;
    this.ending = false;
    if (this.inFlight && this.inFlight.timer) this.clearTimer(this.inFlight.timer);
    this.inFlight = null;
    try { this.onError(error instanceof Error ? error : new Error(String(error))); } catch {}
    this._resolveSettled();
  }

  _resolveSettled() {
    const snapshot = this.getSnapshot();
    while (this.settleWaiters.length) this.settleWaiters.shift()(snapshot);
  }

  _diagnose(type, extra = {}) {
    try { this.onDiagnostic({ type, ...this.getSnapshot(), ...extra }); } catch {}
  }
}

module.exports = {
  NiriDragController,
  clampVector,
  vectorLength,
};

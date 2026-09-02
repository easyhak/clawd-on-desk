"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");

const SHARED_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "pet-input-controller.js"),
  "utf8",
);
const BOOTSTRAP_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "render-input-bootstrap.js"),
  "utf8",
);

class FakeArea {
  constructor() {
    this.style = {};
    this.offsetWidth = 80;
    this.offsetHeight = 40;
    this.listeners = new Map();
    this.classList = { add() {}, remove() {} };
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  setPointerCapture() {}
}

function harness() {
  const area = new FakeArea();
  const documentListeners = new Map();
  const handlers = {};
  const calls = [];
  const api = {
    onBootstrap: (cb) => { handlers.bootstrap = cb; },
    onEnabled: (cb) => { handlers.enabled = cb; },
    onCancelReaction: (cb) => { handlers.cancel = cb; },
    onDropAccepted: (cb) => { handlers.dropAccepted = cb; },
    notifyReady: (payload) => calls.push(["ready", payload]),
    ackBootstrap: (payload) => calls.push(["bootstrapAck", payload]),
    ackEnabled: (payload) => calls.push(["enabledAck", payload]),
    dragLock: (locked, details) => calls.push(["dragLock", locked, details]),
    dragMove: (payload) => calls.push(["dragMove", payload]),
    dragEnd: () => calls.push(["dragEnd"]),
    showContextMenu: () => calls.push(["context"]),
    getPathForFile: () => "",
    dropPaths: () => {},
    exitMiniMode: () => calls.push(["exitMini"]),
    showDashboard: () => calls.push(["dashboard"]),
    revealSessionHud: () => calls.push(["reveal"]),
    startDragReaction: () => {},
    endDragReaction: () => {},
    playClickReaction: () => {},
  };
  const fakeDocument = {
    getElementById: (id) => id === "pet-input-layer" ? area : null,
    addEventListener: (name, callback) => documentListeners.set(name, callback),
  };
  const windowListeners = new Map();
  const fakeWindow = {
    petInputAPI: api,
    innerWidth: 200,
    innerHeight: 100,
    addEventListener: (name, callback) => windowListeners.set(name, callback),
  };
  const timers = [];
  const context = {
    document: fakeDocument,
    window: fakeWindow,
    globalThis: null,
    setTimeout: (cb, ms) => { const timer = { cb, ms }; timers.push(timer); return timer; },
    clearTimeout: () => {},
    requestAnimationFrame: (cb) => { cb(); return 1; },
    cancelAnimationFrame: () => {},
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SHARED_SOURCE, context);
  vm.runInContext(BOOTSTRAP_SOURCE, context);
  return { area, calls, handlers, documentListeners, windowListeners };
}

describe("render input bootstrap", () => {
  it("stays disabled until matching bootstrap and enable acknowledgements", () => {
    const h = harness();
    assert.equal(h.calls[0][0], "ready");
    assert.deepStrictEqual({ ...h.calls[0][1] }, { innerWidth: 200, innerHeight: 100 });
    h.documentListeners.get("pointerup")({ button: 0, clientX: 20 });
    assert.equal(h.calls.some((call) => call[0] === "reveal"), false);

    h.handlers.bootstrap({
      generation: 4,
      rect: { x: 20, y: 10, width: 80, height: 40 },
      logicalPerCss: { x: 2, y: 2 },
      themeConfig: { reactions: {} },
      state: { currentState: "idle", miniMode: false, dndEnabled: false },
    });
    assert.equal(h.area.style.left, "10px");
    assert.equal(h.area.style.top, "5px");
    assert.equal(h.area.style.width, "40px");
    assert.equal(h.area.style.height, "20px");
    assert.equal(h.calls.at(-1)[0], "bootstrapAck");
    assert.equal(h.calls.at(-1)[1].ok, true);

    h.handlers.enabled({ generation: 3, enabled: true });
    assert.equal(h.calls.at(-1)[1].ok, false);
    h.handlers.enabled({ generation: 4, enabled: true });
    assert.equal(h.calls.at(-1)[0], "enabledAck");
    assert.deepStrictEqual({ ...h.calls.at(-1)[1] }, {
      generation: 4,
      enabled: true,
      ok: true,
      innerWidth: 200,
      innerHeight: 100,
    });
    h.documentListeners.get("pointerup")({ button: 0, clientX: 20 });
    assert.equal(h.calls.some((call) => call[0] === "reveal"), true);
  });

  it("sends finite grab geometry and local pointer coordinates through the shared controller", () => {
    const h = harness();
    h.handlers.bootstrap({
      generation: 1,
      rect: { x: 0, y: 0, width: 200, height: 100 },
      logicalPerCss: { x: 1, y: 1 },
      state: { currentState: "idle" },
    });
    h.handlers.enabled({ generation: 1, enabled: true });
    h.area.listeners.get("pointerdown")({ button: 0, pointerId: 7, clientX: 30, clientY: 20 });
    h.documentListeners.get("pointermove")({ clientX: 45, clientY: 25 });
    const lock = h.calls.find((call) => call[0] === "dragLock");
    assert.equal(lock[1], true);
    assert.deepStrictEqual(
      { ...lock[2] },
      { grabX: 30, grabY: 20, innerWidth: 200, innerHeight: 100 },
    );
    const move = h.calls.find((call) => call[0] === "dragMove");
    assert.deepStrictEqual({ ...move[1] }, { clientX: 45, clientY: 25 });
  });

  it("rejects malformed rects without changing ownership", () => {
    const h = harness();
    h.handlers.bootstrap({
      generation: 2,
      rect: { x: 0, y: 0, width: NaN, height: 20 },
      logicalPerCss: { x: 1, y: 1 },
    });
    assert.equal(h.calls.at(-1)[0], "bootstrapAck");
    assert.equal(h.calls.at(-1)[1].ok, false);
    h.handlers.enabled({ generation: 2, enabled: true });
    assert.equal(h.calls.at(-1)[1].ok, false);
  });
});

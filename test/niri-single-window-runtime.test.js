"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  NiriSingleWindowRuntime,
  evaluateNiriSingleWindowGate,
  localHitRect,
} = require("../src/niri-single-window-runtime");

function windowFixture(overrides = {}) {
  return {
    id: 7,
    title: "Clawd niri nonce",
    app_id: "clawd-on-desk",
    workspace_id: 3,
    layout: {
      window_size: [200, 100],
      tile_pos_in_workspace_view: [100, 200],
      window_offset_in_tile: [0, 0],
    },
    ...overrides,
  };
}

function createHarness(options = {}) {
  const calls = [];
  let renderInnerSize = { width: 200, height: 100 };
  let pendingEnable = null;
  const command = {
    version: async () => options.version || "26.04 (test)",
    outputs: async () => ({
      DP_1: {
        name: "DP-1",
        logical: { x: 0, y: 0, width: 1920, height: 1080, scale: 1.25 },
        current_mode: 0,
        modes: [{ refresh_rate: 60000 }],
      },
    }),
    windows: async () => [windowFixture()],
    moveFloatingWindowAdjust: async (payload) => { calls.push(["move", payload]); },
    close: () => calls.push(["command-close"]),
  };
  let eventOptions;
  const stream = {
    start: async () => {
      if (options.eventErrorOnStart) {
        eventOptions.onError(new Error("event stream failed during startup"));
        return;
      }
      eventOptions.onEvent({ WorkspacesChanged: { workspaces: [{ id: 3, output: "DP-1" }] } });
      eventOptions.onEvent({ WindowsChanged: { windows: [windowFixture()] } });
    },
    close: () => calls.push(["stream-close"]),
  };
  const renderWindow = {
    getNativeWindowHandle: () => Buffer.from([7, 0, 0, 0]),
    setSize: (width, height) => calls.push(["set-size", width, height]),
  };
  const inputRegion = {
    suppress: () => { calls.push(["render-suppress"]); return { x: 0, y: 0, width: 1, height: 1 }; },
    recalibrate: (size) => calls.push(["recalibrate", size]),
    applyLogicalRect: (rect) => { calls.push(["render-region", rect]); return rect; },
    dispose: () => calls.push(["region-dispose"]),
  };
  let runtime;
  runtime = new NiriSingleWindowRuntime({
    socketPath: "/tmp/niri.sock",
    title: "Clawd niri nonce",
    timeoutMs: 100,
    commandFactory: () => command,
    eventFactory: (injected) => { eventOptions = injected; return stream; },
    createInputRegion: () => inputRegion,
    getRenderWindow: () => renderWindow,
    getHitWindow: () => ({}),
    getHitRectScreen: (rect) => ({
      left: rect.x + 20,
      top: rect.y + 10,
      right: rect.x + 100,
      bottom: rect.y + 50,
    }),
    getThemeConfig: () => ({ reactions: { double: { file: "x.svg" } } }),
    getInputState: () => ({ currentState: "idle", miniMode: false, dndEnabled: false }),
    sendToRender: (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === "pet-input-bootstrap") {
        queueMicrotask(() => runtime.handleBootstrapAck({
          generation: payload.generation,
          ok: true,
          innerWidth: renderInnerSize.width,
          innerHeight: renderInnerSize.height,
        }));
      } else if (channel === "pet-input-enabled" && payload.enabled) {
        const ack = () => runtime.handleEnabledAck({
          generation: payload.generation,
          ok: true,
          enabled: true,
          innerWidth: renderInnerSize.width,
          innerHeight: renderInnerSize.height,
        });
        if (options.deferEnableAck) pendingEnable = ack;
        else queueMicrotask(ack);
      }
    },
    setHitSuppressed: (value) => calls.push(["hit-suppressed", value]),
    hideHit: () => calls.push(["hit-hide"]),
    showHit: () => calls.push(["hit-show"]),
    onError: (error, phase) => calls.push(["error", phase, error.message]),
    onFatal: (error, phase) => calls.push(["fatal", phase, error.message]),
    onDragCancelled: () => calls.push(["drag-cancelled"]),
    canHandoffInput: () => options.canHandoffInput !== false,
  });
  runtime.handleRenderReady({ innerWidth: 200, innerHeight: 100 });
  return {
    runtime,
    calls,
    event: (event) => eventOptions.onEvent(event),
    eventError: (error) => eventOptions.onError(error),
    setRenderInnerSize: (width, height) => { renderInnerSize = { width, height }; },
    ackEnabled: () => {
      if (!pendingEnable) return false;
      const ack = pendingEnable;
      pendingEnable = null;
      return ack();
    },
  };
}

describe("niri single-window runtime", () => {
  it("gates exact Linux/niri/X11-Ozone conditions", () => {
    const enabled = evaluateNiriSingleWindowGate({
      platform: "linux",
      arch: "x64",
      argv: ["clawd", "--ozone-platform=x11"],
      env: {
        CLAWD_WINDOW_PLACEMENT: "niri-ipc-single",
        NIRI_SOCKET: "/run/niri.sock",
        DISPLAY: ":0",
        XDG_SESSION_TYPE: "wayland",
      },
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.socketPath, "/run/niri.sock");
    assert.equal(evaluateNiriSingleWindowGate({
      platform: "linux", arch: "x64", argv: ["clawd", "--ozone-platform=wayland"],
      env: { CLAWD_WINDOW_PLACEMENT: "niri-ipc-single", NIRI_SOCKET: "x", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1" },
    }).reason, "not-x11-ozone");
    assert.equal(evaluateNiriSingleWindowGate({ env: {} }).reason, "not-requested");
  });

  it("derives a local logical input rect from compositor geometry", () => {
    assert.deepStrictEqual(
      localHitRect(
        { left: -90, top: 25, right: -10, bottom: 75 },
        { x: -100, y: 20, width: 200, height: 100 },
      ),
      { x: 10, y: 5, width: 80, height: 50 },
    );
  });

  it("activates only after render acks, hit suppression, and Shape readback", async () => {
    const h = createHarness();
    assert.equal(await h.runtime.start(), true);
    assert.equal(h.runtime.isActive(), true);
    assert.deepStrictEqual(h.runtime.getBounds(), {
      x: 100, y: 200, width: 200, height: 100,
      output: "DP-1", workspaceId: 3, scale: 1.25,
    });
    const order = h.calls.map((call) => call[0]);
    assert.ok(order.indexOf("pet-input-bootstrap") < order.indexOf("hit-suppressed"));
    assert.ok(order.indexOf("hit-suppressed") < order.indexOf("render-region"));
    assert.ok(order.indexOf("render-region") < order.indexOf("hit-hide"));
    assert.equal(h.runtime.acceptsRenderInput(), true);
  });

  it("routes finite ClickGrab samples and updates confirmed origin from layout events", async () => {
    const h = createHarness();
    await h.runtime.start();
    assert.equal(h.runtime.beginDrag({ grabX: 10, grabY: 10, innerWidth: 200, innerHeight: 100 }), true);
    assert.equal(h.runtime.moveDrag({ clientX: 30, clientY: 10 }), true);
    await new Promise((resolve) => setImmediate(resolve));
    const move = h.calls.find((call) => call[0] === "move");
    assert.ok(move);
    assert.equal(move[1].id, 7);
    assert.equal(move[1].x, 9);
    h.event({
      WindowLayoutsChanged: {
        changes: [[7, windowFixture().layout = {
          ...windowFixture().layout,
          tile_pos_in_workspace_view: [109, 200],
        }]],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.runtime.drag.getSnapshot().MConfirmed.x, 9);
    await h.runtime.endDrag();
  });

  it("recovers render input in place after reload without remapping hit", async () => {
    const h = createHarness();
    await h.runtime.start();
    h.calls.length = 0;
    h.runtime.handleRenderLoading();
    h.runtime.handleRenderReady({ innerWidth: 200, innerHeight: 100 });
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.runtime.acceptsRenderInput(), true);
    assert.equal(h.calls.some((call) => call[0] === "hit-show"), false);
    assert.equal(h.calls.some((call) => call[0] === "render-region"), true);
  });

  it("cancels a captured drag before recovering from a render reload", async () => {
    const h = createHarness();
    await h.runtime.start();
    assert.equal(h.runtime.beginDrag({ grabX: 10, grabY: 10, innerWidth: 200, innerHeight: 100 }), true);
    h.calls.length = 0;
    h.runtime.handleRenderLoading();
    h.runtime.handleRenderReady({ innerWidth: 200, innerHeight: 100 });
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.some((call) => call[0] === "drag-cancelled"), true);
    assert.equal(h.runtime.drag.getSnapshot().active, false);
    assert.equal(h.runtime.acceptsRenderInput(), true);
    assert.equal(h.calls.some((call) => call[0] === "hit-show"), false);
  });

  it("recalibrates Shape when compositor logical size changes", async () => {
    const h = createHarness();
    await h.runtime.start();
    const before = h.calls.filter((call) => call[0] === "recalibrate").length;
    h.event({
      WindowLayoutsChanged: {
        changes: [[7, {
          ...windowFixture().layout,
          window_size: [220, 100],
        }]],
      },
    });
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.filter((call) => call[0] === "recalibrate").length, before + 1);
  });

  it("repeats bootstrap with the acknowledged live viewport after a resize", async () => {
    const h = createHarness();
    await h.runtime.start();
    h.calls.length = 0;
    h.setRenderInnerSize(300, 150);
    h.event({
      WindowLayoutsChanged: {
        changes: [[7, {
          ...windowFixture().layout,
          window_size: [300, 150],
        }]],
      },
    });
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    const bootstraps = h.calls.filter((call) => call[0] === "pet-input-bootstrap");
    assert.equal(bootstraps.length, 2);
    assert.deepStrictEqual(bootstraps[0][1].logicalPerCss, { x: 1.5, y: 1.5 });
    assert.deepStrictEqual(bootstraps[1][1].logicalPerCss, { x: 1, y: 1 });
    assert.equal(h.runtime.acceptsRenderInput(), true);
  });

  it("fails closed permanently after an active event-stream failure", async () => {
    const h = createHarness();
    await h.runtime.start();
    h.calls.length = 0;
    h.eventError(new Error("event stream disconnected"));
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.runtime.isActive(), true, "layout ownership must not fall back to legacy positioning");
    assert.equal(h.runtime.acceptsRenderInput(), false);
    assert.deepStrictEqual(h.runtime.syncInputGeometry("after-failure"), { applied: false, deferred: false });
    assert.equal(h.calls.some((call) => call[0] === "render-suppress"), true);
    assert.equal(h.calls.some((call) => call[0] === "stream-close"), true);
    assert.equal(h.calls.some((call) => call[0] === "command-close"), true);
    assert.equal(h.calls.some((call) => call[0] === "hit-show"), false);
    assert.deepStrictEqual(
      h.calls.filter((call) => call[0] === "fatal"),
      [["fatal", "event-stream", "event stream disconnected"]],
    );

    const regions = h.calls.filter((call) => call[0] === "render-region").length;
    h.runtime.handleRenderReady({ innerWidth: 200, innerHeight: 100 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.filter((call) => call[0] === "render-region").length, regions);
  });

  it("aborts startup if the event stream fails before discovery", async () => {
    const h = createHarness({ eventErrorOnStart: true });
    assert.equal(await h.runtime.start(), false);
    assert.equal(h.runtime.isActive(), false);
    assert.equal(h.calls.some((call) => call[0] === "hit-hide"), false);
    assert.equal(h.calls.filter((call) => call[0] === "stream-close").length, 1);
    assert.equal(h.calls.filter((call) => call[0] === "command-close").length, 1);
    assert.equal(h.calls.some((call) => call[0] === "fatal"), false);
  });

  it("forwards hit theme config on an input-only channel", async () => {
    const h = createHarness();
    await h.runtime.start();
    h.calls.length = 0;

    assert.equal(h.runtime.forwardControllerMessage("theme-config", { reactions: {} }), true);
    assert.deepStrictEqual(h.calls, [["pet-input-theme-config", { reactions: {} }]]);
    assert.equal(h.calls.some((call) => call[0] === "theme-config"), false);
  });

  it("falls back before suppressing hit if legacy input is drag-locked", async () => {
    const h = createHarness({ canHandoffInput: false });
    assert.equal(await h.runtime.start(), false);
    assert.equal(h.calls.some((call) => call[0] === "hit-suppressed" && call[1] === true), false);
    assert.equal(h.calls.some((call) => call[0] === "hit-hide"), false);
    assert.equal(h.runtime.protectsMappedRender(), false);
  });

  it("rolls back startup if compositor geometry changes after bootstrap but before commit", async () => {
    const h = createHarness({ deferEnableAck: true });
    const starting = h.runtime.start();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.some((call) => call[0] === "pet-input-enabled"), true);
    h.event({
      WindowLayoutsChanged: {
        changes: [[7, {
          ...windowFixture().layout,
          window_size: [300, 150],
        }]],
      },
    });
    h.ackEnabled();
    assert.equal(await starting, false);
    assert.equal(h.calls.some((call) => call[0] === "render-region"), false);
    assert.equal(h.calls.some((call) => call[0] === "hit-show"), true);
    assert.equal(h.runtime.isActive(), false);
  });

  it("rolls back startup if the renderer viewport changes before enable commit", async () => {
    const h = createHarness({ deferEnableAck: true });
    const starting = h.runtime.start();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    h.setRenderInnerSize(300, 150);
    h.ackEnabled();
    assert.equal(await starting, false);
    assert.equal(h.calls.some((call) => call[0] === "hit-suppressed" && call[1] === true), false);
    assert.equal(h.calls.some((call) => call[0] === "render-region"), false);
    assert.equal(h.runtime.isActive(), false);
  });

  it("falls back without hiding hit when niri version is outside the audited baseline", async () => {
    const h = createHarness({ version: "26.05 (future)" });
    assert.equal(await h.runtime.start(), false);
    assert.equal(h.runtime.isActive(), false);
    assert.equal(h.calls.some((call) => call[0] === "hit-hide"), false);
    assert.equal(h.calls.some((call) => call[0] === "error" && call[1] === "startup"), true);
  });
});

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { NiriDragController, vectorLength } = require("../src/niri-drag-controller");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(options = {}) {
  const moves = [];
  const timers = [];
  let snapshotOrigin = options.origin || { x: 100, y: 200 };
  const controller = new NiriDragController({
    sendMove: (delta) => {
      const result = deferred();
      moves.push({ delta, ...result });
      return result.promise;
    },
    readOrigin: async () => ({ ...snapshotOrigin }),
    getRefreshIntervalMs: () => 10,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    onError: options.onError,
  });
  return {
    controller,
    moves,
    timers,
    setSnapshotOrigin: (origin) => { snapshotOrigin = origin; },
    begin: (overrides = {}) => controller.begin({
      grabX: 10,
      grabY: 10,
      innerWidth: 200,
      innerHeight: 100,
      windowRect: { x: 100, y: 200, width: 200, height: 100 },
      ...overrides,
    }),
  };
}

describe("niri drag controller", () => {
  it("uses cumulative ClickGrab displacement minus compositor-confirmed movement", async () => {
    const h = harness();
    assert.equal(h.begin(), true);
    h.controller.pointerMove({ clientX: 40, clientY: 10 });
    assert.equal(h.moves.length, 1);
    assert.ok(vectorLength(h.moves[0].delta) < 10);
    assert.deepStrictEqual(h.moves[0].delta, { x: 9, y: 0 });

    // Layout can arrive before Handled. The unchanged local pointer coordinate
    // is the real Smithay ClickGrab behavior and must not add another sample.
    h.controller.observeOrigin({ x: 109, y: 200 });
    h.controller.pointerMove({ clientX: 40, clientY: 10 });
    h.moves[0].resolve(true);
    await flush();
    assert.equal(h.moves.length, 2);
    assert.deepStrictEqual(h.moves[1].delta, { x: 9, y: 0 });
    assert.deepStrictEqual(h.controller.getSnapshot().MConfirmed, { x: 9, y: 0 });
  });

  it("handles Handled before event without treating Handled as movement", async () => {
    const h = harness();
    h.begin();
    h.controller.pointerMove({ clientX: 15, clientY: 10 });
    h.moves[0].resolve(true);
    await flush();
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delay, 20);
    assert.deepStrictEqual(h.controller.getSnapshot().MConfirmed, { x: 0, y: 0 });
    h.controller.observeOrigin({ x: 105, y: 200 });
    assert.equal(h.controller.getSnapshot().inFlight, false);
    assert.deepStrictEqual(h.controller.getSnapshot().R, { x: 0, y: 0 });
  });

  it("uses delayed snapshot to distinguish a missed event from a true no-op", async () => {
    const h = harness();
    h.begin();
    h.controller.pointerMove({ clientX: 19, clientY: 10 });
    h.moves[0].resolve(true);
    await flush();
    h.setSnapshotOrigin({ x: 109, y: 200 });
    h.timers[0].fn();
    await flush();
    assert.deepStrictEqual(h.controller.getSnapshot().MConfirmed, { x: 9, y: 0 });
    assert.equal(h.controller.getSnapshot().blockedPointerGeneration, null);

    const edge = harness();
    edge.begin();
    edge.controller.pointerMove({ clientX: 19, clientY: 10 });
    edge.moves[0].resolve(true);
    await flush();
    edge.timers[0].fn();
    await flush();
    const blocked = edge.controller.getSnapshot().pointerGeneration;
    assert.equal(edge.controller.getSnapshot().blockedPointerGeneration, blocked);
    edge.controller.pointerMove({ clientX: 19, clientY: 10 });
    assert.equal(edge.moves.length, 1);
    edge.controller.pointerMove({ clientX: 5, clientY: 10 });
    assert.equal(edge.moves.length, 2);
    assert.ok(edge.moves[1].delta.x < 0);
  });

  it("covers in-flight samples with the latest P and recognizes partial clamping", async () => {
    const h = harness();
    h.begin();
    h.controller.pointerMove({ clientX: 40, clientY: 10 });
    h.controller.pointerMove({ clientX: 60, clientY: 10 });
    assert.equal(h.moves.length, 1);
    h.controller.observeOrigin({ x: 104, y: 200 });
    h.moves[0].resolve(true);
    await flush();
    assert.equal(h.moves.length, 2);
    assert.deepStrictEqual(h.controller.getSnapshot().MConfirmed, { x: 4, y: 0 });
    assert.deepStrictEqual(h.moves[1].delta, { x: 9, y: 0 });
  });

  it("clamps diagonal vector length and does not continue after pointerup", async () => {
    const h = harness();
    h.begin();
    h.controller.pointerMove({ clientX: 30, clientY: 30 });
    assert.ok(Math.abs(vectorLength(h.moves[0].delta) - 9) < 1e-9);
    const ending = h.controller.end();
    h.controller.observeOrigin({ x: 106, y: 206 });
    h.moves[0].resolve(true);
    await ending;
    assert.equal(h.moves.length, 1);
    assert.equal(h.controller.getSnapshot().active, false);
  });

  it("rejects invalid begin/pointer payloads and fails closed on IPC errors", async () => {
    const errors = [];
    const h = harness({ onError: (err) => errors.push(err) });
    assert.equal(h.begin({ grabX: NaN }), false);
    assert.equal(h.begin({ innerWidth: 100 }), false);
    assert.equal(h.begin(), true);
    assert.equal(h.controller.pointerMove({ clientX: NaN, clientY: 0 }), false);
    h.controller.pointerMove({ clientX: 20, clientY: 10 });
    h.moves[0].reject(new Error("socket gone"));
    await flush();
    assert.equal(errors.length, 1);
    assert.equal(h.controller.getSnapshot().failed, true);
  });

  it("refuses a new drag until the previous in-flight action settles", async () => {
    const h = harness();
    h.begin();
    h.controller.pointerMove({ clientX: 20, clientY: 10 });
    const ending = h.controller.end();
    assert.equal(h.begin(), false);
    h.controller.observeOrigin({ x: 109, y: 200 });
    h.moves[0].resolve(true);
    await ending;
    assert.equal(h.begin(), true);
  });

  it("cancels an in-flight drag and resolves an outstanding end waiter", async () => {
    const h = harness();
    h.begin();
    h.controller.pointerMove({ clientX: 20, clientY: 10 });
    const ending = h.controller.end();
    assert.equal(h.controller.getSnapshot().inFlight, true);
    const cancelled = h.controller.cancel();
    assert.deepStrictEqual(await ending, cancelled);
    assert.equal(cancelled.active, false);
    assert.equal(cancelled.ending, false);
    assert.equal(cancelled.inFlight, false);
    h.moves[0].resolve(true);
    await flush();
    assert.equal(h.moves.length, 1);
  });
});

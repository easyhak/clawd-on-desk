"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  computePixelRatio,
  createLinuxX11InputRegion,
  normalizeInputRect,
  parseXid,
} = require("../src/linux-x11-input-region");

function xidBuffer(value, width = 8) {
  const buffer = Buffer.alloc(width);
  if (width === 8) buffer.writeBigUInt64LE(BigInt(value));
  else buffer.writeUInt32LE(Number(value));
  return buffer;
}

function fakeKoffi(options = {}) {
  const state = {
    rects: [{ x: 0, y: 0, width: 1, height: 1 }],
    writes: [],
    closeCount: 0,
    freeCount: 0,
    unregisterCount: 0,
    protocolHandler: options.previousProtocolHandler || null,
    ioHandler: options.previousIoHandler || null,
    ioExitHandler: null,
  };
  const pointerIds = new WeakMap();
  let nextPointerId = 1n;
  let setIoHandlerCalls = 0;
  let setProtocolHandlerCalls = 0;
  const functions = {
    XOpenDisplay: () => options.openDisplay === false ? null : { display: true },
    XCloseDisplay: () => { state.closeCount += 1; return 0; },
    XFree: () => { state.freeCount += 1; return 0; },
    XSync: () => 0,
    XSetErrorHandler: (handler) => {
      setProtocolHandlerCalls += 1;
      if (options.failRestoreProtocolHandler && setProtocolHandlerCalls > 1) {
        throw new Error("could not restore protocol handler");
      }
      const previous = state.protocolHandler;
      state.protocolHandler = handler;
      return previous;
    },
    XSetIOErrorHandler: (handler) => {
      setIoHandlerCalls += 1;
      if (options.failSetIoHandler) throw new Error("could not install I/O handler");
      if (options.failRestoreIoHandler && setIoHandlerCalls > 1) {
        throw new Error("could not restore I/O handler");
      }
      const previous = state.ioHandler;
      state.ioHandler = handler;
      return previous;
    },
    XSetIOErrorExitHandler: (_display, handler) => { state.ioExitHandler = handler; },
    XShapeQueryExtension: (_display, eventBase, errorBase) => {
      eventBase[0] = 64;
      errorBase[0] = 128;
      return options.shape === false ? 0 : 1;
    },
    XGetGeometry: (_display, _xid, root, x, y, width, height, border, depth) => {
      if (options.geometry === false) return 0;
      const geometry = options.geometry || { x: 0, y: 0, width: 300, height: 150, border: 0, depth: 32 };
      root[0] = 1;
      x[0] = geometry.x;
      y[0] = geometry.y;
      width[0] = geometry.width;
      height[0] = geometry.height;
      border[0] = geometry.border;
      depth[0] = geometry.depth;
      return 1;
    },
    XShapeCombineRectangles: (_display, _xid, _kind, _x, _y, rect, count) => {
      if (options.protocolOnSet && state.protocolHandler) state.protocolHandler(_display, {});
      if (options.ioOnSet && state.ioHandler) {
        state.ioHandler(_display);
        if (state.ioExitHandler) state.ioExitHandler(_display, null);
      }
      state.writes.push(rect ? { ...rect } : null);
      state.rects = count ? [{ ...rect }] : [];
    },
    XShapeGetRectangles: (_display, _xid, _kind, count, ordering) => {
      const rects = options.readbackMismatch
        ? [{ x: 9, y: 9, width: 9, height: 9 }]
        : state.rects;
      count[0] = rects.length;
      ordering[0] = 0;
      return rects.length ? { rects } : null;
    },
  };
  const makeLibrary = (name) => ({
    func: (prototype) => {
      const match = prototype.match(/\b(X[A-Za-z0-9]+)\s*\(/);
      if (!match || !functions[match[1]]) throw new Error(`unknown declaration: ${prototype}`);
      return functions[match[1]];
    },
    name,
  });
  return {
    state,
    load(name) {
      if (name === "libX11.so.6" && options.missingX11) throw new Error("not found");
      if (name === "libXext.so.6" && options.missingXext) throw new Error("not found");
      return makeLibrary(name);
    },
    struct: (name, fields) => {
      if (options.rejectDuplicateType && state.structCreated) throw new Error(`Duplicate type name '${name}'`);
      state.structCreated = true;
      return { fields };
    },
    proto: (...definition) => ({ definition }),
    pointer: (type) => ({ type }),
    register: (callback) => callback,
    unregister: () => { state.unregisterCount += 1; },
    address: (pointer) => {
      if (!pointer || (typeof pointer !== "object" && typeof pointer !== "function")) {
        throw new Error("not a pointer");
      }
      if (!pointerIds.has(pointer)) pointerIds.set(pointer, nextPointerId++);
      return pointerIds.get(pointer);
    },
    call: (pointer, _type, ...args) => pointer(...args),
    decode: (pointer, _type, count) => pointer.rects.slice(0, count),
  };
}

function fakeWindow(handle = xidBuffer(42)) {
  return { getNativeWindowHandle: () => handle };
}

describe("Linux X11 Input Shape adapter", () => {
  it("parses 32-bit and 64-bit X11 Window handles without rounding", () => {
    assert.equal(parseXid(xidBuffer(42, 4), "LE"), 42);
    assert.equal(parseXid(xidBuffer(0xFFFF_FFFEn, 8), "LE"), 0xFFFF_FFFE);
    assert.throws(() => parseXid(Buffer.alloc(2), "LE"), (err) => err.code === "invalid-xid");
    assert.throws(() => parseXid(xidBuffer(42), "BE"), (err) => err.code === "unsupported-endian");
  });

  it("calibrates DPR 1.25 and rejects inconsistent axes", () => {
    assert.deepStrictEqual(
      computePixelRatio({ width: 300, height: 150 }, { width: 240, height: 120 }),
      { x: 1.25, y: 1.25 },
    );
    assert.throws(
      () => computePixelRatio({ width: 300, height: 160 }, { width: 240, height: 120 }),
      (err) => err.code === "ratio-mismatch",
    );
  });

  it("rounds outward, clips negative/overflow edges, and rejects an empty intersection", () => {
    assert.deepStrictEqual(
      normalizeInputRect(
        { x: -2.2, y: 10.1, width: 252, height: 200 },
        { x: 1.25, y: 1.25 },
        { width: 300, height: 150 },
      ),
      { x: 0, y: 12, width: 300, height: 138 },
    );
    assert.throws(
      () => normalizeInputRect(
        { x: 400, y: 400, width: 10, height: 10 },
        { x: 1, y: 1 },
        { width: 300, height: 150 },
      ),
      (err) => err.code === "empty-rect",
    );
  });

  it("probes both libraries and the Shape extension independently", () => {
    assert.throws(
      () => createLinuxX11InputRegion({
        platform: "linux", arch: "x64", koffi: fakeKoffi({ missingX11: true }),
        window: fakeWindow(), logicalSize: { width: 240, height: 120 },
      }),
      (err) => err.code === "missing-x11",
    );
    assert.throws(
      () => createLinuxX11InputRegion({
        platform: "linux", arch: "x64", koffi: fakeKoffi({ missingXext: true }),
        window: fakeWindow(), logicalSize: { width: 240, height: 120 },
      }),
      (err) => err.code === "missing-xext",
    );
    const koffi = fakeKoffi({ shape: false });
    assert.throws(
      () => createLinuxX11InputRegion({
        platform: "linux", arch: "x64", koffi,
        window: fakeWindow(), logicalSize: { width: 240, height: 120 },
      }),
      (err) => err.code === "missing-shape",
    );
    assert.equal(koffi.state.closeCount, 1);
    assert.equal(koffi.state.unregisterCount, 3);
  });

  it("writes and reads back the exact Input Shape, then suppresses before dispose", () => {
    const koffi = fakeKoffi();
    const adapter = createLinuxX11InputRegion({
      platform: "linux",
      arch: "x64",
      koffi,
      window: fakeWindow(),
      logicalSize: { width: 240, height: 120 },
    });
    assert.deepStrictEqual(
      adapter.applyLogicalRect({ x: 8, y: 4, width: 80, height: 40 }),
      { x: 10, y: 5, width: 100, height: 50 },
    );
    adapter.dispose();
    assert.deepStrictEqual(koffi.state.writes, [
      { x: 10, y: 5, width: 100, height: 50 },
      { x: 0, y: 0, width: 1, height: 1 },
    ]);
    assert.equal(koffi.state.freeCount, 2);
    assert.equal(koffi.state.closeCount, 1);
  });

  it("fails before ownership switching when Shape readback disagrees", () => {
    const adapter = createLinuxX11InputRegion({
      platform: "linux",
      arch: "x64",
      koffi: fakeKoffi({ readbackMismatch: true }),
      window: fakeWindow(),
      logicalSize: { width: 240, height: 120 },
    });
    assert.throws(
      () => adapter.applyLogicalRect({ x: 0, y: 0, width: 10, height: 10 }),
      (err) => err.code === "readback-mismatch",
    );
    assert.throws(() => adapter.dispose(), (err) => err.code === "readback-mismatch");
  });

  it("turns Xlib protocol and I/O callbacks into recoverable JS errors", () => {
    for (const [option, code] of [["protocolOnSet", "x-protocol-error"], ["ioOnSet", "x-io-error"]]) {
      const koffi = fakeKoffi({ [option]: true });
      const adapter = createLinuxX11InputRegion({
        platform: "linux", arch: "x64", koffi,
        window: fakeWindow(), logicalSize: { width: 240, height: 120 },
      });
      assert.throws(
        () => adapter.applyLogicalRect({ x: 0, y: 0, width: 10, height: 10 }),
        (err) => err.code === code,
      );
      assert.throws(() => adapter.dispose(), (err) => err.code === code);
    }
  });

  it("suppresses a replacement XID before geometry calibration and reuses the Koffi type", () => {
    const koffi = fakeKoffi({ rejectDuplicateType: true });
    let handle = xidBuffer(42);
    const win = { getNativeWindowHandle: () => handle };
    const first = createLinuxX11InputRegion({
      platform: "linux", arch: "x64", koffi, window: win,
      logicalSize: { width: 240, height: 120 },
    });
    handle = xidBuffer(84);
    first.recalibrate({ width: 240, height: 120 });
    assert.deepStrictEqual(koffi.state.writes[0], { x: 0, y: 0, width: 1, height: 1 });
    first.dispose();

    const second = createLinuxX11InputRegion({
      platform: "linux", arch: "x64", koffi, window: win,
      logicalSize: { width: 240, height: 120 },
    });
    second.dispose();
  });

  it("keeps one process-global handler bridge alive across overlapping adapters", () => {
    const previousProtocol = () => 17;
    const previousIo = () => 23;
    const koffi = fakeKoffi({
      previousProtocolHandler: previousProtocol,
      previousIoHandler: previousIo,
    });
    const first = createLinuxX11InputRegion({
      platform: "linux", arch: "x64", koffi, window: fakeWindow(xidBuffer(42)),
      logicalSize: { width: 240, height: 120 },
    });
    const installedProtocol = koffi.state.protocolHandler;
    const second = createLinuxX11InputRegion({
      platform: "linux", arch: "x64", koffi, window: fakeWindow(xidBuffer(84)),
      logicalSize: { width: 240, height: 120 },
    });
    assert.equal(koffi.state.protocolHandler, installedProtocol);

    first.dispose();
    assert.equal(koffi.state.protocolHandler, installedProtocol);
    assert.equal(koffi.state.unregisterCount, 0);
    second.applyLogicalRect({ x: 0, y: 0, width: 20, height: 20 });
    second.dispose();

    assert.equal(koffi.state.protocolHandler, previousProtocol);
    assert.equal(koffi.state.ioHandler, previousIo);
    assert.equal(koffi.state.unregisterCount, 3);
  });

  it("forwards protocol and I/O errors from foreign Displays to the prior handlers", () => {
    const forwarded = [];
    const previousProtocol = (display, event) => { forwarded.push(["protocol", display, event]); return 31; };
    const previousIo = (display) => { forwarded.push(["io", display]); return 37; };
    const koffi = fakeKoffi({
      previousProtocolHandler: previousProtocol,
      previousIoHandler: previousIo,
    });
    const adapter = createLinuxX11InputRegion({
      platform: "linux", arch: "x64", koffi, window: fakeWindow(),
      logicalSize: { width: 240, height: 120 },
    });
    const foreignDisplay = { foreign: true };
    const event = { code: 3 };
    assert.equal(koffi.state.protocolHandler(foreignDisplay, event), 31);
    assert.equal(koffi.state.ioHandler(foreignDisplay), 37);
    assert.deepStrictEqual(forwarded, [
      ["protocol", foreignDisplay, event],
      ["io", foreignDisplay],
    ]);
    adapter.applyLogicalRect({ x: 0, y: 0, width: 20, height: 20 });
    adapter.dispose();
  });

  it("restores an installed protocol handler if I/O handler installation fails", () => {
    const previousProtocol = () => 17;
    const previousIo = () => 23;
    const koffi = fakeKoffi({
      previousProtocolHandler: previousProtocol,
      previousIoHandler: previousIo,
      failSetIoHandler: true,
    });
    assert.throws(
      () => createLinuxX11InputRegion({
        platform: "linux", arch: "x64", koffi, window: fakeWindow(),
        logicalSize: { width: 240, height: 120 },
      }),
      (err) => err.code === "ffi-error-boundary",
    );
    assert.equal(koffi.state.protocolHandler, previousProtocol);
    assert.equal(koffi.state.ioHandler, previousIo);
    assert.equal(koffi.state.unregisterCount, 3);
  });

  it("keeps callbacks registered and permits retry when global handler restoration fails", () => {
    const previousProtocol = () => 17;
    const previousIo = () => 23;
    const options = {
      previousProtocolHandler: previousProtocol,
      previousIoHandler: previousIo,
      failRestoreIoHandler: true,
    };
    const koffi = fakeKoffi(options);
    const adapter = createLinuxX11InputRegion({
      platform: "linux", arch: "x64", koffi, window: fakeWindow(),
      logicalSize: { width: 240, height: 120 },
    });
    const installedIo = koffi.state.ioHandler;
    assert.throws(() => adapter.dispose(), (err) => err.code === "ffi-error-boundary-restore");
    assert.equal(koffi.state.ioHandler, installedIo);
    assert.equal(koffi.state.unregisterCount, 0);

    options.failRestoreIoHandler = false;
    adapter.dispose();
    assert.equal(koffi.state.ioHandler, previousIo);
    assert.equal(koffi.state.protocolHandler, previousProtocol);
    assert.equal(koffi.state.unregisterCount, 3);
  });

  it("retains callbacks and permanently disables the experiment when setup rollback fails", () => {
    const previousProtocol = () => 17;
    const koffi = fakeKoffi({
      previousProtocolHandler: previousProtocol,
      failSetIoHandler: true,
      failRestoreProtocolHandler: true,
    });
    assert.throws(
      () => createLinuxX11InputRegion({
        platform: "linux", arch: "x64", koffi, window: fakeWindow(),
        logicalSize: { width: 240, height: 120 },
      }),
      (err) => err.code === "ffi-error-boundary-restore",
    );
    const installedProtocol = koffi.state.protocolHandler;
    assert.notEqual(installedProtocol, previousProtocol);
    assert.equal(koffi.state.unregisterCount, 0);
    assert.throws(
      () => createLinuxX11InputRegion({
        platform: "linux", arch: "x64", koffi, window: fakeWindow(),
        logicalSize: { width: 240, height: 120 },
      }),
      (err) => err.code === "ffi-error-boundary-broken",
    );
    assert.equal(koffi.state.protocolHandler, installedProtocol);
    assert.equal(koffi.state.unregisterCount, 0);
  });
});

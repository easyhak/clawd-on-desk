"use strict";

const os = require("node:os");

const SHAPE_INPUT = 2;
const SHAPE_SET = 0;
const UNSORTED = 0;
const MAX_XRECT_COORD = 32767;
const MAX_XRECT_SIZE = 65535;

class X11InputRegionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "X11InputRegionError";
    this.code = code;
  }
}

function parseXid(handle, endianness = os.endianness()) {
  if (!Buffer.isBuffer(handle)) {
    throw new X11InputRegionError("invalid-xid", "native window handle is not a Buffer");
  }
  if (endianness !== "LE") {
    throw new X11InputRegionError("unsupported-endian", "X11 input shape experiment requires little endian");
  }
  let value;
  if (handle.length === 4) value = BigInt(handle.readUInt32LE(0));
  else if (handle.length === 8) value = handle.readBigUInt64LE(0);
  else throw new X11InputRegionError("invalid-xid", `unexpected X11 Window handle width: ${handle.length}`);
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new X11InputRegionError("invalid-xid", "X11 Window id is zero or not exactly representable");
  }
  return Number(value);
}

function computePixelRatio(geometry, logicalSize, tolerance = 0.01) {
  if (!geometry || !logicalSize) {
    throw new X11InputRegionError("invalid-geometry", "X11 and compositor geometry are required");
  }
  const values = [geometry.width, geometry.height, logicalSize.width, logicalSize.height];
  if (!values.every(Number.isFinite) || values.some((value) => value <= 0)) {
    throw new X11InputRegionError("invalid-geometry", "X11 and compositor sizes must be positive and finite");
  }
  const x = geometry.width / logicalSize.width;
  const y = geometry.height / logicalSize.height;
  const relativeDifference = Math.abs(x - y) / Math.max(x, y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0 || relativeDifference > tolerance) {
    throw new X11InputRegionError("ratio-mismatch", `X11 pixel ratios disagree: ${x} vs ${y}`);
  }
  return { x, y };
}

function normalizeInputRect(rect, ratio, geometry) {
  if (!rect || !ratio || !geometry) {
    throw new X11InputRegionError("invalid-rect", "input rect, ratio, and geometry are required");
  }
  const values = [rect.x, rect.y, rect.width, rect.height, ratio.x, ratio.y];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || ratio.x <= 0 || ratio.y <= 0) {
    throw new X11InputRegionError("invalid-rect", "input rect and ratio must be positive and finite");
  }
  const x1 = Math.max(0, Math.floor(rect.x * ratio.x));
  const y1 = Math.max(0, Math.floor(rect.y * ratio.y));
  const x2 = Math.min(geometry.width, Math.ceil((rect.x + rect.width) * ratio.x));
  const y2 = Math.min(geometry.height, Math.ceil((rect.y + rect.height) * ratio.y));
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) {
    throw new X11InputRegionError("empty-rect", "input rect does not intersect the X11 window");
  }
  if (x1 > MAX_XRECT_COORD || y1 > MAX_XRECT_COORD || width > MAX_XRECT_SIZE || height > MAX_XRECT_SIZE) {
    throw new X11InputRegionError("rect-overflow", "input rect cannot be represented by XRectangle");
  }
  return { x: x1, y: y1, width, height };
}

function rectsEqual(actual, expected) {
  return Array.isArray(actual)
    && actual.length === 1
    && ["x", "y", "width", "height"].every((key) => actual[0][key] === expected[key]);
}

const XRECTANGLE_TYPES = new WeakMap();
const XLIB_ERROR_BOUNDARIES = new WeakMap();

function acquireXlibErrorBoundary(options) {
  const { koffi, XSetErrorHandler, XSetIOErrorHandler, XSetIOErrorExitHandler } = options;
  const existing = XLIB_ERROR_BOUNDARIES.get(koffi);
  if (existing) {
    if (existing.broken) {
      throw new X11InputRegionError(
        "ffi-error-boundary-broken",
        "Xlib error boundary is unavailable for the rest of this process",
      );
    }
    existing.refCount += 1;
    return existing;
  }

  const displays = new Map();
  const protocolType = koffi.proto("int", ["void *", "void *"]);
  const ioType = koffi.proto("int", ["void *"]);
  const ioExitType = koffi.proto("void", ["void *", "void *"]);
  let protocolCallback = null;
  let ioCallback = null;
  let ioExitCallback = null;
  let previousProtocolHandler = null;
  let previousIoHandler = null;
  let protocolInstalled = false;
  let ioInstalled = false;

  const displayKey = (display) => {
    try {
      return koffi.address(display).toString();
    } catch (err) {
      throw new X11InputRegionError(
        "ffi-display-address",
        `could not identify the X11 Display: ${err && err.message ? err.message : err}`,
      );
    }
  };
  const forward = (handler, type, args) => {
    if (!handler) return 0;
    return koffi.call(handler, type, ...args);
  };

  try {
    protocolCallback = koffi.register((display, event) => {
      const state = displays.get(displayKey(display));
      if (state) {
        state.protocolError = true;
        return 0;
      }
      return forward(previousProtocolHandler, protocolType, [display, event]);
    }, koffi.pointer(protocolType));
    ioCallback = koffi.register((display) => {
      const state = displays.get(displayKey(display));
      if (state) {
        state.ioError = true;
        return 0;
      }
      return forward(previousIoHandler, ioType, [display]);
    }, koffi.pointer(ioType));
    ioExitCallback = koffi.register((display) => {
      const state = displays.get(displayKey(display));
      if (state) state.ioError = true;
    }, koffi.pointer(ioExitType));
    previousProtocolHandler = XSetErrorHandler(protocolCallback);
    protocolInstalled = true;
    previousIoHandler = XSetIOErrorHandler(ioCallback);
    ioInstalled = true;
  } catch (err) {
    let restoreError = null;
    if (ioInstalled) {
      try { XSetIOErrorHandler(previousIoHandler); } catch (restoreErr) { restoreError = restoreErr; }
    }
    if (protocolInstalled) {
      try { XSetErrorHandler(previousProtocolHandler); } catch (restoreErr) {
        restoreError = restoreError || restoreErr;
      }
    }
    if (restoreError) {
      // A process-global handler may still point at one of these trampolines.
      // Retain all callbacks for the lifetime of this process and poison the
      // capability instead of freeing a function pointer libX11 can call.
      XLIB_ERROR_BOUNDARIES.set(koffi, {
        broken: true,
        retainedCallbacks: [protocolCallback, ioCallback, ioExitCallback],
      });
      throw new X11InputRegionError(
        "ffi-error-boundary-restore",
        `could not restore Xlib error handlers after setup failed: ${restoreError.message}`,
      );
    }
    for (const callback of [protocolCallback, ioCallback, ioExitCallback]) {
      if (callback) {
        try { koffi.unregister(callback); } catch {}
      }
    }
    throw new X11InputRegionError("ffi-error-boundary", `could not install Xlib error handlers: ${err.message}`);
  }

  const boundary = {
    refCount: 1,
    registerDisplay(display) {
      const key = displayKey(display);
      if (displays.has(key)) {
        throw new X11InputRegionError("duplicate-display", "X11 Display is already registered");
      }
      const state = { protocolError: false, ioError: false };
      displays.set(key, state);
      try {
        XSetIOErrorExitHandler(display, ioExitCallback, null);
      } catch (err) {
        displays.delete(key);
        throw err;
      }
      return state;
    },
    unregisterDisplay(display) {
      if (!display) return;
      displays.delete(displayKey(display));
    },
    run(display, operation) {
      const state = displays.get(displayKey(display));
      if (!state) throw new X11InputRegionError("unknown-display", "X11 Display is not registered");
      state.protocolError = false;
      if (state.ioError) throw new X11InputRegionError("x-io-error", "the X11 connection is no longer usable");
      const result = operation();
      if (state.ioError) throw new X11InputRegionError("x-io-error", "Xlib reported a fatal I/O error");
      if (state.protocolError) throw new X11InputRegionError("x-protocol-error", "Xlib reported a protocol error");
      return result;
    },
    release() {
      if (boundary.refCount <= 0) return;
      boundary.refCount -= 1;
      if (boundary.refCount > 0) return;
      if (displays.size > 0) {
        boundary.refCount = 1;
        throw new X11InputRegionError("live-displays", "cannot release Xlib error boundary with live Displays");
      }
      let restoreError = null;
      try { XSetIOErrorHandler(previousIoHandler); } catch (err) { restoreError = err; }
      try { XSetErrorHandler(previousProtocolHandler); } catch (err) { restoreError = restoreError || err; }
      if (restoreError) {
        // At least one process-global handler may still point at our native
        // trampoline. Keep every callback registered and the singleton alive
        // so dispose can be retried without leaving a dangling function
        // pointer in libX11.
        boundary.refCount = 1;
        throw new X11InputRegionError(
          "ffi-error-boundary-restore",
          `could not restore Xlib error handlers: ${restoreError.message}`,
        );
      }
      for (const callback of [protocolCallback, ioCallback, ioExitCallback]) {
        try { koffi.unregister(callback); } catch {}
      }
      XLIB_ERROR_BOUNDARIES.delete(koffi);
    },
  };
  XLIB_ERROR_BOUNDARIES.set(koffi, boundary);
  return boundary;
}

function loadX11ShapeBindings(options = {}) {
  const koffi = options.koffi || require("koffi");
  let x11;
  let xext;
  try {
    x11 = koffi.load("libX11.so.6");
  } catch (err) {
    throw new X11InputRegionError("missing-x11", `could not load libX11.so.6: ${err.message}`);
  }
  try {
    xext = koffi.load("libXext.so.6");
  } catch (err) {
    throw new X11InputRegionError("missing-xext", `could not load libXext.so.6: ${err.message}`);
  }

  let XRectangle;
  let XOpenDisplay;
  let XCloseDisplay;
  let XFree;
  let XGetGeometry;
  let XSync;
  let XShapeQueryExtension;
  let XShapeCombineRectangles;
  let XShapeGetRectangles;
  let XSetErrorHandler;
  let XSetIOErrorHandler;
  let XSetIOErrorExitHandler;
  try {
    XRectangle = XRECTANGLE_TYPES.get(koffi);
    if (!XRectangle) {
      XRectangle = koffi.struct("ClawdNiriXRectangle", {
        x: "int16_t",
        y: "int16_t",
        width: "uint16_t",
        height: "uint16_t",
      });
      XRECTANGLE_TYPES.set(koffi, XRectangle);
    }
    XOpenDisplay = x11.func("void *XOpenDisplay(const char *display_name)");
    XCloseDisplay = x11.func("int XCloseDisplay(void *display)");
    XFree = x11.func("int XFree(void *data)");
    XSetErrorHandler = x11.func("void *XSetErrorHandler(void *handler)");
    XSetIOErrorHandler = x11.func("void *XSetIOErrorHandler(void *handler)");
    XSetIOErrorExitHandler = x11.func(
      "void XSetIOErrorExitHandler(void *display, void *handler, void *user_data)",
    );
    XGetGeometry = x11.func(
      "int XGetGeometry(void *display, unsigned long drawable, _Out_ unsigned long *root_return, _Out_ int *x_return, _Out_ int *y_return, _Out_ unsigned int *width_return, _Out_ unsigned int *height_return, _Out_ unsigned int *border_width_return, _Out_ unsigned int *depth_return)",
    );
    XSync = x11.func("int XSync(void *display, int discard)");
    XShapeQueryExtension = xext.func(
      "int XShapeQueryExtension(void *display, _Out_ int *event_base, _Out_ int *error_base)",
    );
    XShapeCombineRectangles = xext.func(
      "void XShapeCombineRectangles(void *display, unsigned long dest, int dest_kind, int x_offset, int y_offset, const ClawdNiriXRectangle *rectangles, int n_rectangles, int operation, int ordering)",
    );
    XShapeGetRectangles = xext.func(
      "ClawdNiriXRectangle *XShapeGetRectangles(void *display, unsigned long window, int kind, _Out_ int *count, _Out_ int *ordering)",
    );
  } catch (err) {
    throw new X11InputRegionError("ffi-declaration", `could not declare X11 Shape functions: ${err.message}`);
  }

  let disposed = false;
  let errorBoundary;
  try {
    errorBoundary = acquireXlibErrorBoundary({
      koffi,
      XSetErrorHandler,
      XSetIOErrorHandler,
      XSetIOErrorExitHandler,
    });
  } catch (err) {
    if (err instanceof X11InputRegionError) throw err;
    throw new X11InputRegionError("ffi-error-boundary", `could not install Xlib error handlers: ${err.message}`);
  }

  function runChecked(display, operation) {
    return errorBoundary.run(display, operation);
  }

  return {
    openDisplay() {
      const display = XOpenDisplay(null);
      if (!display) throw new X11InputRegionError("open-display", "XOpenDisplay returned null");
      try {
        errorBoundary.registerDisplay(display);
      } catch (err) {
        try { XCloseDisplay(display); } catch {}
        throw err;
      }
      return display;
    },
    closeDisplay(display) {
      try {
        runChecked(display, () => XCloseDisplay(display));
        return true;
      } finally {
        errorBoundary.unregisterDisplay(display);
      }
    },
    queryShape(display) {
      const eventBase = [0];
      const errorBase = [0];
      return !!runChecked(display, () => XShapeQueryExtension(display, eventBase, errorBase));
    },
    getGeometry(display, xid) {
      const root = [0];
      const x = [0];
      const y = [0];
      const width = [0];
      const height = [0];
      const border = [0];
      const depth = [0];
      const ok = runChecked(display, () => XGetGeometry(display, xid, root, x, y, width, height, border, depth));
      return ok ? { x: x[0], y: y[0], width: width[0], height: height[0], border: border[0], depth: depth[0] } : null;
    },
    setRect(display, xid, rect) {
      runChecked(display, () => {
        XShapeCombineRectangles(
          display,
          xid,
          SHAPE_INPUT,
          0,
          0,
          rect || null,
          rect ? 1 : 0,
          SHAPE_SET,
          UNSORTED,
        );
        XSync(display, 0);
      });
    },
    getRects(display, xid) {
      const count = [0];
      const ordering = [0];
      const pointer = runChecked(display, () => XShapeGetRectangles(display, xid, SHAPE_INPUT, count, ordering));
      if (!pointer) return count[0] === 0 ? [] : null;
      try {
        return koffi.decode(pointer, XRectangle, count[0]);
      } finally {
        XFree(pointer);
      }
    },
    dispose() {
      if (disposed) return;
      errorBoundary.release();
      disposed = true;
    },
  };
}

class LinuxX11InputRegion {
  constructor(options = {}) {
    this.window = options.window;
    this.bindings = options.bindings;
    this.display = null;
    this.xid = null;
    this.geometry = null;
    this.ratio = null;
    this.disposed = false;
    this.ownsBindings = options.ownsBindings === true;
    this.initialize(options.logicalSize);
  }

  initialize(logicalSize) {
    if (!this.window || typeof this.window.getNativeWindowHandle !== "function") {
      throw new X11InputRegionError("invalid-window", "render window has no native handle");
    }
    try {
      this.display = this.bindings.openDisplay();
      if (!this.bindings.queryShape(this.display)) {
        throw new X11InputRegionError("missing-shape", "X11 Shape extension is unavailable");
      }
      this.xid = parseXid(this.window.getNativeWindowHandle());
      this.geometry = this.bindings.getGeometry(this.display, this.xid);
      if (!this.geometry) throw new X11InputRegionError("get-geometry", "XGetGeometry failed");
      this.ratio = computePixelRatio(this.geometry, logicalSize);
    } catch (err) {
      this._closeDisplay();
      throw err;
    }
  }

  applyLogicalRect(rect) {
    this._assertLive();
    const nativeRect = normalizeInputRect(rect, this.ratio, this.geometry);
    this._writeAndVerify(nativeRect);
    return nativeRect;
  }

  suppress() {
    this._assertLive();
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    this._writeAndVerify(rect);
    return rect;
  }

  recalibrate(logicalSize) {
    this._assertLive();
    const xid = parseXid(this.window.getNativeWindowHandle());
    const suppressed = { x: 0, y: 0, width: 1, height: 1 };
    this._writeAndVerifyAt(xid, suppressed);
    const geometry = this.bindings.getGeometry(this.display, xid);
    if (!geometry) throw new X11InputRegionError("get-geometry", "XGetGeometry failed during recalibration");
    const ratio = computePixelRatio(geometry, logicalSize);
    this.xid = xid;
    this.geometry = geometry;
    this.ratio = ratio;
    return { xid: this.xid, geometry: { ...geometry }, ratio: { ...this.ratio } };
  }

  dispose() {
    if (this.disposed) return;
    let suppressError = null;
    try {
      if (this.display && this.xid) this.suppress();
    } catch (err) {
      suppressError = err;
    }
    this._closeDisplay();
    if (this.ownsBindings && this.bindings && typeof this.bindings.dispose === "function") {
      this.bindings.dispose();
    }
    this.disposed = true;
    if (suppressError) throw suppressError;
  }

  _writeAndVerify(rect) {
    this._writeAndVerifyAt(this.xid, rect);
  }

  _writeAndVerifyAt(xid, rect) {
    this.bindings.setRect(this.display, xid, rect);
    const actual = this.bindings.getRects(this.display, xid);
    if (!rectsEqual(actual, rect)) {
      throw new X11InputRegionError("readback-mismatch", "X11 Input Shape readback did not match the requested rect");
    }
  }

  _assertLive() {
    if (this.disposed || !this.display) {
      throw new X11InputRegionError("disposed", "X11 input region is disposed");
    }
  }

  _closeDisplay() {
    if (!this.display) return;
    try { this.bindings.closeDisplay(this.display); } catch {}
    this.display = null;
  }
}

function createLinuxX11InputRegion(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== "linux" || arch !== "x64") {
    throw new X11InputRegionError("unsupported-platform", "X11 input shape experiment supports Linux x64 only");
  }
  const ownsBindings = !options.bindings;
  const bindings = options.bindings || loadX11ShapeBindings({ koffi: options.koffi });
  try {
    return new LinuxX11InputRegion({ ...options, bindings, ownsBindings });
  } catch (err) {
    if (ownsBindings && typeof bindings.dispose === "function") {
      try { bindings.dispose(); } catch {}
    }
    throw err;
  }
}

module.exports = {
  LinuxX11InputRegion,
  X11InputRegionError,
  computePixelRatio,
  createLinuxX11InputRegion,
  loadX11ShapeBindings,
  normalizeInputRect,
  parseXid,
};

"use strict";

const net = require("node:net");

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_LINE_LIMIT = 1024 * 1024;

class NiriIpcError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "NiriIpcError";
    this.code = code;
    this.poisoned = options.poisoned === true;
  }
}

function decodeJsonLine(line, kind) {
  try {
    return JSON.parse(line);
  } catch {
    throw new NiriIpcError("invalid-json", `niri returned invalid ${kind} JSON`, { poisoned: true });
  }
}

function decodeReply(line) {
  const parsed = decodeJsonLine(line, "reply");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NiriIpcError("invalid-reply", "niri returned an invalid reply envelope", { poisoned: true });
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "Err")) {
    const message = typeof parsed.Err === "string" ? parsed.Err : "niri returned an error";
    throw new NiriIpcError("niri-error", message);
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "Ok")) {
    throw new NiriIpcError("invalid-reply", "niri reply omitted Ok/Err", { poisoned: true });
  }
  return parsed.Ok;
}

function decodeEvent(line) {
  const parsed = decodeJsonLine(line, "event");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NiriIpcError("invalid-event", "niri returned an invalid event", { poisoned: true });
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || typeof keys[0] !== "string") {
    throw new NiriIpcError("invalid-event", "niri event must contain exactly one variant", { poisoned: true });
  }
  return parsed;
}

function decodeTaggedResponse(response, tag, predicate) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new NiriIpcError("unexpected-response", `niri response was not ${tag}`);
  }
  if (!Object.prototype.hasOwnProperty.call(response, tag) || !predicate(response[tag])) {
    throw new NiriIpcError("unexpected-response", `niri response omitted or invalidated ${tag}`);
  }
  return response[tag];
}

function ensureHandled(response, action) {
  if (response !== "Handled") {
    throw new NiriIpcError("unexpected-response", `niri ${action} was not Handled`);
  }
  return true;
}

function validateWindowId(id, action) {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new NiriIpcError("invalid-request", `${action} requires a safe window id`);
  }
}

function validateFiniteDelta(value, axis) {
  if (!Number.isFinite(value)) {
    throw new NiriIpcError("invalid-request", `MoveFloatingWindow requires a finite ${axis} delta`);
  }
}

class LineSocketBase {
  constructor(options = {}) {
    this.socketPath = options.socketPath;
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    this.lineLimit = Number.isFinite(options.lineLimit)
      ? Math.max(256, options.lineLimit)
      : DEFAULT_LINE_LIMIT;
    this.createConnection = options.createConnection || ((socketPath) => net.createConnection(socketPath));
    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.connectPromise = null;
    this.closed = false;
    this.poisoned = false;
  }

  _connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.socket && this.connected) return Promise.resolve();
    this.connectPromise = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = this.createConnection(this.socketPath);
      } catch (err) {
        reject(new NiriIpcError("connect", `could not connect to niri: ${err && err.message ? err.message : err}`));
        return;
      }
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this._destroySocket();
        reject(new NiriIpcError("connect-timeout", "timed out connecting to niri", { poisoned: true }));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.connected = true;
        this._wireSocket(socket);
        resolve();
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.socket = null;
        reject(new NiriIpcError("connect", `could not connect to niri: ${err && err.message ? err.message : err}`));
      };
      const onClose = () => onError(new Error("socket closed before connect"));
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  _wireSocket(socket) {
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => this._poison("socket-error", err && err.message ? err.message : "niri socket error"));
    socket.on("end", () => this._poison("eof", "niri socket closed"));
    socket.on("close", () => {
      if (!this.closed && !this.poisoned) this._poison("eof", "niri socket closed");
    });
  }

  _appendData(chunk, onLine) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, incoming]);
    while (!this.closed && !this.poisoned) {
      const newline = this.buffer.indexOf(0x0A);
      if (newline < 0) break;
      if (newline > this.lineLimit) {
        this._poison("oversize", "niri IPC line exceeded the line limit");
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) {
        this._poison("invalid-line", "niri IPC returned an empty line");
        return;
      }
      onLine(line);
    }
    if (!this.poisoned && this.buffer.length > this.lineLimit) {
      this._poison("oversize", "niri IPC line exceeded the line limit");
    }
  }

  _destroySocket() {
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
    }
    this.socket = null;
    this.connected = false;
  }
}

class NiriIpcClient extends LineSocketBase {
  constructor(options = {}) {
    super(options);
    this.queue = [];
    this.pending = null;
  }

  request(payload) {
    if (this.closed) return Promise.reject(new NiriIpcError("closed", "niri IPC client is closed"));
    if (this.poisoned) {
      return Promise.reject(new NiriIpcError("poisoned", "niri IPC client is poisoned", { poisoned: true }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this._pump();
    });
  }

  version() {
    return this.request("Version").then((response) => (
      decodeTaggedResponse(response, "Version", (value) => typeof value === "string")
    ));
  }

  windows() {
    return this.request("Windows").then((response) => (
      decodeTaggedResponse(response, "Windows", Array.isArray)
    ));
  }

  workspaces() {
    return this.request("Workspaces").then((response) => (
      decodeTaggedResponse(response, "Workspaces", Array.isArray)
    ));
  }

  outputs() {
    return this.request("Outputs").then((response) => (
      decodeTaggedResponse(response, "Outputs", (value) => (
        value && typeof value === "object" && !Array.isArray(value)
      ))
    ));
  }

  moveFloatingWindowAdjust(options = {}) {
    const { id, x, y } = options;
    try {
      validateWindowId(id, "MoveFloatingWindow");
      validateFiniteDelta(x, "x");
      validateFiniteDelta(y, "y");
    } catch (err) {
      return Promise.reject(err);
    }
    return this.request({
      Action: {
        MoveFloatingWindow: {
          id,
          x: { AdjustFixed: x },
          y: { AdjustFixed: y },
        },
      },
    }).then((response) => ensureHandled(response, "MoveFloatingWindow"));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new NiriIpcError("closed", "niri IPC client closed");
    this._rejectAll(error);
    this._destroySocket();
  }

  _pump() {
    if (this.pending || this.closed || this.poisoned || this.queue.length === 0) return;
    this._connect().then(() => {
      if (this.pending || this.closed || this.poisoned || this.queue.length === 0) return;
      const item = this.queue.shift();
      let encoded;
      try {
        encoded = `${JSON.stringify(item.payload)}\n`;
      } catch (err) {
        item.reject(new NiriIpcError("invalid-request", err && err.message ? err.message : "request is not serializable"));
        this._pump();
        return;
      }
      const timer = setTimeout(() => this._poison("timeout", "niri IPC request timed out"), this.timeoutMs);
      this.pending = { ...item, timer };
      try {
        this.socket.write(encoded, (err) => {
          if (err) this._poison("write", err.message || "niri IPC write failed");
        });
      } catch (err) {
        this._poison("write", err && err.message ? err.message : "niri IPC write failed");
      }
    }).catch((err) => {
      const item = this.queue.shift();
      if (item) item.reject(err);
      this._pump();
    });
  }

  _onData(chunk) {
    if (this.poisoned || this.closed) return;
    this._appendData(chunk, (line) => {
      if (!this.pending) {
        this._poison("desync", "niri IPC returned an unsolicited reply");
        return;
      }
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      try {
        pending.resolve(decodeReply(line));
      } catch (err) {
        pending.reject(err);
        if (err && err.poisoned) {
          this._poison(err.code || "invalid-reply", err.message, { rejectPending: false });
          return;
        }
      }
      this._pump();
    });
  }

  _poison(code, message, options = {}) {
    if (this.poisoned || this.closed) return;
    this.poisoned = true;
    const error = new NiriIpcError(code, message, { poisoned: true });
    if (options.rejectPending !== false && this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    while (this.queue.length) this.queue.shift().reject(error);
    this._destroySocket();
  }

  _rejectAll(error) {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    while (this.queue.length) this.queue.shift().reject(error);
  }
}

class NiriEventStream extends LineSocketBase {
  constructor(options = {}) {
    super(options);
    this.started = false;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.startTimer = null;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
  }

  start() {
    if (this.closed) return Promise.reject(new NiriIpcError("closed", "niri event stream is closed"));
    if (this.poisoned) {
      return Promise.reject(new NiriIpcError("poisoned", "niri event stream is poisoned", { poisoned: true }));
    }
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this._connect().then(() => {
        this.startTimer = setTimeout(() => this._poison("timeout", "niri EventStream handshake timed out"), this.timeoutMs);
        try {
          this.socket.write(`${JSON.stringify("EventStream")}\n`, (err) => {
            if (err) this._poison("write", err.message || "niri EventStream write failed");
          });
        } catch (err) {
          this._poison("write", err && err.message ? err.message : "niri EventStream write failed");
        }
      }).catch((err) => this._rejectStart(err));
    });
    return this.startPromise;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startTimer);
    this._rejectStart(new NiriIpcError("closed", "niri event stream closed"));
    this._destroySocket();
  }

  _onData(chunk) {
    if (this.poisoned || this.closed) return;
    this._appendData(chunk, (line) => {
      if (!this.started) {
        let response;
        try {
          response = decodeReply(line);
          ensureHandled(response, "EventStream");
        } catch (err) {
          this._rejectStart(err);
          if (err && err.poisoned) this._poison(err.code, err.message, { rejectStart: false });
          else this._poison("event-stream-handshake", err.message, { rejectStart: false });
          return;
        }
        this.started = true;
        clearTimeout(this.startTimer);
        const resolve = this.startResolve;
        this.startResolve = null;
        this.startReject = null;
        if (resolve) resolve();
        return;
      }
      try {
        this.onEvent(decodeEvent(line));
      } catch (err) {
        this._poison(err.code || "invalid-event", err.message);
      }
    });
  }

  _rejectStart(error) {
    clearTimeout(this.startTimer);
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    if (reject) reject(error);
  }

  _poison(code, message, options = {}) {
    if (this.poisoned || this.closed) return;
    this.poisoned = true;
    const error = new NiriIpcError(code, message, { poisoned: true });
    if (options.rejectStart !== false) this._rejectStart(error);
    this._destroySocket();
    try { this.onError(error); } catch {}
  }
}

function createNiriIpcClient(options) {
  return new NiriIpcClient(options);
}

function createNiriEventStream(options) {
  return new NiriEventStream(options);
}

module.exports = {
  NiriIpcClient,
  NiriEventStream,
  NiriIpcError,
  createNiriIpcClient,
  createNiriEventStream,
  decodeEvent,
  decodeReply,
};

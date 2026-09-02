"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { describe, it } = require("node:test");

const {
  NiriEventStream,
  NiriIpcClient,
  decodeEvent,
  decodeReply,
} = require("../src/niri-ipc-client");

class FakeSocket extends EventEmitter {
  constructor(onWrite = () => {}) {
    super();
    this.onWrite = onWrite;
    this.writes = [];
    this.destroyed = false;
  }

  write(value, callback) {
    this.writes.push(String(value));
    this.onWrite(String(value), this);
    if (callback) callback();
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function createSocketFactory(onWrite) {
  const sockets = [];
  return {
    sockets,
    createConnection: () => {
      const socket = new FakeSocket(onWrite);
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  };
}

describe("niri IPC client", () => {
  it("decodes reply envelopes and bare event variants", () => {
    assert.deepStrictEqual(decodeReply('{"Ok":{"Windows":[]}}'), { Windows: [] });
    assert.deepStrictEqual(
      decodeEvent('{"WindowClosed":{"id":7}}'),
      { WindowClosed: { id: 7 } },
    );
    assert.throws(() => decodeReply('{"Err":"no"}'), (err) => err.code === "niri-error" && !err.poisoned);
    assert.throws(() => decodeEvent("[]"), (err) => err.code === "invalid-event" && err.poisoned);
  });

  it("serializes command requests sequentially and keeps an aligned socket reusable", async () => {
    const factory = createSocketFactory((line, socket) => {
      const request = JSON.parse(line);
      const replies = {
        Version: '{"Ok":{"Version":"26.04"}}\n',
        Windows: '{"Ok":{"Windows":[]}}\n',
        Workspaces: '{"Ok":{"Workspaces":[]}}\n',
      };
      queueMicrotask(() => socket.emit("data", Buffer.from(replies[request])));
    });
    const client = new NiriIpcClient({
      socketPath: "/run/user/1000/niri.sock",
      createConnection: factory.createConnection,
      timeoutMs: 100,
    });
    assert.deepStrictEqual(
      await Promise.all([client.version(), client.windows(), client.workspaces()]),
      ["26.04", [], []],
    );
    assert.deepStrictEqual(factory.sockets[0].writes.map(JSON.parse), ["Version", "Windows", "Workspaces"]);
    client.close();
  });

  it("emits exact AdjustFixed MoveFloatingWindow schema and validates finite values", async () => {
    const factory = createSocketFactory((_line, socket) => {
      queueMicrotask(() => socket.emit("data", Buffer.from('{"Ok":"Handled"}\n')));
    });
    const client = new NiriIpcClient({
      socketPath: "/tmp/niri.sock",
      createConnection: factory.createConnection,
    });
    await client.moveFloatingWindowAdjust({ id: 42, x: 4.5, y: -3 });
    assert.deepStrictEqual(JSON.parse(factory.sockets[0].writes[0]), {
      Action: {
        MoveFloatingWindow: {
          id: 42,
          x: { AdjustFixed: 4.5 },
          y: { AdjustFixed: -3 },
        },
      },
    });
    await assert.rejects(
      client.moveFloatingWindowAdjust({ id: 42, x: NaN, y: 0 }),
      (err) => err.code === "invalid-request",
    );
    client.close();
  });

  it("poisons a command socket after timeout or unsolicited data", async () => {
    const factory = createSocketFactory(() => {});
    const client = new NiriIpcClient({
      socketPath: "/tmp/niri.sock",
      createConnection: factory.createConnection,
      timeoutMs: 5,
    });
    await assert.rejects(client.version(), (err) => err.code === "timeout" && err.poisoned);
    assert.equal(factory.sockets[0].destroyed, true);
    await assert.rejects(client.windows(), (err) => err.code === "poisoned");
  });

  it("bounds the connect phase for command and EventStream sockets", async () => {
    const neverConnects = () => new FakeSocket();
    const client = new NiriIpcClient({
      socketPath: "/tmp/niri.sock",
      createConnection: neverConnects,
      timeoutMs: 5,
    });
    await assert.rejects(client.version(), (err) => err.code === "connect-timeout");
    const stream = new NiriEventStream({
      socketPath: "/tmp/niri.sock",
      createConnection: neverConnects,
      timeoutMs: 5,
    });
    await assert.rejects(stream.start(), (err) => err.code === "connect-timeout");
  });

  it("uses a dedicated EventStream socket and parses handshake plus coalesced events", async () => {
    const seen = [];
    const factory = createSocketFactory((_line, socket) => {
      queueMicrotask(() => socket.emit("data", Buffer.from(
        '{"Ok":"Handled"}\n'
        + '{"WorkspacesChanged":{"workspaces":[]}}\n'
        + '{"WindowClosed":{"id":9}}\n',
      )));
    });
    const stream = new NiriEventStream({
      socketPath: "/tmp/niri.sock",
      createConnection: factory.createConnection,
      onEvent: (event) => seen.push(event),
    });
    await stream.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(factory.sockets[0].writes.map(JSON.parse), ["EventStream"]);
    assert.deepStrictEqual(seen, [
      { WorkspacesChanged: { workspaces: [] } },
      { WindowClosed: { id: 9 } },
    ]);
    stream.close();
  });

  it("poisons EventStream on a malformed post-handshake event", async () => {
    const errors = [];
    const factory = createSocketFactory((_line, socket) => {
      queueMicrotask(() => socket.emit("data", Buffer.from('{"Ok":"Handled"}\n[]\n')));
    });
    const stream = new NiriEventStream({
      socketPath: "/tmp/niri.sock",
      createConnection: factory.createConnection,
      onError: (err) => errors.push(err),
    });
    await stream.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "invalid-event");
    assert.equal(factory.sockets[0].destroyed, true);
  });
});

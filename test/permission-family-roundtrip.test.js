"use strict";

// opencode-family decision round-trips over the REAL reverse bridge
// (plan §9: "Always/reject round-trip", "no-decision zero traffic").
//
// These execute the full chain — handleDecide (IPC entry) → familyAlwaysPicked
// → resolvePermissionEntry → replyOpencodeFamilyPermission → an actual HTTP
// listener standing in for the plugin's Bun/Node reverse bridge — so a regression in
// any hop (e.g. Always silently degrading to "once", or no-decision leaking a
// bridge POST) turns a real request red instead of surviving source-string
// checks.

const assert = require("node:assert");
const Module = require("node:module");
const http = require("node:http");
const { describe, it } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function loadPermissionWithElectron(fakeElectron) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function makeHarness() {
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this.visible = false;
      this.listeners = new Map();
      this.sentEvents = [];
      this.webContents = {
        once: (name, listener) => this.listeners.set(name, listener),
        on: (name, listener) => this.listeners.set(name, listener),
        send: (...args) => this.sentEvents.push(args),
        isDestroyed: () => this.destroyed,
      };
    }
    static fromWebContents(sender) { return sender && sender.__window ? sender.__window : null; }
    setAlwaysOnTop() {}
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds || { x: 0, y: 0, width: 420, height: 240 }; }
    setSkipTaskbar() {}
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    on(name, listener) { this.listeners.set(name, listener); }
    loadFile() { this.listeners.get("did-finish-load")?.(); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
  }
  const fakeElectron = {
    BrowserWindow: FakeBrowserWindow,
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const initPermission = loadPermissionWithElectron(fakeElectron);
  const api = initPermission({
    sessions: new Map(),
    hideBubbles: false,
    petHidden: false,
    win: { isDestroyed: () => false },
    lang: "en",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    focusTerminalForSession: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    subscribeShortcuts: () => () => {},
    clearShortcutFailure() {},
    reportShortcutFailure() {},
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop() {},
    reapplyMacVisibility() {},
    repositionUpdateBubble() {},
    permDebugLog: null,
  });
  function present(entry) {
    api.addPendingPermission(entry, "test-present");
    api.showPermissionBubble(entry);
    const surface = api.getPermissionSurfaceWindow();
    const envelope = [...surface.sentEvents].reverse().find(([name]) => name === "permission-show")[1];
    api.handleBubbleHeight({ sender: { __window: surface } }, {
      height: 240,
      surfaceRevision: envelope.surfaceRevision,
      activeEntryId: envelope.activeEntryId,
      entryIds: envelope.entryIds,
    });
    return { sender: { __window: surface } };
  }
  return { api, present };
}

// A real localhost listener standing in for the plugin's reverse bridge.
function startBridge() {
  return new Promise((resolveStart) => {
    const requests = [];
    let waiter = null;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        requests.push({
          path: req.url,
          auth: req.headers.authorization || null,
          body: JSON.parse(body || "{}"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        if (waiter) { const w = waiter; waiter = null; w(); }
      });
    });
    server.on("error", (err) => { throw err; });
    server.listen(0, "127.0.0.1", () => {
      resolveStart({
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
        // Hard deadline: a mutated reply path that stops POSTing must turn
        // this red within the window, not hang the runner.
        firstRequest: (timeoutMs = 2000) => new Promise((resolve, reject) => {
          if (requests.length) return resolve();
          const timer = setTimeout(
            () => reject(new Error(`bridge received no request within ${timeoutMs}ms`)),
            timeoutMs
          );
          waiter = () => { clearTimeout(timer); resolve(); };
        }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeFakeBubble() {
  const bubble = {
    hidden: false,
    destroyed: false,
    webContents: {
      send(event) {
        if (event === "permission-hide") bubble.hidden = true;
      },
    },
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
  };
  return bubble;
}

function makeFamilyEntry(bridge, overrides = {}) {
  return {
    res: null,
    abortHandler: null,
    suggestions: [],
    sessionId: "opencode:ses_rt",
    bubble: null,
    hideTimer: null,
    toolName: "bash",
    toolInput: { command: "echo x" },
    resolvedSuggestion: null,
    createdAt: Date.now(),
    agentId: "opencode",
    familyRequestId: "per_rt_1",
    familyBridgeUrl: bridge.url,
    familyBridgeToken: "tok_rt",
    familyAlwaysCandidates: ["bash"],
    familyPatterns: [],
    ...overrides,
  };
}

describe("opencode-family bridge round-trips", () => {
  it("Always Allow: handleDecide('family-always') reaches the bridge as reply='always'", async () => {
    const bridge = await startBridge();
    try {
      const { api, present } = makeHarness();
      const entry = makeFamilyEntry(bridge);

      api.handleDecide(present(entry), "family-always");

      await bridge.firstRequest();
      assert.strictEqual(bridge.requests.length, 1);
      const req = bridge.requests[0];
      assert.strictEqual(req.path, "/reply");
      assert.strictEqual(req.auth, "Bearer tok_rt");
      assert.deepStrictEqual(req.body, { request_id: "per_rt_1", reply: "always" });
      assert.strictEqual(api.pendingPermissions.includes(entry), false, "entry resolved");
    } finally {
      await bridge.close();
    }
  });

  it("Deny: handleDecide('deny') reaches the bridge as reply='reject'", async () => {
    const bridge = await startBridge();
    try {
      const { api, present } = makeHarness();
      const entry = makeFamilyEntry(bridge);

      api.handleDecide(present(entry), "deny");

      await bridge.firstRequest();
      assert.deepStrictEqual(bridge.requests[0].body, { request_id: "per_rt_1", reply: "reject" });
    } finally {
      await bridge.close();
    }
  });

  it("Allow without the Always pick degrades to reply='once'", async () => {
    const bridge = await startBridge();
    try {
      const { api, present } = makeHarness();
      const entry = makeFamilyEntry(bridge);

      api.handleDecide(present(entry), "allow");

      await bridge.firstRequest();
      assert.deepStrictEqual(bridge.requests[0].body, { request_id: "per_rt_1", reply: "once" });
    } finally {
      await bridge.close();
    }
  });

  it("no-decision (autoclose) sends ZERO bridge traffic and still resolves the entry", async () => {
    const bridge = await startBridge();
    try {
      const { api } = makeHarness();
      const entry = makeFamilyEntry(bridge);
      api.pendingPermissions.push(entry);

      api.resolvePermissionEntry(entry, "no-decision", "autoclosed");

      assert.strictEqual(api.pendingPermissions.includes(entry), false, "entry spliced");
      // The reply POST would be fire-and-forget async — give it a real window
      // to (wrongly) arrive before asserting silence.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(bridge.requests.length, 0, "silent drop must not touch the bridge");
    } finally {
      await bridge.close();
    }
  });
});

"use strict";

// Shared-surface rollback: a platform throw after renderer acknowledgement
// drains only the delivered entry and destroys the failed serving surface.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const fs = require("node:fs");
const path = require("node:path");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

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

function createRollbackHarness({ throwAt }) {
  const createdWindows = [];
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this._closedHandler = null;
      this._didFinishLoad = null;
      this.sentEvents = [];
      this.webContents = {
        once: (event, cb) => {
          if (event === "did-finish-load") this._didFinishLoad = cb;
        },
        on() {},
        send: (...args) => { this.sentEvents.push(args); },
      };
      createdWindows.push(this);
    }
    setAlwaysOnTop() {}
    setBounds() {}
    loadFile() {
      if (typeof this._didFinishLoad === "function") this._didFinishLoad();
    }
    showInactive() {
      if (throwAt === "showInactive") throw new Error("showInactive boom");
      this.visible = true;
    }
    hide() { this.visible = false; }
    isVisible() { return this.visible === true; }
    setSkipTaskbar() {}
    on(event, cb) {
      if (event === "closed") this._closedHandler = cb;
    }
    isDestroyed() { return this.destroyed; }
    destroy() {
      this.destroyed = true;
      if (typeof this._closedHandler === "function") this._closedHandler();
    }
  }

  const fakeElectron = {
    BrowserWindow: Object.assign(FakeBrowserWindow, {
      fromWebContents(sender) { return sender && sender.__window || null; },
    }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const permissionFactory = loadPermissionWithElectron(fakeElectron);
  const api = permissionFactory({
    win: { isDestroyed() { return false; } },
    hideBubbles: false,
    doNotDisturb: false,
    bubbleFollowPet: false,
    sessions: new Map(),
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    isAgentPermissionsEnabled: () => true,
    subscribeShortcuts: () => () => {},
    clearShortcutFailure: () => {},
    reportShortcutFailure: () => {},
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    repositionUpdateBubble: () => {},
    focusTerminalForSession: () => {},
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
  });
  return { api, createdWindows };
}

function makeZcodeEntry(api) {
  const entry = {
    sessionId: "zcode:s1",
    agentId: "zcode",
    isZcode: true,
    toolName: "Bash",
    toolInput: { command: "npm test" },
    interaction: classifyPermissionInteraction({ agentId: "zcode", toolName: "Bash" }),
    suggestions: [],
    bubble: null,
    hideTimer: null,
    createdAt: Date.now(),
  };
  api.pendingPermissions.push(entry);
  return entry;
}

describe("showPermissionBubble partial-create rollback", () => {
  it("never destroys a shared surface from one route entry's rollback", () => {
    const routeSource = fs.readFileSync(
      path.join(__dirname, "..", "src", "server-route-permission.js"),
      "utf8"
    );

    assert.doesNotMatch(routeSource, /permEntry\.bubble\.destroy\s*\(/);
  });

  it("destroys the serving surface and releases its entry when reveal throws", () => {
    const { api, createdWindows } = createRollbackHarness({ throwAt: "showInactive" });
    const entry = makeZcodeEntry(api);

    assert.doesNotThrow(() => api.showPermissionBubble(entry));
    const surface = api.getPermissionSurfaceWindow();
    assert.ok(surface);
    assert.doesNotThrow(() => {
      api.handleBubbleHeight({ sender: { __window: surface } }, 180);
    });

    // The window was torn down — no orphaned BrowserWindow with live handlers.
    assert.strictEqual(createdWindows.length, 1);
    assert.strictEqual(createdWindows[0].destroyed, true);
    assert.strictEqual(api.pendingPermissions.length, 0);
    assert.strictEqual(api.getPermissionSurfaceWindow(), null);
  });

  it("leaves no window behind when nothing throws (control)", () => {
    const { api, createdWindows } = createRollbackHarness({ throwAt: null });
    const entry = makeZcodeEntry(api);

    api.showPermissionBubble(entry);

    assert.strictEqual(createdWindows.length, 1);
    assert.strictEqual(createdWindows[0].destroyed, false);
    assert.strictEqual(api.getPermissionSurfaceWindow(), createdWindows[0]);
    assert.strictEqual(createdWindows[0].visible, undefined, "surface stays hidden before height acknowledgement");
  });
});

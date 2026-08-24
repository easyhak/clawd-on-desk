"use strict";

// #601: hiding the pet must not kill the permission hotkeys wholesale. New
// requests still pop bubbles while hidden (docs/project/theme-state-ui.md), so
// the hotkeys stay registered exactly when a visible bubble exists — and a
// keypress must never resolve a collapsed (invisible) request.

const assert = require("node:assert");
const Module = require("node:module");
const { afterEach, test } = require("node:test");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

const ALLOW_ACCEL = "CommandOrControl+Shift+Y";
const DENY_ACCEL = "CommandOrControl+Shift+N";

function loadPermissionWithMocks({ electron, platform = "win32" }) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: originalPlatform.enumerable,
    value: platform,
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "child_process") return { execFile() {} };
    return originalLoad.apply(this, arguments);
  };

  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

function createGlobalShortcut() {
  const registered = new Map();
  return {
    registered,
    register(accelerator, handler) {
      registered.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
  };
}

function createResponse() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers || {};
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.writableEnded = true;
    },
    on() {},
    removeListener() {},
  };
}

function createFakeBubble({ visible }) {
  return {
    destroyed: false,
    visible,
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    hide() { this.visible = false; },
    showInactive() { this.visible = true; },
    destroy() { this.destroyed = true; },
    webContents: { send() {} },
  };
}

function createContext() {
  return {
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    subscribeShortcuts: () => () => {},
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => ({ x: 100, y: 100, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    repositionUpdateBubble: () => {},
    clearShortcutFailure: () => {},
    reportShortcutFailure: () => {},
    permDebugLog: null,
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
  };
}

function loadPermission() {
  const globalShortcut = createGlobalShortcut();
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this.visible = false;
      this.listeners = new Map();
      this.webContents = {
        once: (event, listener) => this.listeners.set(event, listener),
        on: (event, listener) => this.listeners.set(event, listener),
        send() {},
      };
    }
    setAlwaysOnTop() {}
    setBounds() {}
    setSkipTaskbar() {}
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    on(event, listener) { this.listeners.set(event, listener); }
    loadFile() { this.listeners.get("did-finish-load")?.(); }
    destroy() { this.destroyed = true; this.listeners.get("closed")?.(); }
  }
  const initPermission = loadPermissionWithMocks({
    electron: {
      BrowserWindow: Object.assign(FakeBrowserWindow, {
        fromWebContents(sender) { return sender && sender.__window || null; },
      }),
      globalShortcut,
    },
  });
  const context = createContext();
  return { permission: initPermission(context), context, globalShortcut };
}

function pushPending(permission, { bubble = null, res = createResponse() } = {}) {
  const entry = {
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-hidden-pet",
    bubble,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    agentId: "claude-code",
    interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" }),
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
  };
  permission.pendingPermissions.push(entry);
  return entry;
}

function present(permission, options = {}) {
  const entry = pushPending(permission, options);
  permission.showPermissionBubble(entry);
  const surface = permission.getPermissionSurfaceWindow();
  assert.ok(surface);
  permission.handleBubbleHeight({ sender: { __window: surface } }, 180);
  return { entry, surface };
}

afterEach(() => {
  delete require.cache[PERMISSION_MODULE_PATH];
});

test("pet hidden: hotkeys unregister when only collapsed bubbles remain", () => {
  const { permission, context, globalShortcut } = loadPermission();
  const { surface } = present(permission);
  assert.ok(globalShortcut.registered.has(ALLOW_ACCEL));

  // Hiding the pet collapses the pending bubble, then re-syncs the shortcuts.
  context.petHidden = true;
  permission.setPermissionPetHidden(true);
  surface.hide();
  permission.syncPermissionShortcuts();

  assert.strictEqual(globalShortcut.registered.size, 0);
});

test("pet hidden: a new visible bubble keeps the hotkeys registered", () => {
  const { permission, context, globalShortcut } = loadPermission();
  const old = present(permission);
  context.petHidden = true;
  permission.setPermissionPetHidden(true);
  old.surface.hide();
  present(permission);

  assert.ok(globalShortcut.registered.has(ALLOW_ACCEL));
  assert.ok(globalShortcut.registered.has(DENY_ACCEL));
});

test("pet hidden: hotkey resolves the visible request, never the collapsed one", () => {
  const { permission, context, globalShortcut } = loadPermission();
  const collapsedRes = createResponse();
  const visibleRes = createResponse();
  const collapsed = present(permission, { res: collapsedRes }).entry;
  context.petHidden = true;
  permission.setPermissionPetHidden(true);
  permission.getPermissionSurfaceWindow().hide();
  present(permission, { res: visibleRes });

  const handler = globalShortcut.registered.get(ALLOW_ACCEL);
  assert.strictEqual(typeof handler, "function");
  handler();

  assert.strictEqual(visibleRes.statusCode, 200);
  assert.match(visibleRes.body, /"behavior":"allow"/);
  assert.strictEqual(collapsedRes.statusCode, null);
  assert.deepStrictEqual(permission.pendingPermissions, [collapsed]);
  // Only the collapsed request remains, so the resolve-path re-sync must have
  // dropped the hotkeys again.
  assert.strictEqual(globalShortcut.registered.size, 0);
});

test("pet visible: a newer queued request does not steal the active hotkey", () => {
  const { permission, globalShortcut } = loadPermission();
  const activeRes = createResponse();
  const queuedRes = createResponse();
  present(permission, { res: activeRes });
  const queued = pushPending(permission, { res: queuedRes });
  permission.showPermissionBubble(queued);

  const handler = globalShortcut.registered.get(ALLOW_ACCEL);
  assert.strictEqual(typeof handler, "function");
  handler();

  assert.strictEqual(activeRes.statusCode, 200);
  assert.match(activeRes.body, /"behavior":"allow"/);
  assert.strictEqual(queuedRes.statusCode, null);
  assert.strictEqual(permission.pendingPermissions.length, 1);
});

test("pet visible: a pending entry not yet presented does not register hotkeys", () => {
  const { permission, globalShortcut } = loadPermission();
  pushPending(permission, { bubble: null });
  permission.syncPermissionShortcuts();

  assert.strictEqual(globalShortcut.registered.size, 0);
});

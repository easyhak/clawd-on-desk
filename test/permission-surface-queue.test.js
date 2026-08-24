"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it, afterEach } = require("node:test");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function createHarness({ failLoadWindowIndex = null } = {}) {
  const windows = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.listeners = new Map();
      this.sentEvents = [];
      this.bounds = null;
      this.webContents = {
        once: (event, listener) => this.listeners.set(event, listener),
        on: (event, listener) => this.listeners.set(event, listener),
        send: (...args) => this.sentEvents.push(args),
        isDestroyed: () => false,
      };
      windows.push(this);
    }
    static fromWebContents(sender) { return sender && sender.__window || null; }
    setAlwaysOnTop() {}
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds || { x: 0, y: 0, width: 420, height: 200 }; }
    setSkipTaskbar() {}
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    on(event, listener) { this.listeners.set(event, listener); }
    loadFile() {
      if (windows.indexOf(this) + 1 === failLoadWindowIndex) {
        throw new Error("candidate load failed");
      }
      this.listeners.get("did-finish-load")?.();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
    closeByUser() {
      this.listeners.get("close")?.();
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") {
      return {
        BrowserWindow: FakeBrowserWindow,
        globalShortcut: {
          register: () => true,
          unregister() {},
          isRegistered: () => false,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[PERMISSION_MODULE_PATH];
  let initPermission;
  try {
    initPermission = require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }

  const api = initPermission({
    win: { isDestroyed: () => false },
    lang: "en",
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    sessions: new Map(),
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    getPermissionAutomationMode: () => "off",
    getPetWindowBounds: () => ({ x: 120, y: 120, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop() {},
    reapplyMacVisibility() {},
    repositionUpdateBubble() {},
    focusTerminalForSession() {},
    subscribeShortcuts: () => () => {},
    clearShortcutFailure() {},
    reportShortcutFailure() {},
  });

  function response() {
    return {
      statusCode: null,
      body: "",
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      on() {},
      removeListener() {},
      writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
      end(chunk) { if (chunk != null) this.body += String(chunk); this.writableEnded = true; },
      destroy() { this.destroyed = true; },
    };
  }

  let sequence = 0;
  function entry({ input = false, command, passive = false } = {}) {
    const id = ++sequence;
    const res = passive ? null : response();
    const toolName = input ? "AskUserQuestion" : (passive ? "CodexExec" : "Bash");
    const value = {
      res,
      abortHandler() {},
      suggestions: [],
      sessionId: `session-${id}`,
      toolName,
      toolInput: input
        ? { questions: [{ id: "0", question: "Choose", options: [] }] }
        : { command: command || `echo ${id}` },
      createdAt: Date.now() - 5000,
      agentId: passive ? "codex" : "claude-code",
      isCodexNotify: passive,
      isElicitation: input,
      interaction: classifyPermissionInteraction({
        agentId: passive ? "codex" : "claude-code",
        eventKind: input ? "elicitation" : (passive ? "notification" : "permission"),
        toolName,
      }),
    };
    return value;
  }

  function add(value) {
    api.addPendingPermission(value, "test-added");
    api.showPermissionBubble(value);
    return value;
  }

  function lastEnvelope(win = api.getPermissionSurfaceWindow()) {
    const event = [...win.sentEvents].reverse().find(([channel]) => channel === "permission-show");
    assert.ok(event, "permission surface did not receive a payload");
    return event[1];
  }

  function acknowledge(win = api.getPermissionSurfaceWindow()) {
    const envelope = lastEnvelope(win);
    api.handleBubbleHeight({ sender: { __window: win } }, {
      height: 240,
      surfaceRevision: envelope.surfaceRevision,
      activeEntryId: envelope.activeEntryId,
      entryIds: envelope.entryIds,
    });
    return envelope;
  }

  return { api, windows, entry, add, lastEnvelope, acknowledge };
}

afterEach(() => {
  delete require.cache[PERMISSION_MODULE_PATH];
});

describe("permission shared surface queue", () => {
  it("keeps one window, preserves the active request, and ignores queue-only revision for decide", () => {
    const h = createHarness();
    const first = h.add(h.entry({ command: "first" }));
    const firstEnvelope = h.acknowledge();
    const second = h.add(h.entry({ command: "second" }));

    assert.strictEqual(h.windows.length, 1);
    const queuedEnvelope = h.lastEnvelope();
    assert.strictEqual(queuedEnvelope.activeEntryId, first.surfaceEntryId);
    assert.deepStrictEqual(queuedEnvelope.queue.map((item) => item.entryId), [second.surfaceEntryId]);

    h.api.handleDecide({ sender: { __window: h.api.getPermissionSurfaceWindow() } }, {
      behavior: "allow",
      entryId: first.surfaceEntryId,
      activeContentRevision: firstEnvelope.activeContentRevision,
    });

    assert.match(first.res.body, /"behavior":"allow"/);
    assert.strictEqual(second.res.statusCode, null);
    assert.strictEqual(h.api.pendingPermissions.length, 1);
    assert.strictEqual(h.lastEnvelope().activeEntryId, second.surfaceEntryId);
  });

  it("refreshes a queued request without changing the active-content revision", () => {
    const h = createHarness();
    const first = h.add(h.entry({ command: "first" }));
    h.acknowledge();
    const second = h.add(h.entry({ command: "before" }));
    const before = h.lastEnvelope();

    second.toolInput.command = "after";
    h.api.refreshPermissionEntry(second);
    const after = h.lastEnvelope();

    assert.strictEqual(after.activeEntryId, first.surfaceEntryId);
    assert.strictEqual(after.activeContentRevision, before.activeContentRevision);
    assert.notStrictEqual(after.surfaceRevision, before.surfaceRevision);
    assert.match(after.queue[0].summary, /after/);
  });

  it("rejects a stale active-content decision and republishes control recovery", () => {
    const h = createHarness();
    const first = h.add(h.entry());
    const oldEnvelope = h.acknowledge();
    h.api.refreshPermissionEntry(first);

    h.api.handleDecide({ sender: { __window: h.api.getPermissionSurfaceWindow() } }, {
      behavior: "deny",
      entryId: first.surfaceEntryId,
      activeContentRevision: oldEnvelope.activeContentRevision,
    });

    assert.strictEqual(first.res.statusCode, null);
    assert.strictEqual(h.api.pendingPermissions.length, 1);
    assert.strictEqual(h.lastEnvelope().restoreInteractionControls, true);
  });

  it("switches ordinary queued requests without deciding either one", () => {
    const h = createHarness();
    const first = h.add(h.entry({ command: "first" }));
    h.acknowledge();
    const second = h.add(h.entry({ command: "second" }));
    const envelope = h.lastEnvelope();

    h.api.handleSelect({ sender: { __window: h.api.getPermissionSurfaceWindow() } }, {
      targetEntryId: second.surfaceEntryId,
      observedActiveEntryId: first.surfaceEntryId,
      activeContentRevision: envelope.activeContentRevision,
    });

    assert.strictEqual(first.res.statusCode, null);
    assert.strictEqual(second.res.statusCode, null);
    assert.strictEqual(h.lastEnvelope().activeEntryId, second.surfaceEntryId);
  });

  it("locks request switching while the active card owns an input draft", () => {
    const h = createHarness();
    const input = h.add(h.entry({ input: true }));
    h.acknowledge();
    const queued = h.add(h.entry());
    const envelope = h.lastEnvelope();
    assert.strictEqual(envelope.switchingLocked, true);

    h.api.handleSelect({ sender: { __window: h.api.getPermissionSurfaceWindow() } }, {
      targetEntryId: queued.surfaceEntryId,
      observedActiveEntryId: input.surfaceEntryId,
      activeContentRevision: envelope.activeContentRevision,
    });

    assert.strictEqual(h.lastEnvelope().activeEntryId, input.surfaceEntryId);
    assert.strictEqual(h.lastEnvelope().restoreInteractionControls, true);
  });

  it("uses a hidden candidate and swaps only after native-mode acknowledgement", () => {
    const h = createHarness();
    const first = h.add(h.entry());
    h.acknowledge();
    const input = h.add(h.entry({ input: true }));
    const envelope = h.lastEnvelope();
    const oldWindow = h.api.getPermissionSurfaceWindow();

    h.api.handleSelect({ sender: { __window: oldWindow } }, {
      targetEntryId: input.surfaceEntryId,
      observedActiveEntryId: first.surfaceEntryId,
      activeContentRevision: envelope.activeContentRevision,
    });

    assert.strictEqual(h.windows.length, 2);
    const candidate = h.windows[1];
    assert.strictEqual(candidate.visible, false);
    assert.strictEqual(h.api.getPermissionSurfaceWindow(), oldWindow);
    h.acknowledge(candidate);

    assert.strictEqual(h.api.getPermissionSurfaceWindow(), candidate);
    assert.strictEqual(candidate.visible, true);
    assert.strictEqual(oldWindow.destroyed, true);
    assert.strictEqual(h.lastEnvelope(candidate).activeEntryId, input.surfaceEntryId);
  });

  it("keeps the serving surface and every request when a handover candidate fails", () => {
    const h = createHarness({ failLoadWindowIndex: 2 });
    const first = h.add(h.entry());
    h.acknowledge();
    const input = h.add(h.entry({ input: true }));
    const envelope = h.lastEnvelope();
    const oldWindow = h.api.getPermissionSurfaceWindow();

    h.api.handleSelect({ sender: { __window: oldWindow } }, {
      targetEntryId: input.surfaceEntryId,
      observedActiveEntryId: first.surfaceEntryId,
      activeContentRevision: envelope.activeContentRevision,
    });

    assert.strictEqual(h.windows.length, 2);
    assert.strictEqual(h.windows[1].destroyed, true);
    assert.strictEqual(h.api.getPermissionSurfaceWindow(), oldWindow);
    assert.strictEqual(oldWindow.destroyed, false);
    assert.deepStrictEqual(h.api.pendingPermissions, [first, input]);
    assert.strictEqual(first.res.statusCode, null);
    assert.strictEqual(input.res.statusCode, null);
    assert.strictEqual(h.lastEnvelope(oldWindow).restoreInteractionControls, true);
  });

  it("returns no-decision for every request delivered to a failed serving surface", () => {
    const h = createHarness();
    const first = h.add(h.entry({ command: "first" }));
    h.acknowledge();
    const second = h.add(h.entry({ command: "second" }));
    h.acknowledge();
    const surface = h.api.getPermissionSurfaceWindow();

    surface.listeners.get("render-process-gone")({}, { reason: "crashed" });

    assert.strictEqual(first.res.destroyed, true);
    assert.strictEqual(second.res.destroyed, true);
    assert.deepStrictEqual(h.api.pendingPermissions, []);
    assert.strictEqual(h.api.getPermissionSurfaceWindow(), null);
  });

  it("excludes the pet-hidden cutoff from a newly delivered surface failure", () => {
    const h = createHarness();
    const oldEntry = h.add(h.entry({ command: "old" }));
    const surface = h.api.getPermissionSurfaceWindow();
    h.acknowledge(surface);
    h.api.setPermissionPetHidden(true);
    surface.hide();

    const newEntry = h.add(h.entry({ command: "new" }));
    const hiddenEnvelope = h.lastEnvelope(surface);
    assert.deepStrictEqual(hiddenEnvelope.entryIds, [newEntry.surfaceEntryId]);
    assert.strictEqual(surface.visible, false, "hidden surface must wait for matching content acknowledgement");
    h.acknowledge(surface);
    assert.strictEqual(surface.visible, true);

    surface.listeners.get("render-process-gone")({}, { reason: "crashed" });
    assert.deepStrictEqual(h.api.pendingPermissions, [oldEntry]);
    assert.strictEqual(oldEntry.res.destroyed, false);
    assert.strictEqual(newEntry.res.destroyed, true);
  });

  it("treats a user close as a decision for active only", () => {
    const h = createHarness();
    const active = h.add(h.entry({ command: "active" }));
    h.acknowledge();
    const queued = h.add(h.entry({ command: "queued" }));
    const surface = h.api.getPermissionSurfaceWindow();

    surface.closeByUser();

    assert.match(active.res.body, /"behavior":"deny"/);
    assert.strictEqual(queued.res.statusCode, null);
    assert.deepStrictEqual(h.api.pendingPermissions, [queued]);
    assert.notStrictEqual(h.api.getPermissionSurfaceWindow(), surface);
  });
});

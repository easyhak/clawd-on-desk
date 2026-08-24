"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function loadPermissionWithElectron(fakeElectron = null) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return fakeElectron || {
        BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
        globalShortcut: {
          register() { return true; },
          unregister() {},
          isRegistered() { return false; },
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function createCodexDecisionHarness() {
  const focusCalls = [];
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
    focus() {}
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
    getSettingsSnapshot: () => ({ shortcuts: {} }),
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
    focusTerminalForSession: (sessionId, options) => focusCalls.push([sessionId, options]),
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
  return { api, focusCalls, present };
}

function createFakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    _listeners: new Map(),
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || {};
    },
    end(data) {
      if (data) this.body += String(data);
      this.writableEnded = true;
      this.writableFinished = true;
    },
    on(event, handler) {
      this._listeners.set(event, handler);
      return this;
    },
    removeListener(event, handler) {
      if (this._listeners.get(event) === handler) this._listeners.delete(event);
      return this;
    },
    destroy() {
      this.destroyed = true;
      this.writableEnded = true;
      this.writableFinished = true;
      const handler = this._listeners.get("close");
      if (handler) handler();
    },
  };
  return res;
}

function createFakeBubble() {
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

describe("Codex permission response sanitizer", () => {
  it("omits unsupported fail-closed fields instead of setting them to null", () => {
    const permission = loadPermissionWithElectron();
    const body = permission.__test.buildCodexPermissionResponseBody({
      behavior: "allow",
      message: "ignored",
      updatedInput: null,
      updatedPermissions: [{ type: "setMode", mode: "default" }],
      interrupt: true,
    });
    const parsed = JSON.parse(body);
    const decision = parsed.hookSpecificOutput.decision;

    assert.deepStrictEqual(decision, { behavior: "allow" });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedInput"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedPermissions"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "interrupt"), false);
  });

  it("keeps deny messages and rejects invalid decisions as no-decision", () => {
    const permission = loadPermissionWithElectron();
    const denyBody = permission.__test.buildCodexPermissionResponseBody("deny", "Blocked");
    const deny = JSON.parse(denyBody).hookSpecificOutput.decision;

    assert.deepStrictEqual(deny, { behavior: "deny", message: "Blocked" });
    assert.strictEqual(permission.__test.buildCodexPermissionResponseBody({ behavior: "ask" }), "{}");
  });

  it("uses Codex-shaped Qwen responses while omitting unsupported fields", () => {
    const permission = loadPermissionWithElectron();
    const body = permission.__test.buildQwenCodePermissionResponseBody({
      behavior: "allow",
      message: "ignored",
      updatedInput: { command: "nope" },
      updatedPermissions: [{ type: "setMode", mode: "default" }],
      interrupt: true,
    });
    const parsed = JSON.parse(body);

    assert.deepStrictEqual(parsed.hookSpecificOutput.decision, { behavior: "allow" });
    assert.strictEqual(permission.__test.buildQwenCodePermissionResponseBody({ behavior: "ask" }), "{}");
  });

  it("uses the same minimal ZCode decision union (allow bare, deny with message)", () => {
    const permission = loadPermissionWithElectron();
    const allow = JSON.parse(permission.__test.buildZcodePermissionResponseBody({
      behavior: "allow",
      // ZCode's schema would accept these on the allow variant, but Clawd
      // never rewrites input or permission rules — they must be omitted.
      updatedInput: { command: "nope" },
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [] }],
      updatedPermissions: [],
    }));
    assert.deepStrictEqual(allow.hookSpecificOutput, {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    });

    const deny = JSON.parse(permission.__test.buildZcodePermissionResponseBody("deny", "Blocked by Clawd"));
    assert.deepStrictEqual(deny.hookSpecificOutput.decision, { behavior: "deny", message: "Blocked by Clawd" });

    assert.strictEqual(permission.__test.buildZcodePermissionResponseBody({ behavior: "ask" }), "{}");
    assert.strictEqual(permission.__test.buildZcodePermissionResponseBody(null), "{}");
  });

  it("keeps Antigravity allow/ask decisions and drops permissionOverrides", () => {
    const permission = loadPermissionWithElectron();
    const body = permission.__test.buildAntigravityPermissionResponseBody({
      decision: "force_ask",
      reason: "Review natively",
      permissionOverrides: ["command(npm test)"],
    });
    const parsed = JSON.parse(body);

    assert.deepStrictEqual(parsed, {
      decision: "force_ask",
      reason: "Review natively",
    });
    const allowBody = permission.__test.buildAntigravityPermissionResponseBody({
      decision: "allow",
      permissionOverrides: ["command(Remove-Item test.md)"],
    });
    assert.deepStrictEqual(JSON.parse(allowBody), {
      decision: "allow",
      allowTool: true,
    });
    assert.strictEqual(permission.__test.buildAntigravityPermissionResponseBody({ decision: "maybe" }), "{}");
  });

  it("treats Codex deny-and-focus as immediate no-decision instead of hanging the socket", () => {
    const { api, focusCalls, present } = createCodexDecisionHarness();
    const res = createFakeRes();
    const bubble = createFakeBubble();
    const permEntry = {
      res,
      abortHandler: () => {},
      suggestions: [],
      sessionId: "codex:s1",
      bubble,
      hideTimer: null,
      toolName: "Bash",
      toolInput: { command: "npm test" },
      createdAt: Date.now(),
      agentId: "codex",
      isCodex: true,
      sourcePid: 456,
      cwd: "/repo",
      agentPid: 456,
      pidChain: [789, 456],
      platform: "webui",
      model: "gpt-5.4",
      codexOriginator: "Codex Desktop",
      codexSource: "vscode",
    };
    const event = present(permEntry);

    api.handleDecide(event, "deny-and-focus");

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.writableEnded, true);
    assert.strictEqual(res.body, "");
    assert.deepStrictEqual(focusCalls, [[
      "codex:s1",
      {
        fallbackEntry: {
          id: "codex:s1",
          agentId: "codex",
          sourcePid: 456,
          cwd: "/repo",
          agentPid: 456,
          pidChain: [789, 456],
          platform: "webui",
          model: "gpt-5.4",
          codexOriginator: "Codex Desktop",
          codexSource: "vscode",
        },
      },
    ]]);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("treats Qwen deny-and-focus as immediate no-decision and focuses terminal", () => {
    const { api, focusCalls, present } = createCodexDecisionHarness();
    const res = createFakeRes();
    const bubble = createFakeBubble();
    const permEntry = {
      res,
      abortHandler: () => {},
      suggestions: [],
      sessionId: "qwen-code:s1",
      bubble,
      hideTimer: null,
      toolName: "Bash",
      toolInput: { command: "npm test" },
      createdAt: Date.now(),
      agentId: "qwen-code",
      isQwenCode: true,
      sourcePid: 456,
      cwd: "/repo",
      agentPid: 456,
      pidChain: [789, 456],
      model: "qwen3-coder-plus",
    };

    api.handleDecide(present(permEntry), "deny-and-focus");

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.deepStrictEqual(focusCalls, [[
      "qwen-code:s1",
      {
        fallbackEntry: {
          id: "qwen-code:s1",
          agentId: "qwen-code",
          sourcePid: 456,
          cwd: "/repo",
          agentPid: 456,
          pidChain: [789, 456],
          model: "qwen3-coder-plus",
        },
      },
    ]]);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("focuses the originating terminal when the Kimi cue's Got it button is clicked", () => {
    const { api, focusCalls, present } = createCodexDecisionHarness();
    const bubble = createFakeBubble();
    const permEntry = {
      res: null,
      abortHandler: null,
      suggestions: [],
      sessionId: "kimi-cli:s1",
      bubble,
      hideTimer: null,
      toolName: "KimiPermission",
      toolInput: { command: "rm -rf build" },
      createdAt: Date.now(),
      agentId: "kimi-cli",
      isKimiNotify: true,
    };
    const event = present(permEntry);

    // The renderer sends "allow" for the relabeled "Got it" button; the passive
    // branch dismisses regardless of the behavior value, and Kimi additionally
    // brings the terminal forward so the native approve/reject prompt is in view.
    api.handleDecide(event, "allow");

    assert.deepStrictEqual(focusCalls, [[
      "kimi-cli:s1",
      { fallbackEntry: { id: "kimi-cli:s1", agentId: "kimi-cli" } },
    ]]);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("dismisses a Codex passive notify without focusing the terminal", () => {
    const { api, focusCalls, present } = createCodexDecisionHarness();
    const bubble = createFakeBubble();
    const permEntry = {
      res: null,
      abortHandler: null,
      suggestions: [],
      sessionId: "codex:s1",
      bubble,
      hideTimer: null,
      toolName: "CodexExec",
      toolInput: { command: "npm test" },
      createdAt: Date.now(),
      agentId: "codex",
      isCodexNotify: true,
    };

    api.handleDecide(present(permEntry), "allow");

    // The focus-on-dismiss affordance is Kimi-only: Codex notify stays a plain
    // acknowledge. Pins the shared passive-notify branch against accidental
    // scope creep.
    assert.deepStrictEqual(focusCalls, []);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("does not let Codex take suggestion or opencode-only decision paths", () => {
    for (const behavior of ["suggestion:0", "family-always"]) {
      const { api, present } = createCodexDecisionHarness();
      const res = createFakeRes();
      const bubble = createFakeBubble();
      const permEntry = {
        res,
        abortHandler: () => {},
        suggestions: [{ type: "setMode", mode: "default" }],
        sessionId: "codex:s1",
        bubble,
        hideTimer: null,
        toolName: "Bash",
        toolInput: { command: "npm test" },
        createdAt: Date.now(),
        agentId: "codex",
        isCodex: true,
      };

      api.handleDecide(present(permEntry), behavior);

      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.body, "");
      assert.strictEqual(api.pendingPermissions.length, 0);
    }
  });

  it("treats Antigravity deny-and-focus as immediate no-decision instead of hanging the socket", () => {
    const { api, focusCalls, present } = createCodexDecisionHarness();
    const res = createFakeRes();
    const bubble = createFakeBubble();
    const permEntry = {
      res,
      abortHandler: () => {},
      suggestions: [],
      sessionId: "antigravity:s1",
      bubble,
      hideTimer: null,
      toolName: "run_command",
      toolInput: { CommandLine: "npm test" },
      createdAt: Date.now(),
      agentId: "antigravity-cli",
      isAntigravity: true,
      sourcePid: 456,
      cwd: "/repo",
      agentPid: 456,
      pidChain: [789, 456],
      platform: "win32",
    };
    const event = present(permEntry);

    api.handleDecide(event, "deny-and-focus");

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.writableEnded, true);
    assert.strictEqual(res.body, "");
    assert.deepStrictEqual(focusCalls, [[
      "antigravity:s1",
      {
        fallbackEntry: {
          id: "antigravity:s1",
          agentId: "antigravity-cli",
          sourcePid: 456,
          cwd: "/repo",
          agentPid: 456,
          pidChain: [789, 456],
          platform: "win32",
        },
      },
    ]]);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("responds to Antigravity allow and deny with direct hook stdout shape", () => {
    for (const behavior of ["allow", "deny"]) {
      const { api, present } = createCodexDecisionHarness();
      const res = createFakeRes();
      const bubble = createFakeBubble();
      const permEntry = {
        res,
        abortHandler: () => {},
        suggestions: [],
        sessionId: "antigravity:s1",
        bubble,
        hideTimer: null,
        toolName: "run_command",
        toolInput: { CommandLine: "npm test" },
        createdAt: Date.now(),
        agentId: "antigravity-cli",
        isAntigravity: true,
      };

      api.handleDecide(present(permEntry), behavior);

      assert.strictEqual(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.decision, behavior);
      if (behavior === "allow") {
        assert.strictEqual(parsed.allowTool, true);
      }
      assert.strictEqual(parsed.permissionOverrides, undefined);
      assert.strictEqual(api.pendingPermissions.length, 0);
    }
  });

  it("dismisses DND permissions without approving or denying on the user's behalf", () => {
    const { api } = createCodexDecisionHarness();
    const codexRes = createFakeRes();
    const qwenRes = createFakeRes();
    const claudeRes = createFakeRes();
    const opencodeRes = createFakeRes();
    const antigravityRes = createFakeRes();
    const codexBubble = createFakeBubble();
    const qwenBubble = createFakeBubble();
    const claudeBubble = createFakeBubble();
    const opencodeBubble = createFakeBubble();
    const antigravityBubble = createFakeBubble();
    const notifyBubble = createFakeBubble();

    api.pendingPermissions.push(
      {
        res: codexRes,
        abortHandler: () => {},
        sessionId: "codex:s1",
        bubble: codexBubble,
        hideTimer: null,
        agentId: "codex",
        isCodex: true,
      },
      {
        res: qwenRes,
        abortHandler: () => {},
        sessionId: "qwen-code:s1",
        bubble: qwenBubble,
        hideTimer: null,
        agentId: "qwen-code",
        isQwenCode: true,
      },
      {
        res: claudeRes,
        abortHandler: () => {},
        sessionId: "claude:s1",
        bubble: claudeBubble,
        hideTimer: null,
        agentId: "claude-code",
      },
      {
        res: opencodeRes,
        sessionId: "opencode:s1",
        bubble: opencodeBubble,
        hideTimer: null,
        agentId: "opencode",
        bridgeUrl: "http://127.0.0.1:9",
        bridgeToken: "token",
        requestId: "req-1",
      },
      {
        res: antigravityRes,
        abortHandler: () => {},
        sessionId: "antigravity:s1",
        bubble: antigravityBubble,
        hideTimer: null,
        agentId: "antigravity-cli",
        isAntigravity: true,
      },
      {
        sessionId: "codex:s1",
        bubble: notifyBubble,
        agentId: "codex",
        isCodexNotify: true,
      }
    );

    assert.strictEqual(api.dismissPermissionsForDnd(), 6);

    assert.strictEqual(codexRes.statusCode, 204);
    assert.strictEqual(codexRes.body, "");
    assert.strictEqual(qwenRes.statusCode, 204);
    assert.strictEqual(qwenRes.body, "");
    assert.strictEqual(antigravityRes.statusCode, 204);
    assert.strictEqual(antigravityRes.body, "");
    assert.strictEqual(claudeRes.destroyed, true);
    assert.strictEqual(opencodeRes.destroyed, false);
    assert.strictEqual(opencodeRes.statusCode, null);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("cleans up Qwen and Claude permissions without deciding when Clawd quits", () => {
    const { api } = createCodexDecisionHarness();
    const qwenRes = createFakeRes();
    const claudeRes = createFakeRes();
    api.pendingPermissions.push(
      {
        res: qwenRes,
        abortHandler: () => {},
        sessionId: "qwen-code:s1",
        bubble: createFakeBubble(),
        hideTimer: null,
        agentId: "qwen-code",
        isQwenCode: true,
      },
      {
        res: claudeRes,
        abortHandler: () => {},
        sessionId: "claude:s1",
        bubble: createFakeBubble(),
        hideTimer: null,
        agentId: "claude-code",
      }
    );

    api.cleanup();

    assert.strictEqual(qwenRes.statusCode, 204);
    assert.strictEqual(qwenRes.body, "");
    assert.strictEqual(claudeRes.destroyed, true);
    assert.strictEqual(claudeRes.body, "");
    assert.strictEqual(api.pendingPermissions.length, 0);
  });
});

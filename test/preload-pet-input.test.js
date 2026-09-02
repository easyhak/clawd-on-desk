"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const PRELOAD_PATH = require.resolve("../src/preload");

function loadPreload() {
  const exposed = {};
  const listeners = [];
  const originalLoad = Module._load;
  delete require.cache[PRELOAD_PATH];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        contextBridge: {
          exposeInMainWorld(name, value) { exposed[name] = value; },
        },
        ipcRenderer: {
          on(channel, listener) { listeners.push([channel, listener]); },
          send() {},
        },
        webUtils: { getPathForFile: () => "" },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(PRELOAD_PATH);
  } finally {
    Module._load = originalLoad;
    delete require.cache[PRELOAD_PATH];
  }
  return { exposed, listeners };
}

test("render visual and pet-input theme configs use disjoint IPC channels", () => {
  const { exposed, listeners } = loadPreload();
  exposed.electronAPI.onThemeConfig(() => {});
  exposed.petInputAPI.onThemeConfig(() => {});

  assert.deepStrictEqual(
    listeners.map(([channel]) => channel),
    ["theme-config", "pet-input-theme-config"],
  );
  assert.notEqual(listeners[0][0], listeners[1][0]);
});

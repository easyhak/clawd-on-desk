"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PRELOAD_HIT = path.join(__dirname, "..", "src", "preload-hit.js");

function loadPreload(argv = []) {
  const exposed = new Map();
  const sends = [];
  const ipcRenderer = {
    send: (...args) => sends.push(args),
    on: () => {},
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed.set(name, value);
    },
  };
  const context = {
    process: { argv, platform: "linux" },
    require(name) {
      if (name === "electron") {
        return {
          contextBridge,
          ipcRenderer,
          webUtils: { getPathForFile: () => "" },
        };
      }
      throw new Error(`Unexpected preload dependency: ${name}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(PRELOAD_HIT, "utf8"), context, { filename: PRELOAD_HIT });
  return { exposed, sends };
}

test("hit preload keeps the legacy drag IPC shape when diagnostics are disabled", () => {
  const { exposed, sends } = loadPreload(["electron", "app"]);
  const api = exposed.get("hitAPI");

  assert.deepStrictEqual(JSON.parse(JSON.stringify(exposed.get("hitDiagnostics"))), { drag: false });
  api.dragLock(true);
  api.dragMove();
  assert.deepStrictEqual(sends, [
    ["drag-lock", true],
    ["drag-move"],
  ]);
});

test("hit preload forwards diagnostic samples only when explicitly supplied", () => {
  const { exposed, sends } = loadPreload(["electron", "app", "--hit-drag-diagnostics=1"]);
  const api = exposed.get("hitAPI");
  const sample = { sequence: 2, screenX: 120, screenY: 240 };

  assert.deepStrictEqual(JSON.parse(JSON.stringify(exposed.get("hitDiagnostics"))), { drag: true });
  api.dragLock(true, sample);
  api.dragMove(sample);
  assert.deepStrictEqual(sends, [
    ["drag-lock", true, sample],
    ["drag-move", sample],
  ]);
});

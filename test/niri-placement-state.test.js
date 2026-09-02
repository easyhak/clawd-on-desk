"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { NiriPlacementState } = require("../src/niri-placement-state");

function layout(overrides = {}) {
  return {
    tile_size: [246, 246],
    window_size: [246, 246],
    tile_pos_in_workspace_view: [8.8, 23.2],
    window_offset_in_tile: [0, 0],
    ...overrides,
  };
}

function windowFixture(overrides = {}) {
  return {
    id: 7,
    title: "Clawd niri 123",
    app_id: "clawd-on-desk",
    workspace_id: 3,
    layout: layout(),
    ...overrides,
  };
}

describe("niri placement state", () => {
  it("resolves global logical geometry across negative output origins", () => {
    const state = new NiriPlacementState();
    state.replaceOutputs({
      DP_1: {
        name: "DP-1",
        logical: { x: -1920, y: -100, width: 1920, height: 1080, scale: 1.25 },
        current_mode: 0,
        modes: [{ refresh_rate: 120000 }],
      },
    });
    state.replaceWorkspaces([{ id: 3, output: "DP-1" }]);
    state.replaceWindows([windowFixture()]);
    assert.deepStrictEqual(state.getWindowRect(7), {
      x: -1911.2,
      y: -76.8,
      width: 246,
      height: 246,
      output: "DP-1",
      workspaceId: 3,
      scale: 1.25,
    });
    assert.equal(state.getRefreshIntervalMs(7), 1000000 / 120000);
  });

  it("keeps layout updates usable when workspace/output state arrives later", () => {
    const state = new NiriPlacementState();
    state.replaceWindows([windowFixture()]);
    state.applyEvent({
      WindowLayoutsChanged: { changes: [[7, layout({ tile_pos_in_workspace_view: [50, 60] })]] },
    });
    assert.equal(state.getWindowRect(7), null);
    state.applyEvent({ WorkspacesChanged: { workspaces: [{ id: 3, output: "HDMI-A-1" }] } });
    state.replaceOutputs({
      "HDMI-A-1": {
        name: "HDMI-A-1",
        logical: { x: 100, y: 200, width: 1280, height: 720, scale: 1 },
        current_mode: 0,
        modes: [{ refresh_rate: 60000 }],
      },
    });
    assert.deepStrictEqual(state.getWindowRect(7), {
      x: 150,
      y: 260,
      width: 246,
      height: 246,
      output: "HDMI-A-1",
      workspaceId: 3,
      scale: 1,
    });
  });

  it("follows workspace moves between outputs and rejects incomplete layout", () => {
    const state = new NiriPlacementState();
    state.replaceOutputs({
      A: { name: "A", logical: { x: 0, y: 0, scale: 1 }, modes: [], current_mode: null },
      B: { name: "B", logical: { x: 800, y: 10, scale: 1.25 }, modes: [], current_mode: null },
    });
    state.replaceWorkspaces([{ id: 3, output: "A" }, { id: 4, output: "B" }]);
    state.replaceWindows([windowFixture()]);
    assert.equal(state.getWindowRect(7).x, 8.8);
    state.applyEvent({ WindowOpenedOrChanged: { window: windowFixture({ workspace_id: 4 }) } });
    assert.equal(state.getWindowRect(7).x, 808.8);
    state.applyEvent({
      WindowLayoutsChanged: { changes: [[7, layout({ tile_pos_in_workspace_view: null })]] },
    });
    assert.equal(state.getWindowRect(7), null);
  });

  it("identifies exactly one title/app id match and refuses ambiguous or unsafe ids", () => {
    const state = new NiriPlacementState();
    state.replaceWindows([
      windowFixture(),
      windowFixture({ id: 8, title: "other" }),
      windowFixture({ id: Number.MAX_SAFE_INTEGER + 1, title: "ignored" }),
    ]);
    assert.equal(state.findExactWindow({ title: "Clawd niri 123", appId: "clawd-on-desk" }).id, 7);
    assert.equal(state.findExactWindow({ title: "Clawd niri 123" }), null);
    state.applyEvent({ WindowOpenedOrChanged: { window: windowFixture({ id: 9 }) } });
    assert.equal(state.findExactWindow({ title: "Clawd niri 123", appId: "clawd-on-desk" }), null);
  });
});

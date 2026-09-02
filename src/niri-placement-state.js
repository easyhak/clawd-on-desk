"use strict";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function replaceMap(items, getId) {
  const next = new Map();
  if (!Array.isArray(items)) return next;
  for (const item of items) {
    const id = getId(item);
    if (isSafeId(id)) next.set(id, item);
  }
  return next;
}

function validPair(value, predicate = isFiniteNumber) {
  return Array.isArray(value) && value.length === 2 && predicate(value[0]) && predicate(value[1]);
}

class NiriPlacementState {
  constructor() {
    this.outputs = new Map();
    this.workspaces = new Map();
    this.windows = new Map();
  }

  replaceOutputs(outputs) {
    const next = new Map();
    if (outputs && typeof outputs === "object" && !Array.isArray(outputs)) {
      for (const [key, output] of Object.entries(outputs)) {
        if (!output || typeof output !== "object") continue;
        const name = typeof output.name === "string" && output.name ? output.name : key;
        if (typeof name === "string" && name) next.set(name, output);
      }
    }
    this.outputs = next;
  }

  replaceWorkspaces(workspaces) {
    this.workspaces = replaceMap(workspaces, (workspace) => workspace && workspace.id);
  }

  replaceWindows(windows) {
    this.windows = replaceMap(windows, (window) => window && window.id);
  }

  applyEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    if (Object.prototype.hasOwnProperty.call(event, "WorkspacesChanged")) {
      this.replaceWorkspaces(event.WorkspacesChanged && event.WorkspacesChanged.workspaces);
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(event, "WindowsChanged")) {
      this.replaceWindows(event.WindowsChanged && event.WindowsChanged.windows);
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(event, "WindowOpenedOrChanged")) {
      const window = event.WindowOpenedOrChanged && event.WindowOpenedOrChanged.window;
      if (!window || !isSafeId(window.id)) return false;
      this.windows.set(window.id, window);
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(event, "WindowClosed")) {
      const id = event.WindowClosed && event.WindowClosed.id;
      if (!isSafeId(id)) return false;
      this.windows.delete(id);
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(event, "WindowLayoutsChanged")) {
      const changes = event.WindowLayoutsChanged && event.WindowLayoutsChanged.changes;
      if (!Array.isArray(changes)) return false;
      let changed = false;
      for (const entry of changes) {
        if (!Array.isArray(entry) || entry.length !== 2 || !isSafeId(entry[0])) continue;
        const current = this.windows.get(entry[0]);
        if (!current || !entry[1] || typeof entry[1] !== "object") continue;
        this.windows.set(entry[0], { ...current, layout: entry[1] });
        changed = true;
      }
      return changed;
    }
    return false;
  }

  findExactWindow({ title, appId }) {
    if (typeof title !== "string" || !title || typeof appId !== "string" || !appId) return null;
    const matches = [];
    for (const window of this.windows.values()) {
      if (window.title !== title) continue;
      if (window.app_id !== appId) continue;
      matches.push(window);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  getWindowRect(id) {
    const window = this.windows.get(id);
    if (!window || !isSafeId(window.workspace_id)) return null;
    const workspace = this.workspaces.get(window.workspace_id);
    if (!workspace || typeof workspace.output !== "string") return null;
    const output = this.outputs.get(workspace.output);
    const logical = output && output.logical;
    const layout = window.layout;
    if (!logical || !layout) return null;
    if (!isFiniteNumber(logical.x) || !isFiniteNumber(logical.y)) return null;
    if (!validPair(layout.tile_pos_in_workspace_view)) return null;
    if (!validPair(layout.window_offset_in_tile)) return null;
    if (!validPair(layout.window_size, Number.isInteger)) return null;
    const [width, height] = layout.window_size;
    if (width <= 0 || height <= 0) return null;
    return {
      x: logical.x + layout.tile_pos_in_workspace_view[0] + layout.window_offset_in_tile[0],
      y: logical.y + layout.tile_pos_in_workspace_view[1] + layout.window_offset_in_tile[1],
      width,
      height,
      output: workspace.output,
      workspaceId: window.workspace_id,
      scale: isFiniteNumber(logical.scale) && logical.scale > 0 ? logical.scale : null,
    };
  }

  getRefreshIntervalMs(id, fallbackMs = 16.667) {
    const rect = this.getWindowRect(id);
    const output = rect && this.outputs.get(rect.output);
    const index = output && output.current_mode;
    const mode = output && Array.isArray(output.modes) && Number.isInteger(index)
      ? output.modes[index]
      : null;
    const refreshRate = mode && mode.refresh_rate;
    if (!isFiniteNumber(refreshRate) || refreshRate <= 0) return fallbackMs;
    return 1000000 / refreshRate;
  }
}

module.exports = {
  NiriPlacementState,
  isSafeId,
};

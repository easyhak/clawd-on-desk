const { contextBridge, ipcRenderer } = require("electron");

let surfaceMeta = {
  surfaceRevision: null,
  activeContentRevision: null,
  activeEntryId: null,
  entryIds: [],
};

function updateSurfaceMeta(data) {
  if (!data || typeof data !== "object") return;
  surfaceMeta = {
    surfaceRevision: data.surfaceRevision,
    activeContentRevision: data.activeContentRevision,
    activeEntryId: data.activeEntryId,
    entryIds: Array.isArray(data.entryIds) ? [...data.entryIds] : [],
  };
}

contextBridge.exposeInMainWorld("bubbleAPI", {
  onPermissionShow: (cb) => ipcRenderer.on("permission-show", (_, data) => {
    updateSurfaceMeta(data);
    cb(data);
  }),
  decide: (behavior) => ipcRenderer.send("permission-decide", {
    behavior,
    entryId: surfaceMeta.activeEntryId,
    activeContentRevision: surfaceMeta.activeContentRevision,
  }),
  select: (targetEntryId) => ipcRenderer.send("permission-select", {
    targetEntryId,
    observedActiveEntryId: surfaceMeta.activeEntryId,
    activeContentRevision: surfaceMeta.activeContentRevision,
  }),
  onPermissionHide: (cb) => ipcRenderer.on("permission-hide", () => cb()),
  reportHeight: (height) => ipcRenderer.send("bubble-height", {
    height,
    surfaceRevision: surfaceMeta.surfaceRevision,
    activeEntryId: surfaceMeta.activeEntryId,
    entryIds: [...surfaceMeta.entryIds],
  }),
  setImeEditing: (editing) => ipcRenderer.send("bubble-ime-editing", {
    editing: !!editing,
    entryId: surfaceMeta.activeEntryId,
    activeContentRevision: surfaceMeta.activeContentRevision,
  }),
});

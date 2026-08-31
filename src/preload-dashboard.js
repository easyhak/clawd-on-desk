"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const snapshotListeners = new Set();
const langListeners = new Set();
const quickSelectIntentListeners = new Set();
const quickSelectExitListeners = new Set();

ipcRenderer.on("dashboard:session-snapshot", (_event, snapshot) => {
  for (const cb of snapshotListeners) {
    try { cb(snapshot); } catch (err) { console.warn("dashboard snapshot listener threw:", err); }
  }
});

ipcRenderer.on("dashboard:lang-change", (_event, payload) => {
  for (const cb of langListeners) {
    try { cb(payload); } catch (err) { console.warn("dashboard lang listener threw:", err); }
  }
});

ipcRenderer.on("dashboard:quick-select-intent", () => {
  for (const cb of quickSelectIntentListeners) {
    try { cb(); } catch (err) { console.warn("dashboard quick select listener threw:", err); }
  }
});

ipcRenderer.on("dashboard:quick-select-exit", () => {
  for (const cb of quickSelectExitListeners) {
    try { cb(); } catch (err) { console.warn("dashboard quick select exit listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("dashboardAPI", {
  getSnapshot: () => ipcRenderer.invoke("dashboard:get-snapshot"),
  getI18n: () => ipcRenderer.invoke("dashboard:get-i18n"),
  getKimiQuotaStatus: () => ipcRenderer.invoke("dashboard:get-kimi-quota-status"),
  refreshKimiQuota: () => ipcRenderer.invoke("dashboard:refresh-kimi-quota"),
  consumeQuickSelectIntent: () => ipcRenderer.invoke("dashboard:consume-quick-select-intent"),
  activateQuickSelectSession: (payload) =>
    ipcRenderer.invoke("dashboard:activate-quick-select-session", payload),
  focusSession: (sessionId) => ipcRenderer.send("dashboard:focus-session", sessionId),
  hideSession: (sessionId) => ipcRenderer.invoke("dashboard:hide-session", sessionId),
  openSessionFolder: (sessionId) => ipcRenderer.invoke("dashboard:open-session-folder", sessionId),
  setSessionAlias: (payload) => ipcRenderer.invoke("dashboard:set-session-alias", payload),
  setSessionAutomationOverride: (payload) =>
    ipcRenderer.invoke("dashboard:set-session-automation", payload),
  clearSessionAutomationGrant: (payload) =>
    ipcRenderer.invoke("dashboard:clear-session-automation-grant", payload),
  ackCompletion: (sessionId) => ipcRenderer.invoke("session:ack-completion", sessionId),
  onSessionSnapshot: (cb) => {
    if (typeof cb !== "function") return () => {};
    snapshotListeners.add(cb);
    return () => snapshotListeners.delete(cb);
  },
  onLangChange: (cb) => {
    if (typeof cb !== "function") return () => {};
    langListeners.add(cb);
    return () => langListeners.delete(cb);
  },
  onQuickSelectIntent: (cb) => {
    if (typeof cb !== "function") return () => {};
    quickSelectIntentListeners.add(cb);
    return () => quickSelectIntentListeners.delete(cb);
  },
  onQuickSelectExit: (cb) => {
    if (typeof cb !== "function") return () => {};
    quickSelectExitListeners.add(cb);
    return () => quickSelectExitListeners.delete(cb);
  },
});

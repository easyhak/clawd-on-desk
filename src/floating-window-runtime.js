"use strict";

const noop = () => {};

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function getPendingList(getPendingPermissions) {
  const pending = getPendingPermissions();
  return Array.isArray(pending) ? pending : [];
}

function createFloatingWindowRuntime(options = {}) {
  const getPendingPermissions = options.getPendingPermissions || (() => []);
  const getPermissionBubbleWindows = options.getPermissionBubbleWindows || (() => (
    getPendingList(getPendingPermissions).map((entry) => entry && entry.bubble).filter(Boolean)
  ));
  const ownsSharedPermissionSurface = typeof options.setPermissionPetHidden === "function";
  const setPermissionPetHidden = options.setPermissionPetHidden || (() => false);
  const keepOutOfTaskbar = options.keepOutOfTaskbar || noop;
  const repositionPermissionBubbles = options.repositionPermissionBubbles || noop;
  const repositionUpdateBubble = options.repositionUpdateBubble || noop;
  const repositionSessionHud = options.repositionSessionHud || noop;
  const repositionQuotaRing = options.repositionQuotaRing || noop;
  const syncSessionHudVisibility = options.syncSessionHudVisibility || noop;
  const syncUpdateBubbleVisibility = options.syncUpdateBubbleVisibility || noop;
  const hideUpdateBubble = options.hideUpdateBubble || noop;

  function repositionFloatingBubbles() {
    if (getPermissionBubbleWindows().length) repositionPermissionBubbles();
    repositionUpdateBubble();
    // Orbit reads both permission and update-bubble bounds. Reposition it last
    // so it never avoids the previous update-bubble position.
    repositionQuotaRing();
  }

  function repositionAnchoredSurfaces() {
    repositionSessionHud();
    repositionFloatingBubbles();
  }

  function syncSessionHudVisibilityAndBubbles() {
    syncSessionHudVisibility();
    repositionFloatingBubbles();
  }

  function showFloatingSurfacesForPet() {
    // The permission runtime republishes the shared surface and reveals it
    // only after the renderer acknowledges the new payload height.
    setPermissionPetHidden(false);
    if (!ownsSharedPermissionSurface) {
      for (const bubble of getPermissionBubbleWindows()) {
        if (isLiveWindow(bubble) && typeof bubble.showInactive === "function") {
          bubble.showInactive();
          keepOutOfTaskbar(bubble);
        }
      }
    }
    syncUpdateBubbleVisibility();
  }

  function hideFloatingSurfacesForPet() {
    // Record the cutoff before hiding any window. Requests that arrive after
    // this point are intentionally allowed to surface while the pet is hidden.
    setPermissionPetHidden(true);
    for (const bubble of getPermissionBubbleWindows()) {
      if (isLiveWindow(bubble) && typeof bubble.hide === "function") {
        bubble.hide();
      }
    }
    hideUpdateBubble();
  }

  return {
    repositionFloatingBubbles,
    repositionAnchoredSurfaces,
    syncSessionHudVisibilityAndBubbles,
    showFloatingSurfacesForPet,
    hideFloatingSurfacesForPet,
  };
}

module.exports = createFloatingWindowRuntime;

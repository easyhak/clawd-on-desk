(function exposePetInputController(root, factory) {
  "use strict";
  const exported = factory();
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.clawdPetInput = exported;
})(typeof globalThis === "object" ? globalThis : this, function buildPetInputController() {
  "use strict";

  const DRAG_THRESHOLD = 3;
  const CLICK_WINDOW_MS = 400;

  function createPetInputController(options = {}) {
    const area = options.area;
    const api = options.api;
    const ownedDocument = options.document || document;
    const ownedWindow = options.window || window;
    if (!area || typeof area.addEventListener !== "function") throw new TypeError("input area is required");
    if (!api) throw new TypeError("input API is required");

    let enabled = options.enabled !== false;
    let themeConfig = options.themeConfig || {};
    let reactions = themeConfig.reactions || {};
    let currentState = null;
    let miniMode = false;
    let dndEnabled = false;
    const isMac = !!options.isMac;

    let isDragging = false;
    let didDrag = false;
    let mouseDownX;
    let mouseDownY;
    let lastDragClientX;
    let latestDragPoint = null;
    let dragReactionDirection = null;
    let dragMoveRAF = null;
    let isReacting = false;
    let isDragReacting = false;
    let clickCount = 0;
    let clickTimer = null;
    let firstClickDir = null;

    function setThemeConfig(config) {
      themeConfig = config || {};
      reactions = themeConfig.reactions || {};
    }

    function setState(data = {}) {
      if (data.currentState !== undefined) currentState = data.currentState;
      if (data.miniMode !== undefined) {
        miniMode = !!data.miniMode;
        area.style.cursor = miniMode ? "default" : "";
      }
      if (data.dndEnabled !== undefined) dndEnabled = !!data.dndEnabled;
    }

    function setEnabled(value) {
      const next = value === true;
      if (enabled === next) return;
      if (!next) stopDrag();
      enabled = next;
      area.style.pointerEvents = enabled ? "auto" : "none";
    }

    function cancelReaction() {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        clickCount = 0;
        firstClickDir = null;
      }
      isReacting = false;
      isDragReacting = false;
      dragReactionDirection = null;
    }

    function queueDragMove() {
      if (dragMoveRAF !== null) return;
      dragMoveRAF = requestAnimationFrame(() => {
        dragMoveRAF = null;
        if (!enabled || !isDragging || !latestDragPoint) return;
        api.dragMove({ ...latestDragPoint });
      });
    }

    function clearQueuedDragMove() {
      if (dragMoveRAF === null) return;
      cancelAnimationFrame(dragMoveRAF);
      dragMoveRAF = null;
    }

    function viewportSize() {
      const width = Number.isFinite(ownedWindow.innerWidth) && ownedWindow.innerWidth > 0
        ? ownedWindow.innerWidth
        : area.offsetWidth;
      const height = Number.isFinite(ownedWindow.innerHeight) && ownedWindow.innerHeight > 0
        ? ownedWindow.innerHeight
        : area.offsetHeight;
      return { width, height };
    }

    area.addEventListener("pointerdown", (event) => {
      if (!enabled || event.button !== 0) return;
      if (miniMode) {
        didDrag = false;
        return;
      }
      area.setPointerCapture(event.pointerId);
      isDragging = true;
      didDrag = false;
      mouseDownX = event.clientX;
      mouseDownY = event.clientY;
      lastDragClientX = event.clientX;
      latestDragPoint = { clientX: event.clientX, clientY: event.clientY };
      dragReactionDirection = null;
      const size = viewportSize();
      api.dragLock(true, {
        grabX: event.clientX,
        grabY: event.clientY,
        innerWidth: size.width,
        innerHeight: size.height,
      });
      area.classList.add("dragging");
    });

    ownedDocument.addEventListener("pointermove", (event) => {
      if (!enabled || !isDragging) return;
      latestDragPoint = { clientX: event.clientX, clientY: event.clientY };
      if (!didDrag) {
        const totalDx = event.clientX - mouseDownX;
        const totalDy = event.clientY - mouseDownY;
        if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
          didDrag = true;
          startDragReaction(totalDx < 0 ? "left" : (totalDx > 0 ? "right" : null));
        }
      } else {
        const stepDx = event.clientX - lastDragClientX;
        if (stepDx !== 0) startDragReaction(stepDx < 0 ? "left" : "right");
      }
      lastDragClientX = event.clientX;
      queueDragMove();
    });

    function stopDrag() {
      if (!isDragging) return;
      clearQueuedDragMove();
      isDragging = false;
      api.dragLock(false);
      area.classList.remove("dragging");
      if (didDrag) api.dragEnd();
      endDragReaction(didDrag);
    }

    ownedDocument.addEventListener("pointerup", (event) => {
      if (!enabled || event.button !== 0) return;
      const wasDrag = didDrag;
      stopDrag();
      if (wasDrag) return;
      if (isMac && event.ctrlKey && !event.metaKey) {
        resetClickAccumulator();
        return;
      }
      const isDashboardShortcut = isMac
        ? event.metaKey
        : (event.ctrlKey && !event.metaKey);
      if (isDashboardShortcut) {
        resetClickAccumulator();
        api.showDashboard();
        return;
      }
      handleClick(event.clientX);
    });

    area.addEventListener("pointercancel", stopDrag);
    area.addEventListener("lostpointercapture", () => { if (isDragging) stopDrag(); });
    ownedWindow.addEventListener("blur", stopDrag);

    function reaction(name) {
      return reactions[name] || null;
    }

    function resetClickAccumulator() {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      clickCount = 0;
      firstClickDir = null;
    }

    function canPlayReactionNow() {
      return currentState === "idle" && !dndEnabled && !isReacting;
    }

    function handleClick(clientX) {
      if (miniMode) {
        api.exitMiniMode();
        return;
      }
      if (isDragReacting) return;
      clickCount += 1;
      if (clickCount === 1) {
        firstClickDir = clientX < area.offsetWidth / 2 ? "left" : "right";
        api.revealSessionHud();
      }
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      const doubleReact = reaction("double");
      const annoyedReact = reaction("annoyed");
      const leftReact = reaction("clickLeft");
      const rightReact = reaction("clickRight");
      if (clickCount >= 4 && doubleReact) {
        clickCount = 0;
        firstClickDir = null;
        if (!canPlayReactionNow()) return;
        const files = doubleReact.files || [doubleReact.file];
        playReaction(files[Math.floor(Math.random() * files.length)], doubleReact.duration || 3500);
      } else if (clickCount >= 2) {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          clickCount = 0;
          const direction = firstClickDir;
          firstClickDir = null;
          if (!canPlayReactionNow()) return;
          if (annoyedReact && Math.random() < 0.5) {
            playReaction(annoyedReact.file, annoyedReact.duration || 3500);
          } else if (leftReact && rightReact) {
            const selected = direction === "left" ? leftReact : rightReact;
            playReaction(selected.file, selected.duration || 2500);
          }
        }, CLICK_WINDOW_MS);
      } else {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          clickCount = 0;
          firstClickDir = null;
        }, CLICK_WINDOW_MS);
      }
    }

    function playReaction(svg, duration) {
      if (!svg) return;
      isReacting = true;
      api.playClickReaction(svg, duration);
      setTimeout(() => { isReacting = false; }, duration);
    }

    function startDragReaction(direction) {
      if (dndEnabled) return;
      if (isDragReacting && dragReactionDirection === direction) return;
      if (isReacting) isReacting = false;
      isDragReacting = true;
      dragReactionDirection = direction;
      api.startDragReaction(direction);
    }

    function endDragReaction(force = false) {
      if (!isDragReacting && !force) return;
      isDragReacting = false;
      dragReactionDirection = null;
      api.endDragReaction();
    }

    function dragHasFiles(event) {
      const types = event.dataTransfer && event.dataTransfer.types;
      if (!types) return false;
      for (const type of types) if (type === "Files") return true;
      return false;
    }

    if (!isMac) {
      area.addEventListener("dragover", (event) => {
        if (!enabled || miniMode || !dragHasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      });
      area.addEventListener("drop", (event) => {
        if (!enabled || !dragHasFiles(event)) return;
        event.preventDefault();
        if (miniMode) return;
        const paths = [];
        for (const file of event.dataTransfer.files || []) {
          const filePath = api.getPathForFile(file);
          if (typeof filePath === "string" && filePath) paths.push(filePath);
        }
        if (paths.length) api.dropPaths(paths);
      });
      if (typeof api.onDropAccepted === "function") {
        api.onDropAccepted(() => {
          if (!enabled || !canPlayReactionNow()) return;
          const doubleReact = reaction("double");
          if (doubleReact) {
            const files = doubleReact.files || [doubleReact.file];
            playReaction(files[Math.floor(Math.random() * files.length)], doubleReact.duration || 3500);
            return;
          }
          const left = reaction("clickLeft");
          const right = reaction("clickRight");
          const poke = left && right ? (Math.random() < 0.5 ? left : right) : (left || right);
          if (poke) playReaction(poke.file, poke.duration || 2500);
        });
      }
    }

    ownedDocument.addEventListener("contextmenu", (event) => {
      if (!enabled) return;
      event.preventDefault();
      api.showContextMenu();
    });

    if (typeof api.onThemeConfig === "function") api.onThemeConfig(setThemeConfig);
    if (typeof api.onStateSync === "function") api.onStateSync(setState);
    if (typeof api.onCancelReaction === "function") api.onCancelReaction(cancelReaction);
    if (!enabled) area.style.pointerEvents = "none";

    return {
      cancelReaction,
      isEnabled: () => enabled,
      setEnabled,
      setState,
      setThemeConfig,
    };
  }

  return { createPetInputController };
});

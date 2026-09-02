"use strict";

(function bootstrapRenderInput() {
  const area = document.getElementById("pet-input-layer");
  const api = window.petInputAPI;
  if (!area || !api || !globalThis.clawdPetInput) return;

  let generation = null;
  const controller = globalThis.clawdPetInput.createPetInputController({
    area,
    api,
    document,
    window,
    themeConfig: {},
    isMac: false,
    enabled: false,
  });

  function validPositive(value) {
    return Number.isFinite(value) && value > 0;
  }

  function applyLogicalRect(rect, logicalPerCss) {
    if (!rect || !logicalPerCss) return false;
    const values = [rect.x, rect.y, rect.width, rect.height, logicalPerCss.x, logicalPerCss.y];
    if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return false;
    if (!validPositive(logicalPerCss.x) || !validPositive(logicalPerCss.y)) return false;
    area.style.left = `${rect.x / logicalPerCss.x}px`;
    area.style.top = `${rect.y / logicalPerCss.y}px`;
    area.style.width = `${rect.width / logicalPerCss.x}px`;
    area.style.height = `${rect.height / logicalPerCss.y}px`;
    return true;
  }

  api.onBootstrap((payload) => {
    const nextGeneration = payload && payload.generation;
    const ok = Number.isSafeInteger(nextGeneration)
      && nextGeneration >= 0
      && applyLogicalRect(payload.rect, payload.logicalPerCss);
    if (ok) {
      generation = nextGeneration;
      controller.setEnabled(false);
      controller.setThemeConfig(payload.themeConfig || {});
      controller.setState(payload.state || {});
    }
    api.ackBootstrap({
      generation: Number.isSafeInteger(nextGeneration) ? nextGeneration : null,
      ok,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });
  });

  api.onEnabled((payload) => {
    const ok = !!payload
      && payload.generation === generation
      && typeof payload.enabled === "boolean";
    if (ok) controller.setEnabled(payload.enabled);
    api.ackEnabled({
      generation: payload && Number.isSafeInteger(payload.generation) ? payload.generation : null,
      enabled: ok && controller.isEnabled(),
      ok,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });
  });

  api.notifyReady({ innerWidth: window.innerWidth, innerHeight: window.innerHeight });
  window.renderInputController = controller;
})();

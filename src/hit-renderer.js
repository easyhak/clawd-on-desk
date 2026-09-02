"use strict";

const area = document.getElementById("hit-area");
window.hitInputController = globalThis.clawdPetInput.createPetInputController({
  area,
  api: window.hitAPI,
  document,
  window,
  themeConfig: window.hitThemeConfig || {},
  isMac: !!(window.hitPlatform && window.hitPlatform.isMac),
  enabled: true,
});

"use strict";

class PetInputOwner {
  constructor(options = {}) {
    const required = [
      "prepareRender",
      "enableRender",
      "disableRender",
      "suppressRender",
      "applyRenderRegion",
      "suppressHit",
      "restoreHit",
      "hideHit",
    ];
    for (const name of required) {
      if (typeof options[name] !== "function") throw new TypeError(`${name} is required`);
      this[name] = options[name];
    }
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.canSwitchFromHit = typeof options.canSwitchFromHit === "function"
      ? options.canSwitchFromHit
      : () => true;
    this.validatePreparedRender = typeof options.validatePreparedRender === "function"
      ? options.validatePreparedRender
      : () => true;
    this.state = "hit-active";
    this.inputOwner = "hit";
    this.transition = null;
  }

  activate() {
    if (this.state === "single-active") return Promise.resolve(true);
    if (this.transition) return this.transition;
    if (this.state !== "hit-active") return Promise.resolve(false);
    this.state = "switching";
    this.transition = this._activate().finally(() => { this.transition = null; });
    return this.transition;
  }

  async _activate() {
    try {
      await this.prepareRender();
      await this.enableRender();
      if (!this.canSwitchFromHit()) throw new Error("legacy hit input is busy");
      await this.suppressHit();
      this.inputOwner = "none";
      if (!this.validatePreparedRender()) throw new Error("prepared render input geometry changed");
      // Trust render immediately before exposing its native region. Before the
      // XSync/readback completes the surface is still physically suppressed.
      this.inputOwner = "render";
      await this.applyRenderRegion();
      await this.hideHit();
      this.state = "single-active";
      return true;
    } catch (err) {
      await this._rollbackBeforeHide(err);
      return false;
    }
  }

  async _rollbackBeforeHide(error) {
    this.inputOwner = "none";
    let renderSuppressed = false;
    try {
      await this.suppressRender();
      renderSuppressed = true;
    } catch (suppressError) {
      this.state = "input-disabled";
      try { this.onError(suppressError, "rollback-suppress-render"); } catch {}
    }
    try { await this.disableRender(); } catch {}
    if (!renderSuppressed) {
      try { this.onError(error, "activate"); } catch {}
      return;
    }
    try {
      await this.restoreHit();
      this.inputOwner = "hit";
      this.state = "hit-active";
    } catch (restoreError) {
      this.state = "input-disabled";
      try { this.onError(restoreError, "rollback-restore-hit"); } catch {}
    }
    try { this.onError(error, "activate"); } catch {}
  }

  async renderUnavailable(error) {
    if (this.transition) await this.transition;
    if (this.state !== "single-active") return false;
    this.state = "recovering";
    this.inputOwner = "none";
    try { await this.suppressRender(); } catch (suppressError) {
      try { this.onError(suppressError, "reload-suppress-render"); } catch {}
    }
    try { await this.disableRender(); } catch {}
    this.state = "input-disabled";
    if (error) {
      try { this.onError(error, "render-unavailable"); } catch {}
    }
    return true;
  }

  recoverSingle() {
    if (this.transition) return this.transition;
    if (this.state !== "input-disabled") return Promise.resolve(false);
    this.state = "recovering";
    this.transition = this._recoverSingle().finally(() => { this.transition = null; });
    return this.transition;
  }

  async _recoverSingle() {
    try {
      await this.prepareRender();
      await this.enableRender();
      this.inputOwner = "render";
      await this.applyRenderRegion();
      this.state = "single-active";
      return true;
    } catch (err) {
      this.inputOwner = "none";
      try { await this.suppressRender(); } catch {}
      try { await this.disableRender(); } catch {}
      this.state = "input-disabled";
      try { this.onError(err, "recover"); } catch {}
      return false;
    }
  }

  accepts(owner) {
    return owner === this.inputOwner;
  }

  snapshot() {
    return { state: this.state, inputOwner: this.inputOwner };
  }
}

module.exports = { PetInputOwner };

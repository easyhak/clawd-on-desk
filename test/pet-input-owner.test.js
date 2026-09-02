"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PetInputOwner } = require("../src/pet-input-owner");

function harness(failAt = null, options = {}) {
  const calls = [];
  const errors = [];
  const native = { hit: true, render: false };
  let hidden = false;
  let owner;
  const op = (name, effect) => async () => {
    calls.push(name);
    if (name === failAt) throw new Error(name);
    if (effect) effect();
    assert.equal(native.hit && native.render, false, `two native owners after ${name}`);
  };
  owner = new PetInputOwner({
    prepareRender: op("prepare"),
    enableRender: op("enable-controller"),
    canSwitchFromHit: options.canSwitchFromHit,
    validatePreparedRender: options.validatePreparedRender,
    disableRender: op("disable-controller"),
    suppressRender: op("suppress-render", () => { native.render = false; }),
    applyRenderRegion: op("apply-render", () => { native.render = true; }),
    suppressHit: op("suppress-hit", () => { native.hit = false; }),
    restoreHit: op("restore-hit", () => { native.hit = true; }),
    hideHit: op("hide-hit", () => { hidden = true; native.hit = false; }),
    onError: (error, phase) => errors.push([error.message, phase]),
  });
  return { owner, calls, errors, native, get hidden() { return hidden; } };
}

describe("pet input owner", () => {
  it("switches only after bootstrap/controller/shape gates and hides hit last", async () => {
    const h = harness();
    assert.equal(await h.owner.activate(), true);
    assert.deepStrictEqual(h.calls, [
      "prepare", "enable-controller", "suppress-hit", "apply-render", "hide-hit",
    ]);
    assert.deepStrictEqual(h.owner.snapshot(), { state: "single-active", inputOwner: "render" });
    assert.equal(h.hidden, true);
    assert.deepStrictEqual(h.native, { hit: false, render: true });
  });

  for (const step of ["prepare", "enable-controller", "suppress-hit", "apply-render", "hide-hit"]) {
    it(`rolls back before committing ownership when ${step} fails`, async () => {
      const h = harness(step);
      assert.equal(await h.owner.activate(), false);
      assert.equal(h.owner.accepts("hit"), true);
      assert.deepStrictEqual(h.owner.snapshot(), { state: "hit-active", inputOwner: "hit" });
      assert.deepStrictEqual(h.native, { hit: true, render: false });
      assert.equal(h.errors[0][0], step);
    });
  }

  it("never remaps hit during an active render reload and recovers in place", async () => {
    const h = harness();
    await h.owner.activate();
    h.calls.length = 0;
    assert.equal(await h.owner.renderUnavailable(new Error("renderer gone")), true);
    assert.deepStrictEqual(h.owner.snapshot(), { state: "input-disabled", inputOwner: "none" });
    assert.deepStrictEqual(h.calls, ["suppress-render", "disable-controller"]);
    assert.equal(h.calls.includes("restore-hit"), false);
    assert.equal(await h.owner.recoverSingle(), true);
    assert.deepStrictEqual(h.owner.snapshot(), { state: "single-active", inputOwner: "render" });
    assert.equal(h.calls.includes("restore-hit"), false);
  });

  it("fails input closed if rollback cannot restore hit", async () => {
    const h = harness("restore-hit");
    // Force an activation failure that reaches rollback.
    h.owner.applyRenderRegion = async () => { throw new Error("apply"); };
    assert.equal(await h.owner.activate(), false);
    assert.deepStrictEqual(h.owner.snapshot(), { state: "input-disabled", inputOwner: "none" });
  });

  it("does not restore hit when a partially exposed render region cannot be suppressed", async () => {
    const h = harness("suppress-render");
    h.owner.hideHit = async () => { throw new Error("hide-hit"); };
    assert.equal(await h.owner.activate(), false);
    assert.deepStrictEqual(h.owner.snapshot(), { state: "input-disabled", inputOwner: "none" });
    assert.equal(h.calls.includes("restore-hit"), false);
    assert.equal(h.errors.some((entry) => entry[1] === "rollback-suppress-render"), true);
  });

  it("refuses handoff when the legacy hit owner is in an active drag", async () => {
    const h = harness(null, { canSwitchFromHit: () => false });
    assert.equal(await h.owner.activate(), false);
    assert.equal(h.calls.includes("suppress-hit"), false);
    assert.deepStrictEqual(h.owner.snapshot(), { state: "hit-active", inputOwner: "hit" });
    assert.deepStrictEqual(h.native, { hit: true, render: false });
  });

  it("rolls back if compositor geometry changes at the ownership commit point", async () => {
    const h = harness(null, { validatePreparedRender: () => false });
    assert.equal(await h.owner.activate(), false);
    assert.equal(h.calls.includes("suppress-hit"), true);
    assert.equal(h.calls.includes("apply-render"), false);
    assert.deepStrictEqual(h.owner.snapshot(), { state: "hit-active", inputOwner: "hit" });
    assert.deepStrictEqual(h.native, { hit: true, render: false });
  });
});

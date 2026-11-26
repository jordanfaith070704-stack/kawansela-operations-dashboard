import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
const source = readFileSync(new URL("../../lib/operator-units.ts", import.meta.url), "utf8");
const { entryUnits, toBaseQuantity, OPERATOR_SERVING_ML } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "strip" })).toString("base64")}`);
const receive = (baseUnit, inputUnit, quantity, more = {}) => toBaseQuantity({ baseUnit, inputUnit, quantity, allowPack: true, ...more });

test("receiving liters and kilograms stores base ml and grams", () => {
  assert.deepEqual(receive("ml", "liter", "1.5"), { ok: true, quantity: 1500 });
  assert.deepEqual(receive("g", "kilogram", "2.25"), { ok: true, quantity: 2250 });
  assert.deepEqual(receive("gr", "kilogram", "0.5"), { ok: true, quantity: 500 });
  assert.deepEqual(receive("ml", "base", "25.5"), { ok: true, quantity: 25.5 });
});
test("each pack must have an explicit positive whole unit count", () => {
  assert.equal(receive("pcs", "pack", "2").ok, false);
  assert.equal(receive("pcs", "pack", "2", { unitsPerPack: "" }).ok, false);
  for (const unitsPerPack of [0, -1, 1.5, Infinity]) assert.equal(receive("pcs", "pack", 2, { unitsPerPack }).ok, false);
  assert.equal(receive("pcs", "pack", 1.5, { unitsPerPack: 50 }).ok, false);
  assert.deepEqual(receive("pcs", "pack", 2, { unitsPerPack: 50 }), { ok: true, quantity: 100 });
});
test("units are item-specific and packs are never assumed for liquids", () => {
  assert.equal(receive("ml", "kilogram", 1).ok, false);
  assert.equal(receive("g", "liter", 1).ok, false);
  assert.equal(receive("ml", "pack", 1, { unitsPerPack: 1000 }).ok, false);
  assert.equal(toBaseQuantity({ baseUnit: "pcs", inputUnit: "pack", quantity: 1, unitsPerPack: 50 }).ok, false);
  assert.equal(receive("pcs", "base", 1.5).ok, false);
  assert.deepEqual(entryUnits("pcs").map((u) => u.value), ["base"]);
});
test("prepared waste converts full and half glasses using the configured serving", () => {
  assert.equal(OPERATOR_SERVING_ML, 150);
  assert.deepEqual(toBaseQuantity({ baseUnit: "ml", inputUnit: "glass", quantity: 1, preparedDrink: true }), { ok: true, quantity: 150 });
  assert.deepEqual(toBaseQuantity({ baseUnit: "ml", inputUnit: "glass", quantity: 1.5, preparedDrink: true }), { ok: true, quantity: 225 });
  assert.equal(toBaseQuantity({ baseUnit: "ml", inputUnit: "glass", quantity: .3, preparedDrink: true }).ok, false);
  assert.equal(toBaseQuantity({ baseUnit: "ml", inputUnit: "base", quantity: .5, preparedDrink: true }).ok, false);
});
test("waste bounds are checked after conversion, including exact remaining stock", () => {
  assert.equal(toBaseQuantity({ baseUnit: "ml", inputUnit: "liter", quantity: 1.1, maxBaseQuantity: 1000 }).ok, false);
  assert.deepEqual(toBaseQuantity({ baseUnit: "ml", inputUnit: "liter", quantity: 1, maxBaseQuantity: 1000 }), { ok: true, quantity: 1000 });
  assert.equal(toBaseQuantity({ baseUnit: "g", inputUnit: "kilogram", quantity: .5, maxBaseQuantity: 499 }).ok, false);
  assert.equal(toBaseQuantity({ baseUnit: "ml", inputUnit: "glass", quantity: 2, preparedDrink: true, maxBaseQuantity: 299 }).ok, false);
  assert.deepEqual(toBaseQuantity({ baseUnit: "ml", inputUnit: "glass", quantity: 2, preparedDrink: true, maxBaseQuantity: 300 }), { ok: true, quantity: 300 });
});
test("invalid, empty, tiny and overflowing quantities never become stock", () => {
  for (const quantity of ["", " ", -1, 0, "not a number", Infinity, NaN, 1e14, .00001]) assert.equal(receive("ml", "base", quantity).ok, false);
  assert.equal(receive("pcs", "pack", 1e10, { unitsPerPack: 1e10 }).ok, false);
  assert.deepEqual(receive("g", "base", .1), { ok: true, quantity: .1 });
  assert.deepEqual(receive("ml", "liter", .001), { ok: true, quantity: 1 });
});

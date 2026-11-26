/** Serving size enforced by the existing recipe/POS schema. */
export const OPERATOR_SERVING_ML = 150;

export type EntryUnit = "base" | "liter" | "kilogram" | "pack" | "glass";
export type EntryUnitOption = { value: EntryUnit; label: string; step: string; min: string };
export type ConversionResult = { ok: true; quantity: number } | { ok: false; error: string };

type ConversionOptions = {
  baseUnit: string;
  inputUnit: string;
  quantity: number | string;
  unitsPerPack?: number | string;
  allowPack?: boolean;
  preparedDrink?: boolean;
  maxBaseQuantity?: number;
};

export function isWholeInventoryUnit(unit: string) {
  return ["pcs", "pc", "buah", "unit", "lembar", "cup", "lid", "botol"].includes(unit.toLowerCase().trim());
}

export function entryUnits(baseUnit: string, { allowPack = false, preparedDrink = false } = {}): EntryUnitOption[] {
  if (preparedDrink) return [
    { value: "base", label: "ml", step: "1", min: "1" },
    { value: "glass", label: `gelas (${OPERATOR_SERVING_ML} ml)`, step: "0.5", min: "0.5" },
  ];
  const unit = baseUnit.trim();
  const normalized = unit.toLowerCase();
  const whole = isWholeInventoryUnit(unit);
  const options: EntryUnitOption[] = [{ value: "base", label: unit || "satuan item", step: whole ? "1" : "0.001", min: whole ? "1" : "0.001" }];
  if (normalized === "ml") options.push({ value: "liter", label: "liter", step: "0.001", min: "0.001" });
  if (["g", "gr", "gram"].includes(normalized)) options.push({ value: "kilogram", label: "kg", step: "0.001", min: "0.001" });
  if (whole && allowPack) options.push({ value: "pack", label: "pak (isi sendiri)", step: "1", min: "1" });
  return options;
}

/** Convert human-entered quantities before the existing base-unit RPC boundary. */
export function toBaseQuantity(options: ConversionOptions): ConversionResult {
  const allowed = entryUnits(options.baseUnit, { allowPack: options.allowPack, preparedDrink: options.preparedDrink });
  if (!allowed.some((unit) => unit.value === options.inputUnit)) return { ok: false, error: "Pilih satuan yang sesuai dengan item." };
  if (String(options.quantity).trim() === "") return { ok: false, error: "Isi jumlah yang ingin dicatat." };
  const amount = Number(options.quantity);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Jumlah harus lebih dari nol." };
  let factor = 1;
  if (options.inputUnit === "liter" || options.inputUnit === "kilogram") factor = 1000;
  if (options.inputUnit === "glass") {
    if (!Number.isInteger(amount * 2)) return { ok: false, error: "Gunakan gelas utuh atau setengah gelas (0,5). Untuk volume lain, pilih ml." };
    factor = OPERATOR_SERVING_ML;
  }
  if (options.inputUnit === "pack") {
    if (!Number.isSafeInteger(amount)) return { ok: false, error: "Jumlah pak harus berupa angka bulat." };
    if (options.unitsPerPack === undefined || String(options.unitsPerPack).trim() === "") return { ok: false, error: `Isi jumlah ${options.baseUnit} dalam setiap pak.` };
    factor = Number(options.unitsPerPack);
    if (!Number.isSafeInteger(factor) || factor < 1) return { ok: false, error: `Isi per pak harus berupa angka bulat ${options.baseUnit} lebih dari nol.` };
  }
  const converted = amount * factor;
  if (!Number.isFinite(converted) || converted > 99_999_999_999.999) return { ok: false, error: "Jumlah terlalu besar. Periksa kembali satuan dan jumlah." };
  const quantity = Number(converted.toFixed(3));
  if (quantity <= 0 || Math.abs(converted - quantity) > 1e-7) return { ok: false, error: `Gunakan maksimal 3 angka desimal dalam satuan ${options.baseUnit}.` };
  if ((options.preparedDrink || isWholeInventoryUnit(options.baseUnit)) && !Number.isSafeInteger(quantity)) {
    return { ok: false, error: options.preparedDrink ? "Volume minuman harus menghasilkan ml bulat. Untuk sebagian gelas, gunakan ml." : `Jumlah ${options.baseUnit} harus berupa angka bulat.` };
  }
  if (options.maxBaseQuantity !== undefined) {
    if (!Number.isFinite(options.maxBaseQuantity) || options.maxBaseQuantity < 0) return { ok: false, error: "Stok tersedia belum dapat diperiksa. Muat ulang halaman." };
    if (quantity > options.maxBaseQuantity) return { ok: false, error: `Jumlah terbuang melebihi stok tersedia (${new Intl.NumberFormat("id-ID").format(options.maxBaseQuantity)} ${options.baseUnit}).` };
  }
  return { ok: true, quantity };
}

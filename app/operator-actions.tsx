"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./operator-actions.module.css";

/** Transactional actions use the existing server-side RPCs. */
export const OPERATOR_RPC = {
  createProduction: "create_production_batch",
  createProductionBatches: "create_production_batches",
  receiveInventory: "receive_inventory",
  recordWaste: "record_inventory_waste",
  completeStockOpname: "record_stock_opname",
  closeDay: "close_daily_reconciliation",
} as const;

export type RecipeVersionOption = { id: string; name: string; version: number };
export type CountItem = {
  id: string;
  name: string;
  unit: string;
  systemQuantity: number;
};
export type ReceiveItem = { id: string; name: string; unit: string };
export type PreparedBatch = { id: string; name: string; remainingMl: number };

export type OperatorAction =
  | {
      kind: "receive";
      locationId: string;
      itemId: string;
      quantity: number;
      reference: string;
      note: string;
    }
  | {
      kind: "production";
      locationId: string;
      recipeVersionId: string;
      producedAt: string;
      batchCount: number;
    }
  | {
      kind: "waste";
      locationId: string;
      itemId: string;
      quantity: number;
      unit: string;
      reason: string;
      note: string;
    }
  | {
      kind: "batch_waste";
      locationId: string;
      batchId: string;
      mlWasted: number;
      reason: string;
      note: string;
    }
  | {
      kind: "stock_opname";
      locationId: string;
      mode: "daily" | "full";
      counts: Array<{ itemId: string; physicalQuantity: number }>;
      note: string;
    }
  | {
      kind: "close_day";
      locationId: string;
      businessDate: string;
      openingCash: number;
      actualCash: number;
      actualQris: number;
      otherCashIn: number;
      cashRefund: number;
      note: string;
    };

export type OperatorActionResult = { ok: boolean; message?: string };

type Props = {
  locationId: string;
  recipeVersions: RecipeVersionOption[];
  countItems?: CountItem[];
  receiveItems?: ReceiveItem[];
  preparedBatches?: PreparedBatch[];
  /** POS totals supplied by the parent; Loyverse remains the source of truth. */
  expectedCashSales?: number;
  expectedQrisSales?: number;
  /**
   * Pass a server-side handler here for waste, opname and close-day. This
   * component never writes transactional tables from the browser directly.
   */
  onAction?: (action: OperatorAction) => Promise<OperatorActionResult>;
  onCommitted?: () => void | Promise<void>;
  visibleKinds?: Array<"receive" | "production" | "waste" | "count" | "close">;
};

type Feedback = {
  tone: "success" | "error" | "neutral";
  message: string;
} | null;

type ActionKind = "receive" | "production" | "waste" | "count" | "close";

const actionDetails: Record<ActionKind, { title: string; detail: string; summary: string }> = {
  receive: { title: "Terima stok", detail: "Catat bahan atau kemasan yang baru diterima.", summary: "Bahan atau kemasan baru" },
  production: { title: "Buat batch", detail: "Catat minuman yang dibuat dari resep aktif.", summary: "Produksi dari resep aktif" },
  waste: { title: "Catat terbuang", detail: "Catat bahan, kemasan, atau minuman yang dibuang.", summary: "Tumpah, rusak, kedaluwarsa" },
  count: { title: "Hitung fisik", detail: "Hitung bahan dan kemasan, lalu periksa selisihnya.", summary: "Cocokkan dengan stok fisik" },
  close: { title: "Tutup hari", detail: "Cocokkan uang tunai dan laporan QRIS hari ini.", summary: "Cocokkan tunai dan QRIS" },
};

function todayInJakarta() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nowInJakartaInput() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function jakartaInputToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+07:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function wholeUnit(unit: string) {
  return ["pcs", "pc", "buah", "unit", "lembar", "cup", "lid", "botol"].includes(unit.toLowerCase().trim());
}

function unitHelp(unit: string) {
  const normalized = unit.toLowerCase().trim();
  if (normalized === "ml") return "Gunakan ml. Contoh: 1 liter = 1.000 ml.";
  if (normalized === "g" || normalized === "gr") return "Gunakan gram. Contoh: 1 kg = 1.000 g.";
  return unit ? `Gunakan satuan ${unit} sesuai item yang dipilih.` : "Pilih item untuk melihat satuan yang digunakan.";
}

export function OperatorActions({
  locationId,
  recipeVersions,
  countItems = [],
  receiveItems = [],
  preparedBatches = [],
  expectedCashSales = 0,
  expectedQrisSales = 0,
  onAction,
  onCommitted,
  visibleKinds = ["receive", "production", "waste", "count", "close"],
}: Props) {
  const [active, setActive] = useState<ActionKind | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [wasteTarget, setWasteTarget] = useState<"inventory" | "batch">("inventory");
  const [countedValues, setCountedValues] = useState<Record<string, string>>({});
  const [countSnapshot, setCountSnapshot] = useState<CountItem[]>([]);
  const [selectedReceiveId, setSelectedReceiveId] = useState("");
  const [selectedWasteId, setSelectedWasteId] = useState("");
  const [selectedWasteBatchId, setSelectedWasteBatchId] = useState("");
  const [businessDate, setBusinessDate] = useState(todayInJakarta);
  const [reconciliationValues, setReconciliationValues] = useState({ opening: 0, cash: 0, qris: 0, other: 0, refund: 0 });
  const [reconciliationEntered, setReconciliationEntered] = useState({ cash: false, qris: false });
  const rupiah = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
  const expectedCash = expectedCashSales + reconciliationValues.opening + reconciliationValues.other - reconciliationValues.refund;
  const cashVariance = reconciliationValues.cash - expectedCash;
  const qrisVariance = reconciliationValues.qris - expectedQrisSales;

  const selectedReceiveItem = receiveItems.find((item) => item.id === selectedReceiveId);
  const selectedWasteItem = countItems.find((item) => item.id === selectedWasteId);
  const selectedWasteBatch = preparedBatches.find((batch) => batch.id === selectedWasteBatchId);
  const completedCounts = countSnapshot.filter((item) => {
    const value = countedValues[item.id];
    return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
  }).length;

  function openAction(kind: ActionKind) {
    if (pendingRef.current) return;
    setFeedback(null);
    setCountedValues({});
    setCountSnapshot(countItems.map((item) => ({ ...item })));
    setSelectedReceiveId("");
    setSelectedWasteId("");
    setSelectedWasteBatchId("");
    setWasteTarget("inventory");
    setBusinessDate(todayInJakarta());
    setReconciliationValues({ opening: 0, cash: 0, qris: 0, other: 0, refund: 0 });
    setReconciliationEntered({ cash: false, qris: false });
    setActive(kind);
  }

  function closeAction() {
    if (!pendingRef.current) setActive(null);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (active) {
      if (!dialog.open) dialog.showModal();
      const frame = window.requestAnimationFrame(() => {
        dialog.querySelector<HTMLElement>("#operator-action-title")?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (dialog.open) dialog.close();
  }, [active]);

  useEffect(() => {
    if (active && feedback?.tone === "error") {
      const alert = dialogRef.current?.querySelector<HTMLElement>('[role="alert"]');
      alert?.focus();
    }
  }, [active, feedback]);

  async function commit(action: OperatorAction) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFeedback(null);
    try {
      let serverMessage: string | undefined;
      if (onAction) {
        const result = await onAction(action);
        if (!result.ok)
          throw new Error(result.message || "Aksi belum dapat disimpan.");
      } else if (action.kind === "production") {
        const { error } = await createClient().rpc(
          OPERATOR_RPC.createProductionBatches,
          {
            p_location_id: action.locationId,
            p_recipe_version_id: action.recipeVersionId,
            p_produced_at: action.producedAt,
            p_batch_count: action.batchCount,
          },
        );
        if (error) throw error;
      } else if (action.kind === "receive") {
        const { error } = await createClient().rpc(
          OPERATOR_RPC.receiveInventory,
          {
            p_location_id: action.locationId,
            p_item_id: action.itemId,
            p_quantity: action.quantity,
            p_reference: action.reference || null,
            p_note: action.note || null,
          },
        );
        if (error) throw error;
      } else if (action.kind === "waste") {
        const { error } = await createClient().rpc(OPERATOR_RPC.recordWaste, {
          p_location_id: action.locationId,
          p_item_id: action.itemId,
          p_quantity: action.quantity,
          p_note: `${action.reason}${action.note ? ` · ${action.note}` : ""}`,
        });
        if (error) throw error;
      } else if (action.kind === "batch_waste") {
        const { error } = await createClient().rpc("record_batch_waste", {
          p_location_id: action.locationId,
          p_batch_id: action.batchId,
          p_ml_wasted: action.mlWasted,
          p_note: `${action.reason}${action.note ? ` · ${action.note}` : ""}`,
        });
        if (error) throw error;
      } else if (action.kind === "stock_opname") {
        const { error } = await createClient().rpc(
          OPERATOR_RPC.completeStockOpname,
          {
            p_location_id: action.locationId,
            p_mode: action.mode,
            p_lines: action.counts.map((count) => ({
              item_id: count.itemId,
              physical_quantity: count.physicalQuantity,
            })),
            p_note: action.note || null,
          },
        );
        if (error) throw error;
      } else {
        const { data, error } = await createClient().rpc(OPERATOR_RPC.closeDay, {
          p_location_id: action.locationId,
          p_business_date: action.businessDate,
          p_opening_cash: action.openingCash,
          p_actual_cash: action.actualCash,
          p_actual_qris: action.actualQris,
          p_other_cash_in: action.otherCashIn,
          p_cash_refund: action.cashRefund,
          p_note: action.note || null,
        });
        if (error) throw error;
        const result = data as { expected_cash?: number; expected_qris?: number; cash_variance?: number; qris_variance?: number } | null;
        if (result) {
          serverMessage = `Tutup hari tersimpan. Selisih tunai ${rupiah.format(Number(result.cash_variance ?? 0))}; QRIS ${rupiah.format(Number(result.qris_variance ?? 0))}.`;
        }
      }
      const messages = {
        receive: "Penerimaan stok berhasil dicatat.",
        production: "Produksi berhasil dicatat.",
        waste: "Stok terbuang berhasil dicatat.",
        batch_waste: "Minuman terbuang berhasil dicatat.",
        stock_opname: "Stok opname berhasil disimpan.",
        close_day: "Rekonsiliasi harian berhasil disimpan.",
      };
      const successMessage = serverMessage ?? messages[action.kind];
      setFeedback({ tone: "success", message: successMessage });
      setActive(null);
      try {
        await onCommitted?.();
      } catch {
        setFeedback({ tone: "neutral", message: `${successMessage} Ringkasan belum diperbarui. Muat ulang halaman untuk melihat stok terbaru.` });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error && "message" in error && typeof error.message === "string"
            ? error.message
            : "Terjadi kesalahan. Coba lagi.";
      setFeedback({
        tone: "error",
        message:
          message.includes("permission") || message.includes("function")
            ? "Aksi belum tersedia untuk akunmu. Hubungi admin Kawansela."
            : message,
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function receiveSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const quantity = Number(form.get("quantity"));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setFeedback({
        tone: "error",
        message: "Jumlah penerimaan harus lebih dari nol.",
      });
      return;
    }
    const itemId = String(form.get("itemId") || "");
    const item = receiveItems.find((entry) => entry.id === itemId);
    if (!item) {
      setFeedback({ tone: "error", message: "Pilih item yang benar." });
      return;
    }
    if (wholeUnit(item.unit) && !Number.isInteger(quantity)) {
      setFeedback({ tone: "error", message: `Jumlah ${item.unit} harus berupa angka bulat.` });
      return;
    }
    void commit({
      kind: "receive",
      locationId,
      itemId,
      quantity,
      reference: String(form.get("reference") || ""),
      note: String(form.get("note") || ""),
    });
  }

  function productionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const batchCount = Number(form.get("batchCount"));
    if (!Number.isInteger(batchCount) || batchCount < 1 || batchCount > 50) {
      setFeedback({ tone: "error", message: "Jumlah batch harus berupa angka antara 1 dan 50." });
      return;
    }
    const recipeVersionId = String(form.get("recipeVersionId") ?? "");
    const producedAt = jakartaInputToIso(String(form.get("producedAt") ?? ""));
    if (!recipeVersions.some((recipe) => recipe.id === recipeVersionId)) {
      setFeedback({ tone: "error", message: "Pilih resep aktif sebelum menyimpan produksi." });
      return;
    }
    if (!producedAt || new Date(producedAt).getTime() > Date.now() + 60_000) {
      setFeedback({ tone: "error", message: "Periksa waktu produksi. Waktu harus valid dan sudah terjadi (WIB)." });
      return;
    }
    void commit({ kind: "production", locationId, recipeVersionId, producedAt, batchCount });
  }
  function wasteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const quantity = Number(form.get("quantity"));
    const reason = String(form.get("reason"));
    const note = String(form.get("note") || "").trim();
    if (!["expired", "spill", "damaged", "remake", "other"].includes(reason)) {
      setFeedback({ tone: "error", message: "Pilih alasan stok dibuang." });
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setFeedback({ tone: "error", message: "Jumlah waste harus lebih dari nol." });
      return;
    }
    if (reason === "other" && !note) {
      setFeedback({ tone: "error", message: "Isi catatan untuk alasan Lainnya." });
      return;
    }
    if (wasteTarget === "batch") {
      const batch = preparedBatches.find((entry) => entry.id === form.get("batchId"));
      if (!batch) {
        setFeedback({ tone: "error", message: "Pilih batch yang benar." });
        return;
      }
      if (!Number.isInteger(quantity) || quantity > batch.remainingMl) {
        setFeedback({ tone: "error", message: `Masukkan jumlah ml antara 1 dan ${batch.remainingMl}.` });
        return;
      }
      void commit({
        kind: "batch_waste",
        locationId,
        batchId: batch.id,
        mlWasted: quantity,
        reason,
        note,
      });
      return;
    }
    const item = countItems.find((entry) => entry.id === form.get("itemId"));
    if (!item) {
      setFeedback({ tone: "error", message: "Pilih item yang benar." });
      return;
    }
    if (quantity > item.systemQuantity || (wholeUnit(item.unit) && !Number.isInteger(quantity))) {
      setFeedback({ tone: "error", message: `Jumlah terbuang tidak boleh melebihi ${item.systemQuantity} ${item.unit}${wholeUnit(item.unit) ? " dan harus berupa angka bulat" : ""}.` });
      return;
    }
    void commit({
      kind: "waste",
      locationId,
      itemId: item.id,
      quantity,
      unit: item.unit,
      reason,
      note,
    });
  }
  function countSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!countSnapshot.length || countSnapshot.some((item) => !String(form.get(`count:${item.id}`) ?? "").trim())) {
      setFeedback({ tone: "error", message: "Hitung dan isi setiap item. Masukkan 0 hanya jika item sudah dihitung dan habis." });
      return;
    }
    const counts = countSnapshot.map((item) => ({
      itemId: item.id,
      physicalQuantity: Number(form.get(`count:${item.id}`)),
    }));
    if (
      counts.some(
        (count) =>
          !Number.isFinite(count.physicalQuantity) ||
          count.physicalQuantity < 0 ||
          (wholeUnit(countSnapshot.find((item) => item.id === count.itemId)?.unit ?? "") && !Number.isInteger(count.physicalQuantity)),
      )
    ) {
      setFeedback({
        tone: "error",
        message: "Isi jumlah fisik dengan angka nol atau lebih.",
      });
      return;
    }
    void commit({
      kind: "stock_opname",
      locationId,
      mode: String(form.get("mode")) === "full" ? "full" : "daily",
      counts,
      note: String(form.get("note") || ""),
    });
  }
  function closeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (["openingCash", "actualCash", "actualQris", "otherCashIn", "cashRefund"].some((key) => !String(form.get(key) ?? "").trim())) {
      setFeedback({ tone: "error", message: "Isi semua kolom uang. Gunakan 0 hanya jika sudah diperiksa dan nilainya nol." });
      return;
    }
    const readMoney = (key: string) => Number(form.get(key));
    const values = [
      "openingCash",
      "actualCash",
      "actualQris",
      "otherCashIn",
      "cashRefund",
    ].map(readMoney);
    if (businessDate !== todayInJakarta() || String(form.get("businessDate")) !== businessDate) {
      setFeedback({ tone: "error", message: "Tanggal operasional sudah berganti. Tutup formulir dan muat ulang halaman sebelum tutup hari." });
      return;
    }
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      setFeedback({
        tone: "error",
        message: "Isi semua nilai uang dengan angka nol atau lebih.",
      });
      return;
    }
    const note = String(form.get("note") ?? "").trim();
    const cashDifference = values[1] - (expectedCashSales + values[0] + values[3] - values[4]);
    const qrisDifference = values[2] - expectedQrisSales;
    if ((cashDifference !== 0 || qrisDifference !== 0) && !note) {
      setFeedback({ tone: "error", message: "Jelaskan selisih tunai atau QRIS sebelum menyimpan tutup hari." });
      return;
    }
    void commit({
      kind: "close_day",
      locationId,
      businessDate: String(form.get("businessDate")),
      openingCash: values[0],
      actualCash: values[1],
      actualQris: values[2],
      otherCashIn: values[3],
      cashRefund: values[4],
      note,
    });
  }

  const submitLabels: Record<ActionKind, string> = {
    receive: "Simpan stok masuk", production: "Simpan produksi", waste: "Simpan stok terbuang",
    count: "Simpan hasil hitung", close: "Simpan tutup hari",
  };
  const cannotSubmit = pending ||
    (active === "receive" && receiveItems.length === 0) ||
    (active === "production" && recipeVersions.length === 0) ||
    (active === "waste" && (wasteTarget === "inventory" ? countItems.length === 0 : preparedBatches.length === 0)) ||
    (active === "count" && (!countSnapshot.length || completedCounts !== countSnapshot.length));

  return (
    <section className={styles.wrap} aria-label="Aksi operasional">
      {feedback && !active ? (
        <div className={`${styles.feedback} ${feedback.tone === "success" ? styles.success : feedback.tone === "error" ? styles.error : ""}`} role="status">
          {feedback.message}
        </div>
      ) : null}
      <div className={`${styles.grid} ${visibleKinds.length === 1 ? styles.singleAction : ""}`}>
        {visibleKinds.map((kind) => (
          <button className={styles.card} data-kind={kind} type="button" key={kind} onClick={() => openAction(kind)}>
            <strong>{actionDetails[kind].title}</strong>
            <span>{actionDetails[kind].summary}</span>
          </button>
        ))}
      </div>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby="operator-action-title"
        aria-describedby="operator-action-description"
        onCancel={(event) => { event.preventDefault(); closeAction(); }}
      >
        {active ? (
          <form
            key={active}
            className={styles.form}
            aria-busy={pending}
            onSubmit={active === "receive" ? receiveSubmit : active === "production" ? productionSubmit : active === "waste" ? wasteSubmit : active === "count" ? countSubmit : closeSubmit}
          >
            <div className={styles.formHeader}>
              <div>
                <span className={styles.eyebrow}>OPERASIONAL GEROBAK</span>
                <h3 id="operator-action-title" tabIndex={-1}>{actionDetails[active].title}</h3>
              </div>
              <button className={styles.close} type="button" disabled={pending} onClick={closeAction} aria-label="Batalkan dan tutup formulir">×</button>
            </div>
            <p id="operator-action-description" className={styles.help}>{actionDetails[active].detail}</p>
            {feedback ? (
              <div className={`${styles.feedback} ${feedback.tone === "error" ? styles.error : styles.success}`} role={feedback.tone === "error" ? "alert" : "status"} tabIndex={-1}>{feedback.message}</div>
            ) : null}
            <fieldset className={styles.fields} disabled={pending}>
              {active === "receive" ? (
                <>
                  <label>Item yang diterima
                    <select name="itemId" required value={selectedReceiveId} onChange={(event) => setSelectedReceiveId(event.target.value)}>
                      <option value="" disabled>Pilih bahan atau kemasan</option>
                      {receiveItems.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.unit}</option>)}
                    </select>
                  </label>
                  <label>Jumlah diterima {selectedReceiveItem ? `(${selectedReceiveItem.unit})` : ""}
                    <input key={selectedReceiveId} name="quantity" type="number" min={selectedReceiveItem && wholeUnit(selectedReceiveItem.unit) ? "1" : "0.001"} step={selectedReceiveItem && wholeUnit(selectedReceiveItem.unit) ? "1" : "0.001"} inputMode={selectedReceiveItem && wholeUnit(selectedReceiveItem.unit) ? "numeric" : "decimal"} aria-describedby="receive-unit-help" placeholder="Masukkan jumlah dari nota" required />
                  </label>
                  <p className={styles.help} id="receive-unit-help">{unitHelp(selectedReceiveItem?.unit ?? "")}</p>
                  <label>Nomor nota / surat jalan <span className={styles.optional}>(opsional)</span>
                    <input name="reference" maxLength={180} placeholder="Contoh: INV-1024" />
                  </label>
                  <label>Catatan <span className={styles.optional}>(opsional)</span><textarea name="note" rows={2} maxLength={1000} /></label>
                  {!receiveItems.length ? <p className={styles.help}>Belum ada item yang dapat diterima. Hubungi admin Kawansela.</p> : null}
                </>
              ) : null}

              {active === "production" ? (
                <>
                  <label>Resep yang dibuat
                    <select name="recipeVersionId" required defaultValue="">
                      <option value="" disabled>Pilih resep aktif</option>
                      {recipeVersions.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name} · V{recipe.version}</option>)}
                    </select>
                  </label>
                  <label>Waktu produksi (WIB)<input name="producedAt" type="datetime-local" defaultValue={nowInJakartaInput()} max={nowInJakartaInput()} required /></label>
                  <label>Jumlah batch<input name="batchCount" type="number" min="1" max="50" step="1" inputMode="numeric" defaultValue="1" aria-describedby="production-help" required /></label>
                  <p className={styles.help} id="production-help">1–50 batch per pencatatan. Ukuran batch mengikuti resep aktif. Sistem mengurangi bahan sesuai resep dan membuat batch terpisah.</p>
                  {!recipeVersions.length ? <p className={styles.help}>Belum ada resep aktif. Hubungi admin Kawansela sebelum produksi.</p> : null}
                </>
              ) : null}

              {active === "waste" ? (
                <>
                  <div className={styles.wasteChoice} role="group" aria-label="Jenis stok yang dibuang">
                    <button className={wasteTarget === "inventory" ? styles.choiceActive : styles.choice} type="button" aria-pressed={wasteTarget === "inventory"} onClick={() => setWasteTarget("inventory")}>Bahan / kemasan</button>
                    <button className={wasteTarget === "batch" ? styles.choiceActive : styles.choice} type="button" aria-pressed={wasteTarget === "batch"} onClick={() => setWasteTarget("batch")}>Minuman siap jual</button>
                  </div>
                  {wasteTarget === "inventory" ? (
                    <label>Item yang dibuang
                      <select name="itemId" required value={selectedWasteId} onChange={(event) => setSelectedWasteId(event.target.value)}>
                        <option value="" disabled>Pilih bahan atau kemasan</option>
                        {countItems.map((item) => <option key={item.id} value={item.id}>{item.name} · tersedia {item.systemQuantity} {item.unit}</option>)}
                      </select>
                    </label>
                  ) : (
                    <label>Batch yang dibuang
                      <select name="batchId" required value={selectedWasteBatchId} onChange={(event) => setSelectedWasteBatchId(event.target.value)}>
                        <option value="" disabled>Pilih batch minuman</option>
                        {preparedBatches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name} · {batch.remainingMl} ml · #{batch.id.slice(0, 6)}</option>)}
                      </select>
                    </label>
                  )}
                  <label>Jumlah dibuang {wasteTarget === "batch" ? "(ml)" : selectedWasteItem ? `(${selectedWasteItem.unit})` : ""}
                    <input key={`${wasteTarget}:${selectedWasteId}:${selectedWasteBatchId}`} name="quantity" type="number" min={wasteTarget === "batch" || (selectedWasteItem && wholeUnit(selectedWasteItem.unit)) ? "1" : "0.001"} step={wasteTarget === "batch" || (selectedWasteItem && wholeUnit(selectedWasteItem.unit)) ? "1" : "0.001"} max={wasteTarget === "batch" ? selectedWasteBatch?.remainingMl : selectedWasteItem?.systemQuantity} inputMode={wasteTarget === "batch" || (selectedWasteItem && wholeUnit(selectedWasteItem.unit)) ? "numeric" : "decimal"} placeholder="Masukkan jumlah yang dibuang" required />
                  </label>
                  <p className={styles.help}>Masukkan jumlah yang dibuang, bukan sisa stok. {wasteTarget === "batch" ? "Gunakan ml dan pilih batch yang benar." : unitHelp(selectedWasteItem?.unit ?? "")}</p>
                  <label>Alasan
                    <select name="reason" defaultValue="" required>
                      <option value="" disabled>Pilih alasan</option><option value="expired">Kedaluwarsa</option><option value="spill">Tumpah</option><option value="damaged">Rusak</option><option value="remake">Salah buat</option><option value="other">Lainnya</option>
                    </select>
                  </label>
                  <label>Catatan <span className={styles.optional}>(wajib jika memilih Lainnya)</span><textarea name="note" rows={2} maxLength={1000} /></label>
                </>
              ) : null}

              {active === "count" ? (
                <>
                  <label>Jenis pemeriksaan
                    <select name="mode" defaultValue="daily"><option value="daily">Pemeriksaan harian</option><option value="full">Pemeriksaan lengkap</option></select>
                  </label>
                  <p className={styles.help}>Hitung semua bahan dan kemasan pada daftar ini. Isi 0 jika sudah dihitung dan habis. Kedua jenis pemeriksaan mencatat seluruh item di bawah.</p>
                  <div className={styles.countProgress} role="status">{completedCounts} dari {countSnapshot.length} item sudah diisi</div>
                  <div className={styles.countList}>
                    {countSnapshot.map((item) => {
                      const value = countedValues[item.id] ?? "";
                      const valid = value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
                      return <label key={item.id} className={styles.countRow}>
                        <span><strong>{item.name}</strong><small>Stok sistem: {item.systemQuantity} {item.unit}</small><small>{valid ? `Selisih: ${Number(value) - item.systemQuantity} ${item.unit}` : "Belum dihitung"}</small></span>
                        <span className={styles.countInput}><input name={`count:${item.id}`} aria-label={`Jumlah fisik ${item.name} dalam ${item.unit}`} type="number" min="0" step={wholeUnit(item.unit) ? "1" : "0.001"} inputMode={wholeUnit(item.unit) ? "numeric" : "decimal"} value={value} onChange={(event) => setCountedValues((values) => ({ ...values, [item.id]: event.target.value }))} placeholder="Isi hasil" required /><span>{item.unit}</span></span>
                      </label>;
                    })}
                    {!countSnapshot.length ? <p className={styles.help}>Belum ada stok yang dapat dihitung untuk gerobak ini.</p> : null}
                  </div>
                  <p className={styles.help}>Selisih di layar memakai stok saat formulir dibuka. Sistem memeriksa stok terbaru saat menyimpan.</p>
                  <label>Catatan pemeriksaan <span className={styles.optional}>(opsional)</span><textarea name="note" rows={2} maxLength={1000} /></label>
                </>
              ) : null}

              {active === "close" ? (
                <>
                  <label>Tanggal operasional (WIB)<input name="businessDate" type="date" value={businessDate} readOnly aria-describedby="close-date-help" required /></label>
                  <p className={styles.help} id="close-date-help">Formulir ini khusus hari ini agar sesuai dengan angka penjualan yang ditampilkan. Hubungi admin untuk meninjau hari sebelumnya.</p>
                  <div className={styles.moneyGrid}>
                    <label>Modal tunai awal (Rp)<input name="openingCash" type="number" min="0" step="1" inputMode="numeric" defaultValue="0" onChange={(event) => setReconciliationValues((value) => ({ ...value, opening: Number(event.target.value) || 0 }))} required /></label>
                    <label>Seluruh uang fisik (Rp)<input name="actualCash" type="number" min="0" step="1" inputMode="numeric" placeholder="Hasil hitung uang, termasuk modal" onChange={(event) => { setReconciliationValues((value) => ({ ...value, cash: Number(event.target.value) || 0 })); setReconciliationEntered((value) => ({ ...value, cash: event.target.value !== "" })); }} required /></label>
                    <label>QRIS menurut penyedia (Rp)<input name="actualQris" type="number" min="0" step="1" inputMode="numeric" placeholder="Dari laporan QRIS hari ini" onChange={(event) => { setReconciliationValues((value) => ({ ...value, qris: Number(event.target.value) || 0 })); setReconciliationEntered((value) => ({ ...value, qris: event.target.value !== "" })); }} required /></label>
                    <label>Tunai masuk di luar penjualan (Rp)<input name="otherCashIn" type="number" min="0" step="1" inputMode="numeric" defaultValue="0" onChange={(event) => setReconciliationValues((value) => ({ ...value, other: Number(event.target.value) || 0 }))} required /></label>
                    <label>Refund tunai di luar POS (Rp)<input name="cashRefund" type="number" min="0" step="1" inputMode="numeric" defaultValue="0" onChange={(event) => setReconciliationValues((value) => ({ ...value, refund: Number(event.target.value) || 0 }))} aria-describedby="refund-help" required /></label>
                  </div>
                  <p id="refund-help" className={styles.help}>Refund: isi 0 jika pengembalian dana sudah dicatat di Loyverse. Untuk QRIS, gunakan total sebelum biaya penyedia. Formulir ini belum mencatat pengeluaran usaha.</p>
                  <div className={styles.reconciliationPreview} aria-live="polite">
                    <strong>Periksa sebelum menyimpan</strong>
                    <span>Tunai seharusnya: {rupiah.format(expectedCash)}</span>
                    <span>Tunai dihitung: {reconciliationEntered.cash ? rupiah.format(reconciliationValues.cash) : "Belum diisi"} · selisih {reconciliationEntered.cash ? rupiah.format(cashVariance) : "—"}</span>
                    <span>QRIS dari POS: {rupiah.format(expectedQrisSales)}</span>
                    <span>QRIS menurut penyedia: {reconciliationEntered.qris ? rupiah.format(reconciliationValues.qris) : "Belum diisi"} · selisih {reconciliationEntered.qris ? rupiah.format(qrisVariance) : "—"}</span>
                    <small>Sistem menghitung ulang dari transaksi terbaru saat menyimpan.</small>
                  </div>
                  <label>Catatan / penjelasan selisih<textarea name="note" rows={3} maxLength={1000} required={(reconciliationEntered.cash && cashVariance !== 0) || (reconciliationEntered.qris && qrisVariance !== 0)} placeholder="Jelaskan jika uang tunai atau QRIS berbeda dari angka sistem" /></label>
                </>
              ) : null}
            </fieldset>
            <div className={styles.formFooter}>
              <button className={styles.secondary} type="button" disabled={pending} onClick={closeAction}>Batal</button>
              <button className={styles.primary} type="submit" disabled={cannotSubmit}>{pending ? "Menyimpan…" : submitLabels[active]}</button>
            </div>
            {pending ? <p className={styles.help} role="status">Tunggu sampai penyimpanan selesai sebelum menutup formulir.</p> : null}
          </form>
        ) : null}
      </dialog>
    </section>
  );
}

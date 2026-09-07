"use client";

import { FormEvent, ReactNode, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./operator-actions.module.css";

/**
 * Keep every database contract in one place. Only createProduction exists in the
 * current schema. The other names intentionally remain explicit until their
 * server-side, transaction-safe RPCs are added.
 */
export const OPERATOR_RPC = {
  createProduction: "create_production_batch",
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

function todayInJakarta() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(),
  );
}

function nowInJakartaInput() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function jakartaInputToIso(value: string) {
  return new Date(`${value}:00+07:00`).toISOString();
}

function ActionCard({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.card}>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
      {children}
    </section>
  );
}

export function OperatorActions({
  locationId,
  recipeVersions,
  countItems = [],
  receiveItems = [],
  preparedBatches = [],
  onAction,
  onCommitted,
  visibleKinds = ["receive", "production", "waste", "count", "close"],
}: Props) {
  const [active, setActive] = useState<
    "receive" | "production" | "waste" | "count" | "close" | null
  >(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [wasteTarget, setWasteTarget] = useState<"inventory" | "batch">("inventory");

  async function commit(action: OperatorAction) {
    setPending(true);
    setFeedback(null);
    try {
      if (onAction) {
        const result = await onAction(action);
        if (!result.ok)
          throw new Error(result.message || "Aksi belum dapat disimpan.");
      } else if (action.kind === "production") {
        const { error } = await createClient().rpc(
          OPERATOR_RPC.createProduction,
          {
            p_location_id: action.locationId,
            p_recipe_version_id: action.recipeVersionId,
            p_produced_at: action.producedAt,
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
        const { error } = await createClient().rpc(OPERATOR_RPC.closeDay, {
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
      }
      const messages = {
        receive: "Penerimaan stok berhasil dicatat.",
        production: "Batch 900 ml berhasil dicatat.",
        waste: "Waste berhasil dicatat.",
        batch_waste: "Waste batch berhasil dicatat.",
        stock_opname: "Stok opname berhasil disimpan.",
        close_day: "Rekonsiliasi harian berhasil disimpan.",
      };
      setFeedback({ tone: "success", message: messages[action.kind] });
      setActive(null);
      await onCommitted?.();
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
            ? "Aksi belum diaktifkan di server. Tidak ada data yang diubah."
            : message,
      });
    } finally {
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
    if (!receiveItems.some((item) => item.id === itemId)) {
      setFeedback({ tone: "error", message: "Pilih item yang benar." });
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
    void commit({
      kind: "production",
      locationId,
      recipeVersionId: String(form.get("recipeVersionId")),
      producedAt: jakartaInputToIso(String(form.get("producedAt"))),
    });
  }
  function wasteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const quantity = Number(form.get("quantity"));
    const reason = String(form.get("reason"));
    const note = String(form.get("note") || "").trim();
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
    const counts = countItems.map((item) => ({
      itemId: item.id,
      physicalQuantity: Number(form.get(`count:${item.id}`)),
    }));
    if (
      counts.some(
        (count) =>
          !Number.isFinite(count.physicalQuantity) ||
          count.physicalQuantity < 0,
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
    const readMoney = (key: string) => Number(form.get(key) || 0);
    const values = [
      "openingCash",
      "actualCash",
      "actualQris",
      "otherCashIn",
      "cashRefund",
    ].map(readMoney);
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      setFeedback({
        tone: "error",
        message: "Isi semua nilai uang dengan angka nol atau lebih.",
      });
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
      note: String(form.get("note") || ""),
    });
  }

  return (
    <section className={styles.wrap} aria-label="Aksi operasional">
      <div className={styles.heading}>
        <div>
          <div className={styles.eyebrow}>AKSI OPERASIONAL</div>
          <h2>Catat aktivitas operasional.</h2>
          <p>
            Penjualan tetap dicatat di Loyverse. Di sini, konfirmasi produksi,
            waste, stok, dan penutupan hari.
          </p>
        </div>
      </div>
      {feedback && (
        <div
          className={`${styles.feedback} ${feedback.tone === "success" ? styles.success : feedback.tone === "error" ? styles.error : ""}`}
          role="status"
        >
          {feedback.message}
        </div>
      )}
      <div className={styles.grid}>
        {visibleKinds.includes("receive") ? (
          <ActionCard
            title="Terima stok"
            detail="Catat bahan baku atau kemasan yang diterima."
          >
            <button
              className={styles.primary}
              type="button"
              onClick={() => setActive("receive")}
            >
              + Terima stok
            </button>
          </ActionCard>
        ) : null}
        {visibleKinds.includes("production") ? (
          <ActionCard
            title="Produksi"
            detail="Buat satu batch standar 900 ml dari resep aktif."
          >
            <button
              className={styles.primary}
              type="button"
              onClick={() => setActive("production")}
            >
              + Catat batch
            </button>
          </ActionCard>
        ) : null}
        {visibleKinds.includes("waste") ? (
          <ActionCard
            title="Waste"
            detail="Catat bahan, kemasan, atau batch siap jual yang tidak dapat digunakan."
          >
            <button
              className={styles.secondary}
              type="button"
              onClick={() => setActive("waste")}
            >
              Catat waste
            </button>
          </ActionCard>
        ) : null}
        {visibleKinds.includes("count") ? (
          <ActionCard
            title="Stock opname"
            detail="Masukkan stok fisik. Sistem menghitung selisih."
          >
            <button
              className={styles.secondary}
              type="button"
              onClick={() => setActive("count")}
            >
              Mulai opname
            </button>
          </ActionCard>
        ) : null}
        {visibleKinds.includes("close") ? (
          <ActionCard
            title="Tutup hari"
            detail="Konfirmasi kas dan QRIS setelah penjualan diperiksa."
          >
            <button
              className={styles.secondary}
              type="button"
              onClick={() => setActive("close")}
            >
              Mulai tutup hari
            </button>
          </ActionCard>
        ) : null}
      </div>

      {active === "receive" && (
        <form className={styles.form} onSubmit={receiveSubmit}>
          <div className={styles.formHeader}>
            <h3>Terima stok</h3>
            <button
              className={styles.close}
              type="button"
              onClick={() => setActive(null)}
              aria-label="Tutup"
            >
              ×
            </button>
          </div>
          <label>
            Item
            <select name="itemId" required defaultValue="">
              <option value="" disabled>
                Pilih item
              </option>
              {receiveItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.unit}
                </option>
              ))}
            </select>
          </label>
          <label>
            Jumlah
            <input
              name="quantity"
              type="number"
              min="0.001"
              step="0.001"
              required
            />
          </label>
          <label>
            Nomor referensi
            <input name="reference" placeholder="Nota / surat jalan" />
          </label>
          <label>
            Catatan
            <textarea name="note" rows={2} />
          </label>
          <button
            className={styles.primary}
            disabled={pending || receiveItems.length === 0}
          >
            {pending ? "Menyimpan…" : "Simpan penerimaan"}
          </button>
        </form>
      )}

      {active === "production" && (
        <form className={styles.form} onSubmit={productionSubmit}>
          <div className={styles.formHeader}>
            <h3>Produksi 900 ml</h3>
            <button
              className={styles.close}
              type="button"
              onClick={() => setActive(null)}
              aria-label="Tutup"
            >
              ×
            </button>
          </div>
          <label>
            Resep aktif
            <select name="recipeVersionId" required defaultValue="">
              {" "}
              <option value="" disabled>
                Pilih resep
              </option>
              {recipeVersions.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.name} · V{recipe.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Waktu produksi
            <input
              name="producedAt"
              type="datetime-local"
              defaultValue={nowInJakartaInput()}
              required
            />
          </label>
          <p className={styles.help}>
            Simpan hanya setelah bahan benar-benar digunakan. Sistem akan
            membuat satu batch 900 ml dan mengurangi bahan sesuai resep.
          </p>
          <button
            className={styles.primary}
            disabled={pending || recipeVersions.length === 0}
          >
            {pending ? "Menyimpan…" : "Simpan produksi"}
          </button>
        </form>
      )}

      {active === "waste" && (
        <form className={styles.form} onSubmit={wasteSubmit}>
          <div className={styles.formHeader}>
            <h3>Catat waste</h3>
            <button
              className={styles.close}
              type="button"
              onClick={() => setActive(null)}
              aria-label="Tutup"
            >
              ×
            </button>
          </div>
          <div className={styles.wasteChoice} role="group" aria-label="Jenis waste">
            <button
              className={wasteTarget === "inventory" ? styles.choiceActive : styles.choice}
              type="button"
              onClick={() => setWasteTarget("inventory")}
            >
              Bahan / kemasan
            </button>
            <button
              className={wasteTarget === "batch" ? styles.choiceActive : styles.choice}
              type="button"
              onClick={() => setWasteTarget("batch")}
            >
              Batch siap jual
            </button>
          </div>
          {wasteTarget === "inventory" ? (
            <label>
              Item
              <select name="itemId" required defaultValue="">
                <option value="" disabled>Pilih item</option>
                {countItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.unit}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Batch siap jual
              <select name="batchId" required defaultValue="">
                <option value="" disabled>Pilih batch</option>
                {preparedBatches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.name} · {batch.remainingMl} ml tersedia
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Jumlah {wasteTarget === "batch" ? "(ml)" : ""}
            <input
              name="quantity"
              type="number"
              min="0.001"
              step="0.001"
              required
            />
          </label>
          <label>
            Alasan
            <select name="reason" defaultValue="expired">
              <option value="expired">Kedaluwarsa</option>
              <option value="spill">Tumpah</option>
              <option value="damaged">Rusak</option>
              <option value="remake">Salah buat / remake</option>
              <option value="other">Lainnya</option>
            </select>
          </label>
          <label>
            Catatan (wajib untuk Lainnya)
            <textarea name="note" rows={2} />
          </label>
          <button
            className={styles.primary}
            disabled={pending || (wasteTarget === "inventory" ? countItems.length === 0 : preparedBatches.length === 0)}
          >
            {pending ? "Menyimpan…" : "Simpan waste"}
          </button>
        </form>
      )}

      {active === "count" && (
        <form className={styles.form} onSubmit={countSubmit}>
          <div className={styles.formHeader}>
            <h3>Stock opname</h3>
            <button
              className={styles.close}
              type="button"
              onClick={() => setActive(null)}
              aria-label="Tutup"
            >
              ×
            </button>
          </div>
          <label>
            Jenis opname
            <select name="mode" defaultValue="daily">
              <option value="daily">Harian - item penting</option>
              <option value="full">Penuh - semua item</option>
            </select>
          </label>
          <div className={styles.countList}>
            {countItems.length ? (
              countItems.map((item) => (
                <label key={item.id} className={styles.countRow}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      Sistem: {item.systemQuantity} {item.unit}
                    </small>
                  </span>
                  <input
                    name={`count:${item.id}`}
                    type="number"
                    min="0"
                    step="0.001"
                    defaultValue={item.systemQuantity}
                    required
                  />
                </label>
              ))
            ) : (
              <p className={styles.help}>Item stok belum tersedia.</p>
            )}
          </div>
          <label>
            Catatan
            <textarea name="note" rows={2} />
          </label>
          <button
            className={styles.primary}
            disabled={pending || countItems.length === 0}
          >
            {pending ? "Menyimpan…" : "Simpan opname"}
          </button>
        </form>
      )}

      {active === "close" && (
        <form className={styles.form} onSubmit={closeSubmit}>
          <div className={styles.formHeader}>
            <h3>Tutup hari</h3>
            <button
              className={styles.close}
              type="button"
              onClick={() => setActive(null)}
              aria-label="Tutup"
            >
              ×
            </button>
          </div>
          <label>
            Tanggal operasional
            <input
              name="businessDate"
              type="date"
              defaultValue={todayInJakarta()}
              required
            />
          </label>
          <div className={styles.moneyGrid}>
            <label>
              Kas awal
              <input
                name="openingCash"
                type="number"
                min="0"
                step="1"
                defaultValue="0"
                required
              />
            </label>
            <label>
              Kas fisik
              <input
                name="actualCash"
                type="number"
                min="0"
                step="1"
                required
              />
            </label>
            <label>
              QRIS aktual
              <input
                name="actualQris"
                type="number"
                min="0"
                step="1"
                required
              />
            </label>
            <label>
              Kas masuk lain
              <input
                name="otherCashIn"
                type="number"
                min="0"
                step="1"
                defaultValue="0"
                required
              />
            </label>
            <label>
              Refund tunai
              <input
                name="cashRefund"
                type="number"
                min="0"
                step="1"
                defaultValue="0"
                required
              />
            </label>
          </div>
          <label>
            Catatan / alasan selisih
            <textarea name="note" rows={2} />
          </label>
          <button className={styles.primary} disabled={pending}>
            {pending ? "Menyimpan…" : "Simpan rekonsiliasi"}
          </button>
        </form>
      )}
    </section>
  );
}

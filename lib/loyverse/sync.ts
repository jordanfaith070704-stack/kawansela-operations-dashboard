import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type {
  LoyversePayment,
  LoyverseReceipt,
  LoyverseReceiptLine,
  SyncResult,
} from "./types";

type PaymentMethod = "cash" | "qris_static" | "qris_provider" | "other";
type Connection = {
  id: string;
  location_id: string;
  external_store_id: string | null;
  provider: string;
  is_active: boolean;
};
type ReceiptEvent = {
  id: string;
  processed_at: string | null;
  processing_error: string | null;
};

function receiptExternalId(receipt: LoyverseReceipt) {
  return receipt.id ?? receipt.receipt_number ?? "";
}

function receiptOccurredAt(receipt: LoyverseReceipt) {
  return receipt.closed_at ?? receipt.receipt_date ?? receipt.created_at ?? "";
}

function receiptKind(receipt: LoyverseReceipt): "sale" | "refund" | "void" {
  if (receipt.receipt_type === "REFUND" || receipt.status === "REFUNDED")
    return "refund";
  if (receipt.status === "CANCELLED" || receipt.cancelled_at) return "void";
  return "sale";
}

function lineExternalId(
  connectionId: string,
  receipt: LoyverseReceipt,
  line: LoyverseReceiptLine,
  index: number,
) {
  // A receipt may contain the same item more than once. Product id alone would
  // collapse those lines and skip/double inventory consumption on retry.
  const stableLineId =
    line.id ?? line.line_item_id ?? `${index + 1}:${line.item_id}`;
  return `${connectionId}:receipt:${receiptExternalId(receipt)}:line:${stableLineId}`;
}

function paymentMethod(payments: LoyversePayment[] | undefined): {
  method: PaymentMethod;
  warning?: string;
} {
  if (!payments?.length)
    return {
      method: "other",
      warning: "Tidak ada jenis pembayaran dari Loyverse.",
    };
  if (payments.length > 1)
    return {
      method: "other",
      warning: "Pembayaran gabungan perlu direkonsiliasi secara manual.",
    };
  const label =
    `${payments[0].payment_type_id ?? ""} ${payments[0].name ?? ""}`.toLowerCase();
  if (/qris/.test(label))
    return {
      method: /static|manual/.test(label) ? "qris_static" : "qris_provider",
    };
  if (/cash|tunai/.test(label)) return { method: "cash" };
  return {
    method: "other",
    warning: `Jenis pembayaran Loyverse belum dipetakan: ${payments[0].name ?? payments[0].payment_type_id ?? "tidak diketahui"}.`,
  };
}

async function getOrCreateEvent(
  connectionId: string,
  receipt: LoyverseReceipt,
  kind: "sale" | "refund" | "void",
): Promise<{ event: ReceiptEvent; existed: boolean }> {
  const db = createAdminClient();
  const externalReceiptId = receiptExternalId(receipt);
  const existing = await db
    .from("pos_receipt_events")
    .select("id, processed_at, processing_error")
    .eq("pos_connection_id", connectionId)
    .eq("external_receipt_id", externalReceiptId)
    .eq("event_kind", kind)
    .maybeSingle();
  if (existing.error)
    throw new Error(
      `Tidak dapat membaca event receipt: ${existing.error.message}`,
    );
  if (existing.data) return { event: existing.data, existed: true };

  const created = await db
    .from("pos_receipt_events")
    .insert({
      pos_connection_id: connectionId,
      external_receipt_id: externalReceiptId,
      event_kind: kind,
      payload: receipt,
    })
    .select("id, processed_at, processing_error")
    .single();
  if (!created.error) return { event: created.data, existed: false };

  // A concurrent retry may have won the unique constraint. Re-read instead of
  // treating it as an opaque duplicate or creating a second inventory event.
  const raced = await db
    .from("pos_receipt_events")
    .select("id, processed_at, processing_error")
    .eq("pos_connection_id", connectionId)
    .eq("external_receipt_id", externalReceiptId)
    .eq("event_kind", kind)
    .maybeSingle();
  if (raced.data) return { event: raced.data, existed: true };
  throw new Error(
    `Tidak dapat menyimpan event receipt: ${created.error.message}`,
  );
}

async function setEventError(eventId: string, messages: string[]) {
  const { error } = await createAdminClient()
    .from("pos_receipt_events")
    .update({ processing_error: messages.join(" ").slice(0, 2000) })
    .eq("id", eventId);
  if (error)
    throw new Error(`Tidak dapat menyimpan status receipt: ${error.message}`);
}

/**
 * Imports already-retrieved receipts for one active POS connection. Provider API
 * polling belongs in a separate server-side job; this function never accepts or
 * exposes a provider token.
 */
export async function processLoyverseReceipts(
  connectionId: string,
  receipts: LoyverseReceipt[],
): Promise<SyncResult> {
  const db = createAdminClient();
  const result: SyncResult = {
    processed: 0,
    duplicated: 0,
    pending: 0,
    warnings: [],
  };
  const attemptAt = new Date().toISOString();
  const connectionResult = await db
    .from("pos_connections")
    .select("id, location_id, external_store_id, provider, is_active")
    .eq("id", connectionId)
    .eq("provider", "loyverse")
    .eq("is_active", true)
    .maybeSingle<Connection>();
  const connection = connectionResult.data;
  if (connectionResult.error || !connection)
    throw new Error("Koneksi Loyverse tidak aktif atau tidak ditemukan.");

  const startedRun = await db
    .from("pos_sync_runs")
    .insert({
      pos_connection_id: connectionId,
      status: "started",
      started_at: attemptAt,
    })
    .select("id")
    .single();
  if (startedRun.error)
    throw new Error(
      `Tidak dapat memulai catatan sinkronisasi: ${startedRun.error.message}`,
    );
  result.syncRunId = startedRun.data.id;

  try {
    for (const receipt of receipts) {
      const kind = receiptKind(receipt);
      const externalReceiptId = receiptExternalId(receipt);
      const occurredAt = receiptOccurredAt(receipt);
      const prefix = `Receipt ${externalReceiptId || "tanpa nomor"}`;
      if (
        !externalReceiptId ||
        !receipt.store_id ||
        !occurredAt ||
        !Array.isArray(receipt.line_items)
      ) {
        result.pending++;
        result.warnings.push(`${prefix}: data receipt tidak lengkap.`);
        continue;
      }
      if (connection.external_store_id !== receipt.store_id) {
        result.pending++;
        result.warnings.push(`${prefix}: store tidak cocok dengan cart ini.`);
        continue;
      }

      const { event, existed } = await getOrCreateEvent(
        connectionId,
        receipt,
        kind,
      );
      if (event.processed_at) {
        result.duplicated++;
        continue;
      }

      if (kind !== "sale") {
        const message = `${prefix}: ${kind === "refund" ? "refund" : "void"} menunggu klasifikasi hasil fisik oleh operator.`;
        await setEventError(event.id, [message]);
        result.pending++;
        result.warnings.push(message);
        continue;
      }

      const mappedPayment = paymentMethod(receipt.payments);
      const receiptWarnings = mappedPayment.warning
        ? [`${prefix}: ${mappedPayment.warning}`]
        : [];
      const failures: string[] = [];
      let firstSaleId: string | null = null;

      for (const [index, line] of receipt.line_items.entries()) {
        if (
          !line.item_id ||
          !Number.isFinite(line.quantity) ||
          line.quantity <= 0
        ) {
          failures.push(
            `Baris ${index + 1} tidak memiliki item atau kuantitas yang valid.`,
          );
          continue;
        }
        const mapping = await db
          .from("pos_product_mappings")
          .select("recipe_id")
          .eq("pos_connection_id", connectionId)
          .eq("external_item_id", line.item_id)
          .eq("is_active", true)
          .maybeSingle();
        if (mapping.error || !mapping.data) {
          failures.push(`Produk ${line.item_id} belum dipetakan.`);
          continue;
        }

        const sale = await db.rpc("record_pos_sale", {
          p_pos_connection_id: connectionId,
          p_recipe_id: mapping.data.recipe_id,
          p_quantity: line.quantity,
          p_total: line.total_money ?? 0,
          p_payment: mappedPayment.method,
          p_occurred_at: occurredAt,
          p_external_id: lineExternalId(connectionId, receipt, line, index),
        });
        if (sale.error) {
          failures.push(`Produk ${line.item_id}: ${sale.error.message}`);
          continue;
        }
        firstSaleId ??= sale.data;
      }

      if (failures.length) {
        const messages = [...receiptWarnings, ...failures].map(
          (message) => `${prefix}: ${message}`,
        );
        await setEventError(event.id, messages);
        result.pending++;
        result.warnings.push(...messages);
        // Do not set processed_at. Retry is safe: record_sale uses a stable
        // receipt-line reference as its idempotency key.
        continue;
      }

      const finished = await db
        .from("pos_receipt_events")
        .update({
          processed_at: new Date().toISOString(),
          processing_error: receiptWarnings.join(" ") || null,
          kawansela_sale_id: firstSaleId,
        })
        .eq("id", event.id);
      if (finished.error)
        throw new Error(
          `${prefix}: transaksi disimpan tetapi event tidak dapat ditandai selesai.`,
        );
      result.processed++;
      if (existed)
        result.warnings.push(`${prefix}: percobaan ulang berhasil diproses.`);
      result.warnings.push(...receiptWarnings);
    }

    const status =
      result.pending || result.warnings.length ? "warning" : "succeeded";
    const completedAt = new Date().toISOString();
    await db
      .from("pos_sync_runs")
      .update({
        status,
        completed_at: completedAt,
        imported_count: result.processed,
        duplicate_count: result.duplicated,
        error_summary: result.warnings.join(" ").slice(0, 2000) || null,
      })
      .eq("id", result.syncRunId);
    // Never advance the polling watermark past a receipt that still needs work.
    // Retrying an already processed range is safe because every receipt line has
    // its own stable idempotency reference.
    const lastProcessedReceiptAt =
      result.pending || receipts.some((receipt) => !receipt.created_at)
      ? undefined
      : receipts
          .filter(
            (receipt) =>
              receipt.created_at &&
              !Number.isNaN(Date.parse(receipt.created_at)),
          )
          .map((receipt) => receipt.created_at as string)
          .sort()
          .at(-1);
    await db
      .from("pos_connections")
      .update({
        status: status === "succeeded" ? "healthy" : "warning",
        last_attempt_at: attemptAt,
        ...(status === "succeeded"
          ? { last_successful_sync_at: completedAt }
          : {}),
        ...(lastProcessedReceiptAt
          ? { last_processed_receipt_at: lastProcessedReceiptAt }
          : {}),
        last_error: result.warnings.join(" ").slice(0, 2000) || null,
        updated_at: completedAt,
      })
      .eq("id", connectionId);
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Sinkronisasi Loyverse gagal.";
    const completedAt = new Date().toISOString();
    await db
      .from("pos_sync_runs")
      .update({
        status: "failed",
        completed_at: completedAt,
        imported_count: result.processed,
        duplicate_count: result.duplicated,
        error_summary: message,
      })
      .eq("id", result.syncRunId);
    await db
      .from("pos_connections")
      .update({
        status: "error",
        last_attempt_at: attemptAt,
        last_error: message,
        updated_at: completedAt,
      })
      .eq("id", connectionId);
    throw error;
  }
}

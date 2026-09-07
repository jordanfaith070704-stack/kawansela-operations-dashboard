import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveProviderToken } from "@/lib/loyverse/credential-store";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";
import type { LoyverseReceipt } from "@/lib/loyverse/types";

function authorized(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const value = request.headers.get("authorization");
  if (!expected || !value) return false;
  const supplied = value.replace(/^Bearer\s+/i, "");
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function fetchReceipts(
  token: string,
  storeId: string,
  since: string | null,
) {
  const from =
    since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const receipts: LoyverseReceipt[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page += 1) {
    const url = new URL("https://api.loyverse.com/v1.0/receipts");
    url.searchParams.set("store_ids", storeId);
    url.searchParams.set("created_at_min", from);
    url.searchParams.set("limit", "250");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Loyverse HTTP ${response.status}`);
    const body = await response.json();
    if (Array.isArray(body.receipts))
      receipts.push(...(body.receipts as LoyverseReceipt[]));
    cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    if (!cursor) return receipts;
  }
  throw new Error("Sinkronisasi Loyverse melebihi batas aman 10.000 receipt.");
}

async function runScheduledSync(request: NextRequest) {
  if (!authorized(request))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = createAdminClient();
  const { data: connections, error } = await db
    .from("pos_connections")
    .select("id,external_store_id,last_processed_receipt_at")
    .eq("provider", "loyverse")
    .eq("is_active", true);
  if (error)
    return NextResponse.json(
      { error: "connections_unavailable" },
      { status: 500 },
    );
  const results = [];
  for (const connection of connections ?? []) {
    try {
      if (!connection.external_store_id)
        throw new Error("Store belum dipilih.");
      const token = await resolveProviderToken(connection.id);
      const receipts = await fetchReceipts(
        token,
        connection.external_store_id,
        connection.last_processed_receipt_at,
      );
      results.push({
        connectionId: connection.id,
        ok: true,
        ...(await processLoyverseReceipts(connection.id, receipts)),
      });
    } catch (syncError) {
      const message =
        syncError instanceof Error ? syncError.message : "Sinkronisasi gagal.";
      await db
        .from("pos_connections")
        .update({
          status: "error",
          last_attempt_at: new Date().toISOString(),
          last_error: message,
        })
        .eq("id", connection.id);
      results.push({ connectionId: connection.id, ok: false, error: message });
    }
  }
  return NextResponse.json({ connections: results.length, results });
}

// Vercel Cron invokes GET. POST remains available for an explicitly authorized
// operational retry, using the same CRON_SECRET check and code path.
export async function GET(request: NextRequest) {
  return runScheduledSync(request);
}

export async function POST(request: NextRequest) {
  return runScheduledSync(request);
}

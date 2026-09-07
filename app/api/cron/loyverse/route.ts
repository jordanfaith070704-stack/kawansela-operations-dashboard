import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveProviderToken } from "@/lib/loyverse/credential-store";
import { fetchLoyverseReceipts } from "@/lib/loyverse/poll";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";

function authorized(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const value = request.headers.get("authorization");
  if (!expected || !value) return false;
  const supplied = value.replace(/^Bearer\s+/i, "");
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
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
      const receipts = await fetchLoyverseReceipts(
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

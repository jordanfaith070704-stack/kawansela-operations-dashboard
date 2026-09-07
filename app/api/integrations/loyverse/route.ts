import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveProviderToken } from "@/lib/loyverse/credential-store";
import { fetchLoyverseReceipts } from "@/lib/loyverse/poll";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

function signature(connectionId: string) {
  const key = process.env.POS_CREDENTIAL_ENCRYPTION_KEY;
  if (!key) throw new Error("credential_storage_not_configured");
  return createHmac("sha256", key).update(connectionId).digest("hex");
}

/** Secure receiver for Loyverse Back Office receipt notifications. */
export async function POST(request: NextRequest) {
  const connectionId = request.nextUrl.searchParams.get("connection");
  const supplied = request.nextUrl.searchParams.get("signature");
  if (!connectionId || !supplied) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let expected: string;
  try { expected = signature(connectionId); } catch { return NextResponse.json({ error: "unavailable" }, { status: 503 }); }
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { type?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (body.type !== "receipts.update") return NextResponse.json({ error: "unsupported_event" }, { status: 422 });
  const db = createAdminClient();
  const { data: connection } = await db.from("pos_connections")
    .select("id,external_store_id,last_processed_receipt_at")
    .eq("id", connectionId).eq("provider", "loyverse").eq("is_active", true).maybeSingle();
  if (!connection?.external_store_id) return NextResponse.json({ error: "connection_not_ready" }, { status: 409 });
  try {
    const receipts = await fetchLoyverseReceipts(await resolveProviderToken(connection.id), connection.external_store_id, connection.last_processed_receipt_at);
    const result = await processLoyverseReceipts(connection.id, receipts);
    await db.from("pos_connections").update({ last_webhook_at: new Date().toISOString() }).eq("id", connection.id);
    return NextResponse.json({ accepted: true, processed: result.processed }, { status: result.pending ? 202 : 200 });
  } catch (error) {
    console.error("Loyverse webhook failed", error);
    return NextResponse.json({ accepted: false }, { status: 500 });
  }
}

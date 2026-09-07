import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveProviderToken } from "@/lib/loyverse/credential-store";
import { fetchLoyverseReceipts } from "@/lib/loyverse/poll";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

type WebhookConnection = {
  id: string;
  external_store_id: string | null;
  last_processed_receipt_at: string | null;
};

/**
 * Back Office webhooks created with a Personal Access Token are not signed by
 * Loyverse. Each active cart therefore receives a separate high-entropy URL
 * key, stored only as a SHA-256 hash. Loyverse never receives an internal id.
 */
export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("key");
  const secretHash = secret
    ? createHash("sha256").update(secret).digest("hex")
    : "";
  const db = createAdminClient();
  const lookup = secretHash
    ? await db
        .from("pos_connections")
        .select("id,external_store_id,last_processed_receipt_at,webhook_key_hash")
        .eq("provider", "loyverse")
        .eq("is_active", true)
        .eq("webhook_key_hash", secretHash)
        .maybeSingle()
    : { data: null, error: null };
  const configuredHash = lookup.data?.webhook_key_hash;
  if (
    lookup.error ||
    !secret ||
    secret.length < 32 ||
    !configuredHash ||
    configuredHash.length !== secretHash.length ||
    !timingSafeEqual(Buffer.from(secretHash), Buffer.from(configuredHash))
  )
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: { type?: unknown };
  try {
    payload = (await request.json()) as { type?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (payload.type !== "receipts.update")
    return NextResponse.json({ error: "unsupported_event" }, { status: 422 });

  const connection = lookup.data as WebhookConnection;
  if (!connection.external_store_id)
    return NextResponse.json({ error: "connection_not_ready" }, { status: 409 });

  try {
    // The notification is only a trigger. Pull authoritative receipt data with
    // the server-side Loyverse credential before acknowledging the webhook.
    const token = await resolveProviderToken(connection.id);
    const receipts = await fetchLoyverseReceipts(
      token,
      connection.external_store_id,
      connection.last_processed_receipt_at,
    );
    const result = await processLoyverseReceipts(connection.id, receipts);
    await db
      .from("pos_connections")
      .update({ last_webhook_at: new Date().toISOString() })
      .eq("id", connection.id);
    return NextResponse.json(
      { accepted: true, processed: result.processed, pending: result.pending },
      { status: result.pending ? 202 : 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "webhook_failed";
    console.error("Loyverse webhook failed", {
      connectionId: connection.id,
      message,
    });
    return NextResponse.json({ accepted: false }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolveProviderToken } from "@/lib/loyverse/credential-store";
import { fetchLoyverseReceipts } from "@/lib/loyverse/poll";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";

export const maxDuration = 60;

/**
 * Near-live pull for an open operator dashboard. The client supplies only its
 * location id; membership, connection and credential checks stay server-side.
 */
export async function POST(request: NextRequest) {
  let body: { locationId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const locationId = typeof body.locationId === "string" ? body.locationId : "";
  if (!locationId) return NextResponse.json({ error: "location_required" }, { status: 400 });

  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: memberships } = await session
    .from("memberships")
    .select("role,location_id")
    .eq("user_id", user.id);
  const allowed = (memberships ?? []).some(
    (membership) => membership.role === "master" || membership.location_id === locationId,
  );
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const { data: connection } = await admin
    .from("pos_connections")
    .select("id,external_store_id,last_processed_receipt_at,last_attempt_at")
    .eq("location_id", locationId)
    .eq("provider", "loyverse")
    .eq("is_active", true)
    .maybeSingle();
  if (!connection?.external_store_id)
    return NextResponse.json({ status: "not_connected" }, { status: 409 });

  const lastAttempt = connection.last_attempt_at ? Date.parse(connection.last_attempt_at) : 0;
  if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 30_000)
    return NextResponse.json({ status: "recently_checked" });

  try {
    await admin
      .from("pos_connections")
      .update({ last_attempt_at: new Date().toISOString() })
      .eq("id", connection.id);
    const token = await resolveProviderToken(connection.id);
    const receipts = await fetchLoyverseReceipts(
      token,
      connection.external_store_id,
      connection.last_processed_receipt_at,
    );
    const result = await processLoyverseReceipts(connection.id, receipts);
    return NextResponse.json({ status: "synced", processed: result.processed, pending: result.pending });
  } catch {
    await admin
      .from("pos_connections")
      .update({
        status: "error",
        last_attempt_at: new Date().toISOString(),
        last_error: "Sinkronisasi Loyverse gagal. Coba lagi beberapa saat.",
      })
      .eq("id", connection.id);
    return NextResponse.json({ error: "sync_failed" }, { status: 502 });
  }
}

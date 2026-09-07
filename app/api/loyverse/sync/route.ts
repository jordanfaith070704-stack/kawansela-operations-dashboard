import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolveProviderToken } from "@/lib/loyverse/credential-store";
import { fetchLoyverseReceipts } from "@/lib/loyverse/poll";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";

export const maxDuration = 60;

function productKey(value: string) {
  return value
    .replace(/^\[demo\]\s*/i, "")
    .trim()
    .toLocaleLowerCase("id-ID")
    .replace(/[^a-z0-9]+/g, "");
}

/** Complete only a previously-saved connection when every assumption is exact. */
async function activatePendingIfUnambiguous(
  locationId: string,
  actorId: string,
) {
  const admin = createAdminClient();
  const [{ data: candidate }, { data: recipes }] = await Promise.all([
    admin
      .from("pos_connections")
      .select("id")
      .eq("location_id", locationId)
      .eq("provider", "loyverse")
      .eq("is_active", false)
      .eq("status", "not_connected")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("recipes").select("id,name").order("name"),
  ]);
  const recipeList = recipes ?? [];
  if (!candidate || !recipeList.length) return null;
  const token = await resolveProviderToken(candidate.id);
  const [storesBody, itemsBody, receiptsBody] = await Promise.all([
    fetch("https://api.loyverse.com/v1.0/stores", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Loyverse tidak dapat dihubungi.");
      return response.json();
    }),
    fetch("https://api.loyverse.com/v1.0/items?limit=250", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Loyverse tidak dapat dihubungi.");
      return response.json();
    }),
    fetch("https://api.loyverse.com/v1.0/receipts?limit=10", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Loyverse tidak dapat dihubungi.");
      return response.json();
    }),
  ]);
  const storeId = Array.isArray(receiptsBody.receipts)
    ? receiptsBody.receipts.find((receipt: { store_id?: unknown }) => typeof receipt.store_id === "string")?.store_id
    : null;
  const stores = Array.isArray(storesBody.stores) ? storesBody.stores : [];
  const items = Array.isArray(itemsBody.items) ? itemsBody.items : [];
  if (!storeId || !stores.some((store: { id?: string }) => store.id === storeId)) return null;
  const mappings = recipeList.map((recipe) => {
    const match = items.find(
      (item: { id?: string; item_name?: string; name?: string }) =>
        item.id && productKey(item.item_name ?? item.name ?? "") === productKey(recipe.name),
    );
    return match?.id ? { recipe_id: recipe.id, external_item_id: match.id } : null;
  });
  if (mappings.some((mapping) => !mapping)) return null;
  const rows = mappings.filter(
    (mapping): mapping is { recipe_id: string; external_item_id: string } => Boolean(mapping),
  );
  const { error: mappingError } = await admin
    .from("pos_product_mappings")
    .upsert(rows.map((mapping) => ({
      pos_connection_id: candidate.id,
      ...mapping,
      is_required: true,
      is_active: true,
    })), { onConflict: "pos_connection_id,recipe_id" });
  if (mappingError) throw new Error("Pemetaan produk belum dapat disimpan.");
  const { error: activationError } = await admin.rpc(
    "activate_pos_connection_replacement",
    { p_connection_id: candidate.id, p_external_store_id: storeId },
  );
  if (activationError) {
    const now = new Date().toISOString();
    const retired = await admin.from("pos_connections")
      .update({ is_active: false, status: "inactive", effective_until: now, updated_at: now })
      .eq("location_id", locationId).eq("provider", "loyverse")
      .neq("id", candidate.id).eq("is_active", true);
    if (retired.error) throw new Error(`Koneksi lama belum dapat dinonaktifkan: ${retired.error.message}`);
    const activated = await admin.from("pos_connections")
      .update({ external_store_id: storeId, status: "healthy", is_active: true, effective_from: now, effective_until: null, last_attempt_at: now, last_error: null, updated_at: now })
      .eq("id", candidate.id);
    if (activated.error) throw new Error(`Koneksi belum dapat diaktifkan: ${activated.error.message}`);
  }
  await admin.from("locations").update({ is_active: true }).eq("id", locationId);
  await admin.from("audit_logs").insert({
    location_id: locationId,
    actor_id: actorId,
    action: "AUTO_ACTIVATE_POS_CONNECTION",
    entity_type: "pos_connections",
    entity_id: candidate.id,
    after_data: { provider: "loyverse", store_id: storeId, mappings: rows.length },
  });
  return { id: candidate.id, storeId };
}

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
  let { data: connection } = await admin
    .from("pos_connections")
    .select("id,external_store_id,last_processed_receipt_at,last_attempt_at")
    .eq("location_id", locationId)
    .eq("provider", "loyverse")
    .eq("is_active", true)
    .maybeSingle();
  if (!connection?.external_store_id) {
    try {
      await activatePendingIfUnambiguous(locationId, user.id);
      const refreshed = await admin
        .from("pos_connections")
        .select("id,external_store_id,last_processed_receipt_at,last_attempt_at")
        .eq("location_id", locationId)
        .eq("provider", "loyverse")
        .eq("is_active", true)
        .maybeSingle();
      connection = refreshed.data;
    } catch {
      return NextResponse.json({ status: "setup_needed" }, { status: 409 });
    }
  }
  if (!connection?.external_store_id)
    return NextResponse.json({ status: "setup_needed" }, { status: 409 });

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

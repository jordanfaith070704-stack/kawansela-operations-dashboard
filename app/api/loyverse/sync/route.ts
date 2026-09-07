import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolveProviderToken } from "@/lib/loyverse/credential-store";
import { fetchLoyverseReceipts } from "@/lib/loyverse/poll";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";

export const maxDuration = 60;

function webhookUrl(connectionId: string) {
  const key = process.env.POS_CREDENTIAL_ENCRYPTION_KEY;
  if (!key) throw new Error("credential_storage_not_configured");
  const signature = createHmac("sha256", key).update(connectionId).digest("hex");
  return `https://dashboard.kawansela.com/api/integrations/loyverse?connection=${encodeURIComponent(connectionId)}&signature=${signature}`;
}

async function registerWebhook(token: string, connectionId: string) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const merchantResponse = await fetch("https://api.loyverse.com/v1.0/merchant/", {
    headers, cache: "no-store", signal: AbortSignal.timeout(12000),
  });
  if (!merchantResponse.ok) throw new Error(`Loyverse merchant HTTP ${merchantResponse.status}`);
  const merchant = await merchantResponse.json() as { id?: unknown };
  if (typeof merchant.id !== "string" || !merchant.id) throw new Error("Loyverse merchant id tidak tersedia.");
  const response = await fetch("https://api.loyverse.com/v1.0/webhooks/", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      merchant_id: merchant.id,
      type: "receipts.update",
      url: webhookUrl(connectionId),
      status: "ENABLED",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  // A prior successful attempt may be reported as duplicate; it is already safe.
  if (!response.ok && response.status !== 409) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Webhook Loyverse HTTP ${response.status}: ${detail}`);
  }
}

function productKey(value: string) {
  return value
    .replace(/^\[demo\]\s*/i, "")
    .trim()
    .toLocaleLowerCase("id-ID")
    .replace(/[^a-z0-9]+/g, "");
}

/** Keep newly-published recipes connected without reopening onboarding. */
async function mapNewRecipesByExactName(connectionId: string, token: string) {
  const admin = createAdminClient();
  const [{ data: recipes, error: recipeError }, { data: mappings, error: mappingError }] =
    await Promise.all([
      admin.from("recipes").select("id,name"),
      admin
        .from("pos_product_mappings")
        .select("recipe_id")
        .eq("pos_connection_id", connectionId)
        .eq("is_active", true),
    ]);
  if (recipeError || mappingError) throw new Error("Pemetaan produk tidak dapat diperiksa.");
  const mappedIds = new Set((mappings ?? []).map((mapping) => mapping.recipe_id));
  const missing = (recipes ?? []).filter((recipe) => !mappedIds.has(recipe.id));
  if (!missing.length) return;

  const response = await fetch("https://api.loyverse.com/v1.0/items?limit=250", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Loyverse items HTTP ${response.status}`);
  const body = await response.json() as {
    items?: Array<{ id?: string; item_name?: string; name?: string }>;
  };
  const items = Array.isArray(body.items) ? body.items : [];
  const rows = missing.flatMap((recipe) => {
    const matches = items.filter(
      (item) =>
        item.id &&
        productKey(item.item_name ?? item.name ?? "") === productKey(recipe.name),
    );
    return matches.length === 1
      ? [{
          pos_connection_id: connectionId,
          recipe_id: recipe.id,
          external_item_id: matches[0].id as string,
          is_required: true,
          is_active: true,
        }]
      : [];
  });
  if (!rows.length) return;
  const { error } = await admin
    .from("pos_product_mappings")
    .upsert(rows, { onConflict: "pos_connection_id,recipe_id" });
  if (error) throw new Error("Pemetaan produk otomatis belum dapat disimpan.");
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
  const recentStoreId = Array.isArray(receiptsBody.receipts)
    ? receiptsBody.receipts.find((receipt: { store_id?: unknown }) => typeof receipt.store_id === "string")?.store_id
    : null;
  const stores = Array.isArray(storesBody.stores) ? storesBody.stores : [];
  const items = Array.isArray(itemsBody.items) ? itemsBody.items : [];
  const storeId = recentStoreId ?? (stores.length === 1 ? stores[0]?.id : null);
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
    .select("id,external_store_id,last_processed_receipt_at,last_attempt_at,webhook_registered_at")
    .eq("location_id", locationId)
    .eq("provider", "loyverse")
    .eq("is_active", true)
    .maybeSingle();
  if (!connection?.external_store_id) {
    try {
      await activatePendingIfUnambiguous(locationId, user.id);
      const refreshed = await admin
        .from("pos_connections")
        .select("id,external_store_id,last_processed_receipt_at,last_attempt_at,webhook_registered_at")
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
    try {
      await mapNewRecipesByExactName(connection.id, token);
    } catch (mappingError) {
      // A temporary catalogue failure must not stop already-mapped sales.
      console.warn("Loyverse automatic product mapping pending", {
        connectionId: connection.id,
        cause:
          mappingError instanceof Error ? mappingError.message : "unknown_error",
      });
    }
    if (!connection.webhook_registered_at) {
      try {
        await registerWebhook(token, connection.id);
        await admin
          .from("pos_connections")
          .update({ webhook_registered_at: new Date().toISOString() })
          .eq("id", connection.id);
      } catch (webhookError) {
        // Webhook setup improves latency, but must never block the existing
        // authenticated receipt pull or turn a healthy POS connection red.
        console.warn("Loyverse webhook registration pending", {
          connectionId: connection.id,
          cause:
            webhookError instanceof Error
              ? webhookError.message
              : "unknown_error",
        });
      }
    }
    const receipts = await fetchLoyverseReceipts(
      token,
      connection.external_store_id,
      connection.last_processed_receipt_at,
    );
    const result = await processLoyverseReceipts(connection.id, receipts);
    return NextResponse.json({ status: "synced", processed: result.processed, pending: result.pending });
  } catch (error) {
    const cause = error instanceof Error ? error.message : "unknown_error";
    const detail = cause.includes("credential")
      ? "Kredensial Loyverse tidak dapat dibaca. Simpan ulang token koneksi."
      : cause.includes("HTTP 401") || cause.includes("HTTP 403")
        ? "Token Loyverse ditolak. Simpan ulang token koneksi."
        : cause.includes("HTTP 429")
          ? "Loyverse membatasi permintaan sementara. Sistem akan mencoba lagi."
          : cause.includes("timeout")
            ? "Loyverse tidak merespons tepat waktu. Sistem akan mencoba lagi."
            : `Sinkronisasi Loyverse gagal: ${cause.slice(0, 180)}`;
    console.error("Loyverse sync failed", { connectionId: connection.id, cause });
    await admin
      .from("pos_connections")
      .update({
        status: "error",
        last_attempt_at: new Date().toISOString(),
        last_error: detail,
      })
      .eq("id", connection.id);
    return NextResponse.json({ error: "sync_failed", detail }, { status: 502 });
  }
}

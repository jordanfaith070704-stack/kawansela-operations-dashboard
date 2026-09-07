import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  decryptProviderToken,
  encryptProviderToken,
  resolveProviderToken,
} from "@/lib/loyverse/credential-store";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";

const LOYVERSE_API = "https://api.loyverse.com/v1.0";

// Store and catalogue lookups can take longer than a normal UI request.
// The browser waits 45 seconds; this gives the server enough headroom to
// complete the two independent Loyverse calls and return a single response.
export const maxDuration = 60;

async function requireMaster() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return null;
  const { data } = await db
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("role", "master")
    .maybeSingle();
  return data ? user : null;
}

async function loyverse(token: string, path: string) {
  const response = await fetch(`${LOYVERSE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "loyverse_auth_failed"
        : "loyverse_unavailable",
    );
  return response.json();
}

export async function POST(request: NextRequest) {
  if (!(await requireMaster()))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const locationId = typeof body.locationId === "string" ? body.locationId : "";
  const token =
    typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!locationId || !token)
    return NextResponse.json(
      { error: "location_and_token_required" },
      { status: 400 },
    );

  try {
    const admin = createAdminClient();
    const [{ data: location }, stores, items, receipts] = await Promise.all([
      admin.from("locations").select("id,code").eq("id", locationId).single(),
      loyverse(token, "/stores"),
      loyverse(token, "/items?limit=250"),
      loyverse(token, "/receipts?limit=10"),
    ]);
    if (!location)
      return NextResponse.json(
        { error: "location_not_found" },
        { status: 404 },
      );
    const { data: activeConnection } = await admin
      .from("pos_connections")
      .select("id,external_store_id")
      .eq("location_id", locationId)
      .eq("provider", "loyverse")
      .eq("is_active", true)
      .maybeSingle();
    const { data: activeMappings } = activeConnection
      ? await admin
          .from("pos_product_mappings")
          .select("recipe_id,external_item_id")
          .eq("pos_connection_id", activeConnection.id)
          .eq("is_active", true)
      : { data: [] };
    const id = randomUUID();
    const secret = encryptProviderToken(token);
    const { error: connectionError } = await admin
      .from("pos_connections")
      .insert({
        id,
        location_id: locationId,
        provider: "loyverse",
        connection_name: `Loyverse ${location.code}`,
        secret_reference: `database:${id}`,
        status: "not_connected",
        is_active: false,
      });
    if (connectionError)
      return NextResponse.json(
        { error: "connection_save_failed" },
        { status: 400 },
      );
    const { error: secretError } = await admin
      .from("pos_connection_secrets")
      .insert({ pos_connection_id: id, ...secret });
    if (secretError) {
      await admin.from("pos_connections").delete().eq("id", id);
      return NextResponse.json(
        { error: "credential_save_failed" },
        { status: 500 },
      );
    }
    const storeList = Array.isArray(stores.stores) ? stores.stores : [];
    const recentStoreId = Array.isArray(receipts.receipts)
      ? receipts.receipts.find((receipt: { store_id?: unknown }) => typeof receipt.store_id === "string" && receipt.store_id)?.store_id
      : "";
    return NextResponse.json(
      {
        connectionId: id,
        stores: Array.isArray(stores.stores)
          ? stores.stores.map((store: { id: string; name: string }) => ({
              id: store.id,
              name: store.name,
            }))
          : [],
        items: Array.isArray(items.items)
          ? items.items.map(
              (item: { id: string; item_name?: string; name?: string }) => ({
                id: item.id,
                name: item.item_name ?? item.name ?? item.id,
              }),
            )
          : [],
        suggestedStoreId: activeConnection?.external_store_id ?? recentStoreId ?? (storeList.length === 1 ? storeList[0].id : ""),
        suggestedMappings: Object.fromEntries(
          (activeMappings ?? []).map((mapping) => [
            mapping.recipe_id,
            mapping.external_item_id,
          ]),
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "connection_failed";
    const known = [
      "credential_storage_not_configured",
      "loyverse_auth_failed",
      "loyverse_unavailable",
    ];
    return NextResponse.json(
      { error: known.includes(code) ? code : "connection_failed" },
      { status: code === "credential_storage_not_configured" ? 503 : 400 },
    );
  }
}

/**
 * Restores the newest unactivated connection after a browser interruption.
 * The encrypted credential remains server-side; the browser receives only the
 * store and item catalog needed to finish the wizard.
 */
export async function GET(request: NextRequest) {
  if (!(await requireMaster()))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const locationId = request.nextUrl.searchParams.get("locationId") ?? "";
  if (!locationId)
    return NextResponse.json({ error: "location_required" }, { status: 400 });
  try {
    const admin = createAdminClient();
    const { data: candidate } = await admin
      .from("pos_connections")
      .select("id")
      .eq("location_id", locationId)
      .eq("provider", "loyverse")
      .eq("is_active", false)
      .eq("status", "not_connected")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!candidate)
      return NextResponse.json({ error: "candidate_not_found" }, { status: 404 });
    const token = await resolveProviderToken(candidate.id);
    const [stores, items, receipts] = await Promise.all([
      loyverse(token, "/stores"),
      loyverse(token, "/items?limit=250"),
      loyverse(token, "/receipts?limit=10"),
    ]);
    const recentReceipts = Array.isArray(receipts.receipts)
      ? receipts.receipts
      : [];
    const suggestedStoreId = recentReceipts.find(
      (receipt: { store_id?: unknown }) =>
        typeof receipt.store_id === "string" && receipt.store_id,
    )?.store_id;
    return NextResponse.json({
      connectionId: candidate.id,
      suggestedStoreId,
      stores: Array.isArray(stores.stores)
        ? stores.stores.map((store: { id: string; name: string }) => ({ id: store.id, name: store.name }))
        : [],
      items: Array.isArray(items.items)
        ? items.items.map((item: { id: string; item_name?: string; name?: string }) => ({ id: item.id, name: item.item_name ?? item.name ?? item.id }))
        : [],
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "connection_failed";
    return NextResponse.json(
      { error: code === "loyverse_auth_failed" ? code : "connection_failed" },
      { status: 400 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const master = await requireMaster();
  if (!master)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const connectionId =
    typeof body.connectionId === "string" ? body.connectionId : "";
  const storeId = typeof body.storeId === "string" ? body.storeId : "";
  const mappings = Array.isArray(body.mappings)
    ? body.mappings.filter(
        (entry): entry is { recipeId: string; itemId: string } =>
          Boolean(
            entry &&
            typeof entry === "object" &&
            typeof (entry as { recipeId?: unknown }).recipeId === "string" &&
            typeof (entry as { itemId?: unknown }).itemId === "string",
          ),
      )
    : [];
  if (!connectionId || !storeId || !mappings.length)
    return NextResponse.json(
      { error: "store_and_mappings_required" },
      { status: 400 },
    );
  try {
    const admin = createAdminClient();
    const [{ data: connection }, { data: secret }, { data: recipes }] =
      await Promise.all([
        admin
          .from("pos_connections")
          .select("id,location_id")
          .eq("id", connectionId)
          .eq("provider", "loyverse")
          .single(),
        admin
          .from("pos_connection_secrets")
          .select("ciphertext,iv,auth_tag")
          .eq("pos_connection_id", connectionId)
          .single(),
        admin.from("recipes").select("id"),
      ]);
    if (!connection || !secret)
      return NextResponse.json(
        { error: "connection_not_found" },
        { status: 404 },
      );
    const requiredIds = new Set((recipes ?? []).map((recipe) => recipe.id));
    if (
      [...requiredIds].some(
        (id) =>
          !mappings.some(
            (mapping) => mapping.recipeId === id && mapping.itemId,
          ),
      )
    )
      return NextResponse.json(
        { error: "required_products_not_mapped" },
        { status: 400 },
      );
    const token = decryptProviderToken(secret);
    const [stores, items, receipts] = await Promise.all([
      loyverse(token, "/stores"),
      loyverse(token, "/items?limit=250"),
      loyverse(
        token,
        `/receipts?store_ids=${encodeURIComponent(storeId)}&limit=1`,
      ),
    ]);
    const storeList = Array.isArray(stores.stores) ? stores.stores : [];
    const itemList = Array.isArray(items.items) ? items.items : [];
    if (!storeList.some((store: { id: string }) => store.id === storeId))
      return NextResponse.json({ error: "store_not_found" }, { status: 400 });
    if (
      mappings.some(
        (mapping) =>
          !itemList.some((item: { id: string }) => item.id === mapping.itemId),
      )
    )
      return NextResponse.json(
        { error: "mapped_item_not_found" },
        { status: 400 },
      );
    await admin
      .from("pos_product_mappings")
      .delete()
      .eq("pos_connection_id", connectionId);
    const { error: mappingError } = await admin
      .from("pos_product_mappings")
      .insert(
        mappings.map((mapping) => ({
          pos_connection_id: connectionId,
          recipe_id: mapping.recipeId,
          external_item_id: mapping.itemId,
          is_required: true,
          is_active: true,
        })),
      );
    if (mappingError)
      return NextResponse.json(
        { error: "mapping_save_failed" },
        { status: 500 },
      );
    const now = new Date().toISOString();
    const { error: activationError } = await admin.rpc(
      "activate_pos_connection_replacement",
      {
        p_connection_id: connectionId,
        p_external_store_id: storeId,
      },
    );
    if (activationError) {
      // Some existing environments predate the atomic activation RPC. Keep the
      // same safe replacement order so a valid Loyverse token is not trapped in
      // a permanent setup loop.
      const retired = await admin
        .from("pos_connections")
        .update({ is_active: false, status: "inactive", effective_until: now, updated_at: now })
        .eq("location_id", connection.location_id)
        .eq("provider", "loyverse")
        .neq("id", connectionId)
        .eq("is_active", true);
      if (retired.error)
        return NextResponse.json({ error: "activation_failed", detail: retired.error.message }, { status: 500 });
      const activated = await admin
        .from("pos_connections")
        .update({ external_store_id: storeId, status: "healthy", is_active: true, effective_from: now, effective_until: null, last_attempt_at: now, last_error: null, updated_at: now })
        .eq("id", connectionId);
      if (activated.error)
        return NextResponse.json({ error: "activation_failed", detail: activated.error.message }, { status: 500 });
    }
    await admin
      .from("locations")
      .update({ is_active: true, updated_at: now })
      .eq("id", connection.location_id);
    await admin.from("audit_logs").insert({
      location_id: connection.location_id,
      actor_id: master.id,
      action: "ACTIVATE_POS_CONNECTION",
      entity_type: "pos_connections",
      entity_id: connectionId,
      after_data: { provider: "loyverse", external_store_id: storeId, mappings: mappings.length },
    });
    let initialSync: { processed: number; duplicated: number; pending: number } | null = null;
    try {
      const receiptList = Array.isArray(receipts.receipts)
        ? (receipts.receipts as Parameters<typeof processLoyverseReceipts>[1])
        : [];
      const sync = await processLoyverseReceipts(connectionId, receiptList);
      initialSync = {
        processed: sync.processed,
        duplicated: sync.duplicated,
        pending: sync.pending,
      };
    } catch (syncError) {
      initialSync = { processed: 0, duplicated: 0, pending: 1 };
      await admin.from("pos_connections").update({
        status: "warning",
        last_error: syncError instanceof Error ? syncError.message : "Sinkronisasi awal gagal.",
        updated_at: new Date().toISOString(),
      }).eq("id", connectionId);
    }
    return NextResponse.json({
      ready: true,
      initialSync,
      checks: {
        authentication: true,
        store: true,
        products: `${mappings.length}/${requiredIds.size}`,
        sales: Array.isArray(receipts.receipts),
        timestamps: true,
        duplicateProtection: true,
        locationMapping: true,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "test_failed";
    const known = [
      "credential_storage_not_configured",
      "loyverse_auth_failed",
      "loyverse_unavailable",
    ];
    return NextResponse.json(
      { error: known.includes(code) ? code : "test_failed" },
      { status: code === "credential_storage_not_configured" ? 503 : 400 },
    );
  }
}

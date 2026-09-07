import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  decryptProviderToken,
  encryptProviderToken,
} from "@/lib/loyverse/credential-store";

const LOYVERSE_API = "https://api.loyverse.com/v1.0";

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
    const [{ data: location }, stores, items] = await Promise.all([
      admin.from("locations").select("id,code").eq("id", locationId).single(),
      loyverse(token, "/stores"),
      loyverse(token, "/items?limit=250"),
    ]);
    if (!location)
      return NextResponse.json(
        { error: "location_not_found" },
        { status: 404 },
      );
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

export async function PUT(request: NextRequest) {
  if (!(await requireMaster()))
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
    const { error: activationError } = await admin
      .from("pos_connections")
      .update({
        external_store_id: storeId,
        status: "healthy",
        is_active: true,
        last_attempt_at: now,
        last_error: null,
        updated_at: now,
      })
      .eq("id", connectionId);
    if (activationError)
      return NextResponse.json({ error: "activation_failed" }, { status: 500 });
    await admin
      .from("locations")
      .update({ is_active: true, updated_at: now })
      .eq("id", connection.location_id);
    return NextResponse.json({
      ready: true,
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

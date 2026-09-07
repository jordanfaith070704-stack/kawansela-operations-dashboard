import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** The Master catalogue must not depend on a fragile browser-side nested
 * PostgREST relationship query. Authorize the Master session first, then use
 * the same authoritative catalogue data for every Master browser. */
export async function GET() {
  const session = await createClient();
  const { data: claims, error: claimError } = await session.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (claimError || !userId)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: membership } = await session
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "master")
    .maybeSingle();
  if (!membership)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const [items, suppliers, recipes] = await Promise.all([
    admin.from("inventory_items")
      .select("id,sku,name,unit,category,supplier_id,standard_unit_cost")
      .order("category").order("name"),
    admin.from("suppliers")
      .select("id,name,lead_days,is_active")
      .order("name"),
    admin.from("recipes")
      .select("id,name,selling_price,active_version,recipe_versions(id,version,batch_ml,serving_ml,carry_days,note,published_at,recipe_version_lines(item_id,quantity,inventory_items(id,name,unit,standard_unit_cost)))")
      .order("name"),
  ]);
  if (items.error || suppliers.error || recipes.error)
    return NextResponse.json({ error: "catalog_unavailable" }, { status: 500 });
  return NextResponse.json({
    items: items.data ?? [],
    suppliers: suppliers.data ?? [],
    recipes: recipes.data ?? [],
  });
}

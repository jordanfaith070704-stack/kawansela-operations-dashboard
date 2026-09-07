import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Master-only location list. Kept server-side so the Master view and the
 * operational connections use one authoritative data path. */
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

  const { data, error } = await createAdminClient()
    .from("locations")
    .select("id,code,name,city,timezone,is_active,opening_date")
    .is("archived_at", null)
    .order("code");
  if (error)
    return NextResponse.json({ error: "locations_unavailable" }, { status: 500 });
  return NextResponse.json({ locations: data ?? [] });
}

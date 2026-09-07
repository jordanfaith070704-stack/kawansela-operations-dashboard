import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: membership } = await session
    .from("memberships")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "master")
    .maybeSingle();
  if (!membership)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json();
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim() : null;
  const locationId =
    typeof body.locationId === "string" ? body.locationId : null;
  const role =
    body.role === "location_manager" ? "location_manager" : "operator";
  const temporaryPassword =
    typeof body.temporaryPassword === "string" ? body.temporaryPassword : "";
  const mode = body.mode === "create" ? "create" : "invite";
  if (!email || !locationId)
    return NextResponse.json(
      { error: "email_and_location_required" },
      { status: 400 },
    );
  if (mode === "create" && temporaryPassword.length < 12)
    return NextResponse.json(
      { error: "temporary_password_too_short" },
      { status: 400 },
    );

  try {
    const admin = createAdminClient();
    const account =
      mode === "create"
        ? await admin.auth.admin.createUser({
            email,
            password: temporaryPassword,
            email_confirm: true,
            user_metadata: {
              display_name: displayName,
              must_change_password: true,
            },
          })
        : await admin.auth.admin.inviteUserByEmail(email, {
            data: { display_name: displayName },
          });
    if (account.error || !account.data.user)
      return NextResponse.json(
        {
          error:
            mode === "create" ? "account_creation_failed" : "invite_failed",
        },
        { status: 400 },
      );
    const { error: assignmentError } = await admin.from("memberships").insert({
      user_id: account.data.user.id,
      location_id: locationId,
      role,
      display_name: displayName,
    });
    if (assignmentError) {
      await admin.auth.admin.deleteUser(account.data.user.id);
      return NextResponse.json({ error: "assignment_failed" }, { status: 500 });
    }
    return NextResponse.json(
      { invited: mode === "invite", created: mode === "create" },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "admin_invites_not_configured" },
      { status: 503 },
    );
  }
}

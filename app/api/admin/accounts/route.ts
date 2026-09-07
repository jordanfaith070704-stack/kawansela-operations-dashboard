import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/config";

async function requireMaster() {
  const session = await createClient();
  const { data: claimData, error: claimError } = await session.auth.getClaims();
  const userId = claimData?.claims?.sub;
  if (claimError || !userId)
    return { error: "unauthorized" as const, status: 401 };
  const { data: membership } = await session
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "master")
    .maybeSingle();
  if (!membership) return { error: "forbidden" as const, status: 403 };
  return {
    user: {
      id: userId,
      email:
        typeof claimData.claims.email === "string"
          ? claimData.claims.email
          : undefined,
    },
    admin: createAdminClient(),
  };
}

export async function GET() {
  const access = await requireMaster();
  if ("error" in access)
    return NextResponse.json({ error: access.error }, { status: access.status });

  const [{ data: userPage, error: userError }, { data: memberships, error: membershipError }] =
    await Promise.all([
      access.admin.auth.admin.listUsers({ page: 1, perPage: 500 }),
      access.admin
        .from("memberships")
        .select("id,user_id,location_id,role,display_name,locations(code,name)")
        .order("created_at"),
    ]);
  if (userError || membershipError)
    return NextResponse.json({ error: "accounts_unavailable" }, { status: 500 });

  const users = new Map(userPage.users.map((user) => [user.id, user]));
  const accounts = (memberships ?? []).map((membership) => {
    const account = users.get(membership.user_id);
    const location = Array.isArray(membership.locations)
      ? membership.locations[0]
      : membership.locations;
    return {
      id: membership.id,
      userId: membership.user_id,
      email: account?.email ?? "Email tidak tersedia",
      displayName: membership.display_name ?? "Tanpa nama",
      role: membership.role,
      locationId: membership.location_id,
      location: location
        ? { code: location.code, name: location.name }
        : null,
      lastSignInAt: account?.last_sign_in_at ?? null,
      mustChangePassword: Boolean(account?.user_metadata?.must_change_password),
    };
  });

  return NextResponse.json({ currentEmail: access.user.email, accounts });
}

export async function PATCH(request: NextRequest) {
  const access = await requireMaster();
  if ("error" in access)
    return NextResponse.json({ error: access.error }, { status: access.status });

  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "change_self_password") {
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : "";
    if (newPassword.length < 12)
      return NextResponse.json({ error: "password_too_short" }, { status: 400 });
    if (!access.user.email)
      return NextResponse.json({ error: "email_unavailable" }, { status: 400 });

    const verifier = createSupabaseClient(supabaseUrl, supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: verificationError } = await verifier.auth.signInWithPassword({
      email: access.user.email,
      password: currentPassword,
    });
    if (verificationError)
      return NextResponse.json(
        { error: "current_password_incorrect" },
        { status: 400 },
      );

    const { error: updateError } = await access.admin.auth.admin.updateUserById(
      access.user.id,
      { password: newPassword },
    );
    if (updateError)
      return NextResponse.json({ error: "password_update_failed" }, { status: 400 });

    await access.admin.from("audit_logs").insert({
      actor_id: access.user.id,
      action: "master_password_changed",
      entity_type: "auth_user",
      entity_id: access.user.id,
      after_data: { sessions_revocation_requested: true },
    });
    return NextResponse.json({ changed: true });
  }

  const userId = typeof body.userId === "string" ? body.userId : "";
  const { data: targetMembership } = await access.admin
    .from("memberships")
    .select("id,role,location_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!targetMembership)
    return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  if (action === "set_temporary_password") {
    if (targetMembership.role === "master")
      return NextResponse.json(
        { error: "use_master_password_form" },
        { status: 400 },
      );
    const temporaryPassword =
      typeof body.temporaryPassword === "string" ? body.temporaryPassword : "";
    if (temporaryPassword.length < 12)
      return NextResponse.json({ error: "password_too_short" }, { status: 400 });
    const { data: target, error: targetError } =
      await access.admin.auth.admin.getUserById(userId);
    if (targetError || !target.user)
      return NextResponse.json({ error: "account_not_found" }, { status: 404 });
    const { error: updateError } = await access.admin.auth.admin.updateUserById(
      userId,
      {
        password: temporaryPassword,
        user_metadata: {
          ...target.user.user_metadata,
          must_change_password: true,
        },
      },
    );
    if (updateError)
      return NextResponse.json({ error: "password_update_failed" }, { status: 400 });
    await access.admin.from("audit_logs").insert({
      location_id: targetMembership.location_id,
      actor_id: access.user.id,
      action: "operator_temporary_password_set",
      entity_type: "auth_user",
      entity_id: userId,
      after_data: { must_change_password: true },
    });
    return NextResponse.json({ changed: true });
  }

  if (action === "generate_recovery_link") {
    const { data: target, error: targetError } =
      await access.admin.auth.admin.getUserById(userId);
    if (targetError || !target.user?.email)
      return NextResponse.json({ error: "account_not_found" }, { status: 404 });
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? "https://dashboard.kawansela.com";
    const { data, error } = await access.admin.auth.admin.generateLink({
      type: "recovery",
      email: target.user.email,
      options: { redirectTo: `${origin}/auth/confirm?next=/reset-password` },
    });
    if (error || !data.properties?.action_link)
      return NextResponse.json({ error: "recovery_link_failed" }, { status: 400 });
    await access.admin.from("audit_logs").insert({
      location_id: targetMembership.location_id,
      actor_id: access.user.id,
      action: "recovery_link_generated",
      entity_type: "auth_user",
      entity_id: userId,
    });
    return NextResponse.json({ recoveryLink: data.properties.action_link });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}

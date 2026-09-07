import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "./dashboard-shell";
import { ForcePasswordChange } from "./force-password-change";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");
  const userMetadata = claims.claims.user_metadata as
    | { must_change_password?: boolean }
    | undefined;
  if (userMetadata?.must_change_password) return <ForcePasswordChange />;

  const { data: membership } = await supabase
    .from("memberships")
    .select("role, locations(id, name, city, code, is_active)")
    .eq("user_id", claims.claims.sub)
    .maybeSingle();

  if (!membership)
    return (
      <main className="login-panel">
        <div className="login-card">
          <h2>Akses belum diatur.</h2>
          <p className="footer-note">
            Akun Anda sudah berhasil masuk, tetapi belum diberikan akses ke
            Kawansela Operations. Hubungi Kawansela Master.
          </p>
        </div>
      </main>
    );

  const master = membership.role === "master";
  const location = Array.isArray(membership.locations)
    ? membership.locations[0]
    : membership.locations;
  if (!master && location && !location.is_active)
    return (
      <main className="login-panel">
        <div className="login-card">
          <h2>Lokasi tidak aktif.</h2>
          <p className="footer-note">
            Cart ini sudah dinonaktifkan. Hubungi Kawansela Master jika akses perlu dipulihkan.
          </p>
        </div>
      </main>
    );
  return (
    <DashboardShell
      master={master}
      locationId={master ? null : (location?.id ?? null)}
      locationName={
        master ? "Kawansela Master" : (location?.name ?? "Lokasi Kawansela")
      }
      locationMeta={
        master
          ? "Standar pusat · seluruh jaringan"
          : `${location?.city ?? ""} · ${location?.code ?? ""}`
      }
    />
  );
}

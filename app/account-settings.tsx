"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LocationStaff } from "./location-staff";
import styles from "./account-settings.module.css";
import { fetchJson } from "@/lib/fetch-json";

type Account = {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: "master" | "operator" | "location_manager";
  locationId: string | null;
  location: { code: string; name: string } | null;
  lastSignInAt: string | null;
  mustChangePassword: boolean;
};
type Location = { id: string; code: string; name: string };
type Message = { tone: "success" | "error"; text: string } | null;

export function AccountSettings() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [currentEmail, setCurrentEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [resetUserId, setResetUserId] = useState("");
  const [recoveryLink, setRecoveryLink] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const db = createClient();
      const [{ response: accountResponse, body }, locationResult] = await Promise.all([
        fetchJson<{ accounts?: Account[]; currentEmail?: string }>("/api/admin/accounts", { cache: "no-store" }),
        db.from("locations").select("id,code,name").is("archived_at", null).order("code"),
      ]);
      if (!accountResponse.ok || locationResult.error) throw new Error("load_failed");
      setAccounts(body.accounts ?? []);
      setCurrentEmail(body.currentEmail ?? "");
      setLocations((locationResult.data ?? []) as Location[]);
    } catch {
      setMessage({ tone: "error", text: "Data akun belum dapat dimuat. Coba lagi." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeMasterPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("master");
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword.length < 12 || newPassword !== confirmPassword) {
      setMessage({
        tone: "error",
        text: "Kata sandi baru minimal 12 karakter dan kedua isian harus sama.",
      });
      setPending("");
      return;
    }
    try {
      const { response, body } = await fetchJson<{ error?: string }>("/api/admin/accounts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "change_self_password", currentPassword, newPassword }),
      });
      if (!response.ok) {
        setMessage({ tone: "error", text: body.error === "current_password_incorrect" ? "Kata sandi saat ini tidak sesuai." : "Kata sandi belum dapat diubah. Coba lagi." });
        return;
      }
      await createClient().auth.signOut({ scope: "global" });
      router.replace("/login?message=Kata%20sandi%20berhasil%20diubah.%20Silakan%20masuk%20kembali.");
      router.refresh();
    } catch {
      setMessage({ tone: "error", text: "Koneksi terlalu lama. Kata sandi belum diubah." });
    } finally {
      setPending("");
    }
  }

  async function setTemporaryPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(resetUserId);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const temporaryPassword = String(form.get("temporaryPassword") ?? "");
    try {
      const { response, body } = await fetchJson<{ error?: string }>("/api/admin/accounts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_temporary_password", userId: resetUserId, temporaryPassword }),
      });
      if (!response.ok) {
        setMessage({ tone: "error", text: body.error === "password_too_short" ? "Kata sandi sementara minimal 12 karakter." : "Kata sandi sementara belum dapat disimpan." });
        return;
      }
      event.currentTarget.reset();
      setResetUserId("");
      setMessage({ tone: "success", text: "Kata sandi sementara disimpan. Staf wajib menggantinya saat masuk berikutnya." });
      await load();
    } catch {
      setMessage({ tone: "error", text: "Koneksi terlalu lama. Kata sandi belum diubah." });
    } finally {
      setPending("");
    }
  }

  async function generateRecoveryLink(userId: string) {
    setPending(`link-${userId}`);
    setMessage(null);
    setRecoveryLink("");
    try {
      const { response, body } = await fetchJson<{ recoveryLink?: string }>("/api/admin/accounts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate_recovery_link", userId }),
      });
      if (!response.ok || !body.recoveryLink) {
        setMessage({ tone: "error", text: "Tautan pemulihan belum dapat dibuat." });
        return;
      }
      setRecoveryLink(body.recoveryLink);
      setMessage({ tone: "success", text: "Tautan pemulihan dibuat. Salin dan kirim melalui pesan pribadi." });
    } catch {
      setMessage({ tone: "error", text: "Koneksi terlalu lama. Tautan belum dibuat." });
    } finally {
      setPending("");
    }
  }

  async function copyRecoveryLink() {
    try {
      await navigator.clipboard.writeText(recoveryLink);
      setMessage({ tone: "success", text: "Tautan pemulihan disalin." });
    } catch {
      setMessage({ tone: "error", text: "Tautan belum tersalin. Pilih dan salin secara manual." });
    }
  }

  return (
    <div className={styles.wrap}>
      {message ? (
        <div
          className={message.tone === "error" ? styles.error : styles.success}
          role="status"
        >
          {message.text}
        </div>
      ) : null}

      <section className={styles.grid}>
        <article className={styles.panel}>
          <span className={styles.eyebrow}>AKUN MASTER</span>
          <h2>Keamanan akun</h2>
          <p>
            Ubah kata sandi langsung dari dashboard. Proses ini tidak mengirim
            email dan tidak memakai kuota email Supabase.
          </p>
          <dl className={styles.identity}>
            <div>
              <dt>Email</dt>
              <dd>{currentEmail || "Memuat…"}</dd>
            </div>
            <div>
              <dt>Akses</dt>
              <dd>Master · Seluruh jaringan</dd>
            </div>
          </dl>
          <form className={styles.passwordForm} onSubmit={changeMasterPassword}>
            <label>
              Kata sandi saat ini
              <input name="currentPassword" type="password" required autoComplete="current-password" />
            </label>
            <label>
              Kata sandi baru
              <input name="newPassword" type="password" minLength={12} required autoComplete="new-password" />
            </label>
            <label>
              Ulangi kata sandi baru
              <input name="confirmPassword" type="password" minLength={12} required autoComplete="new-password" />
            </label>
            <button type="submit" disabled={pending === "master"}>
              {pending === "master" ? "Menyimpan…" : "Ubah kata sandi Master"}
            </button>
          </form>
        </article>

        <article className={styles.panel}>
          <span className={styles.eyebrow}>PEMULIHAN AKUN</span>
          <h2>Tanpa menunggu email</h2>
          <p>
            Buat tautan pemulihan sekali pakai lalu kirim melalui pesan pribadi.
            Email otomatis memerlukan layanan email khusus.
          </p>
          {recoveryLink ? (
            <div className={styles.linkBox}>
              <input value={recoveryLink} readOnly aria-label="Tautan pemulihan" />
              <button type="button" onClick={copyRecoveryLink}>Salin tautan</button>
            </div>
          ) : (
            <div className={styles.note}>
              Tautan hanya dibuat ketika tombol pemulihan pada akun dipilih.
            </div>
          )}
        </article>
      </section>

      <section className={styles.accountsPanel}>
        <header>
          <div>
            <span className={styles.eyebrow}>MANAJEMEN AKUN</span>
            <h2>Master dan operator</h2>
          </div>
          <span>{loading ? "Memuat…" : `${accounts.length} akun`}</span>
        </header>
        <div className={styles.accountList}>
          {accounts.map((account) => (
            <article className={styles.accountRow} key={account.id}>
              <div>
                <strong>{account.displayName}</strong>
                <span>{account.email}</span>
              </div>
              <div className={styles.accountMeta}>
                <strong>
                  {account.role === "master"
                    ? "MASTER"
                    : account.location?.code ?? "TANPA LOKASI"}
                </strong>
                <span>
                  {account.role === "location_manager"
                    ? "Penanggung jawab lokasi"
                    : account.role === "operator"
                      ? "Operator"
                      : "Akses seluruh jaringan"}
                </span>
              </div>
              <div className={styles.actions}>
                {account.role !== "master" ? (
                  <button type="button" onClick={() => setResetUserId(account.userId)}>
                    Atur kata sandi sementara
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void generateRecoveryLink(account.userId)}
                  disabled={pending === `link-${account.userId}`}
                >
                  {pending === `link-${account.userId}` ? "Membuat…" : "Buat tautan pemulihan"}
                </button>
              </div>
            </article>
          ))}
        </div>
        {!loading && !accounts.length ? <p className={styles.note}>Belum ada akun.</p> : null}
      </section>

      {resetUserId ? (
        <section className={styles.resetPanel}>
          <div>
            <span className={styles.eyebrow}>RESET OPERATOR</span>
            <h2>Atur kata sandi sementara</h2>
            <p>Staf akan diminta membuat kata sandi baru saat masuk berikutnya.</p>
          </div>
          <form onSubmit={setTemporaryPassword}>
            <input
              name="temporaryPassword"
              type="password"
              minLength={12}
              placeholder="Minimal 12 karakter"
              required
              autoComplete="new-password"
            />
            <button type="submit" disabled={pending === resetUserId}>Simpan</button>
            <button type="button" onClick={() => setResetUserId("")}>Batal</button>
          </form>
        </section>
      ) : null}

      <section className={styles.createPanel}>
        <LocationStaff locations={locations} onCreated={load} />
      </section>
    </div>
  );
}

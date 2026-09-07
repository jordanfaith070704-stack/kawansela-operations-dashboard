"use client";

import { FormEvent, useState } from "react";
import styles from "./location-staff.module.css";

type Location = { id: string; code: string; name: string };

export function LocationStaff({ locations, onCreated }: { locations: Location[]; onCreated?: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          locationId: form.get("locationId"),
          displayName: form.get("displayName"),
          email: form.get("email"),
          temporaryPassword: form.get("temporaryPassword"),
          role: form.get("role"),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
      const labels: Record<string, string> = {
        admin_invites_not_configured:
          "Pembuatan akun belum aktif di server. Tidak ada akun yang dibuat.",
        account_creation_failed:
          "Akun belum dapat dibuat. Periksa email atau gunakan email lain.",
        assignment_failed:
          "Akses lokasi gagal disimpan. Tidak ada akun yang dibuat.",
        temporary_password_too_short:
          "Kata sandi sementara minimal 12 karakter.",
      };
        setMessage({ error: true, text: labels[body.error] ?? "Akun belum dapat dibuat. Coba lagi." });
        return;
      }
      event.currentTarget.reset();
      setMessage({ error: false, text: "Akun operator berhasil dibuat." });
      setOpen(false);
      await onCreated?.();
    } catch {
      setMessage({ error: true, text: "Koneksi terlalu lama. Akun belum dibuat." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.wrap}>
      <div>
        <span>AKSES STAF</span>
        <h3>Akun operator</h3>
        <p>Akun operator dibatasi ke satu lokasi.</p>
      </div>
      <button
        className={styles.secondary}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!locations.length}
      >
        {open ? "Batal" : "+ Buat akun operator"}
      </button>
      {message ? (
        <div
          className={message.error ? styles.error : styles.success}
          role="status"
        >
          {message.text}
        </div>
      ) : null}
      {open ? (
        <form className={styles.form} onSubmit={submit}>
          <label>
            Lokasi
            <select name="locationId" required defaultValue="">
              <option value="" disabled>
                Pilih lokasi
              </option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.code} · {location.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Nama staf
            <input name="displayName" required />
          </label>
          <label>
            Email
            <input name="email" type="email" autoComplete="off" required />
          </label>
          <label>
            Peran
            <select name="role" defaultValue="operator">
              <option value="operator">Operator</option>
              <option value="location_manager">Penanggung jawab lokasi</option>
            </select>
          </label>
          <label>
            Kata sandi sementara
            <input
              name="temporaryPassword"
              type="password"
              minLength={12}
              autoComplete="new-password"
              required
            />
          </label>
          <p>
            Berikan kata sandi melalui saluran pribadi. Jangan kirim di grup.
          </p>
          <button className={styles.primary} type="submit" disabled={pending}>
            {pending ? "Membuat…" : "Buat akun"}
          </button>
        </form>
      ) : null}
    </section>
  );
}

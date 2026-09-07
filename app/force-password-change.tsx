"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import styles from "./login/login.module.css";

export function ForcePasswordChange() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    const confirm = String(form.get("confirm"));
    if (password.length < 12 || password !== confirm) {
      setError("Kata sandi harus sama dan minimal 12 karakter.");
      setPending(false);
      return;
    }
    const db = createClient();
    const { data: userResult } = await db.auth.getUser();
    const current = userResult.user?.user_metadata ?? {};
    const { error: updateError } = await db.auth.updateUser({
      password,
      data: { ...current, must_change_password: false },
    });
    setPending(false);
    if (updateError) {
      setError("Kata sandi belum dapat disimpan. Coba lagi.");
      return;
    }
    router.refresh();
  }
  return (
    <main className={styles.page}>
      <form className={`${styles.card} ${styles.form}`} onSubmit={submit}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.wordmark}>kawan.sela</span>
        </div>
        <div className={styles.eyebrow}>KEAMANAN AKUN</div>
        <h1 className={styles.title}>Buat kata sandi baru</h1>
        <p className={styles.subtitle}>
          Ganti kata sandi sementara sebelum membuka dashboard.
        </p>
        <label className={styles.field}>
          Kata sandi baru
          <input
            name="password"
            type="password"
            minLength={12}
            autoComplete="new-password"
            required
          />
        </label>
        <label className={styles.field}>
          Ulangi kata sandi
          <input
            name="confirm"
            type="password"
            minLength={12}
            autoComplete="new-password"
            required
          />
        </label>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
        <button className={styles.submit} disabled={pending}>
          {pending ? "Menyimpan…" : "Simpan kata sandi"}
        </button>
      </form>
    </main>
  );
}

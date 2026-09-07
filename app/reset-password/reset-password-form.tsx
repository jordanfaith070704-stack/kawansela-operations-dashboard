"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import styles from "./reset-password.module.css";

export function ResetPasswordForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password.length < 12 || password !== confirm) {
      setError("Kata sandi minimal 12 karakter dan kedua isian harus sama.");
      setPending(false);
      return;
    }
    const db = createClient();
    const { error: updateError } = await db.auth.updateUser({
      password,
      data: { must_change_password: false },
    });
    if (updateError) {
      setError("Kata sandi belum dapat disimpan. Minta tautan pemulihan baru.");
      setPending(false);
      return;
    }
    await db.auth.signOut({ scope: "global" });
    router.replace("/login?message=Kata%20sandi%20berhasil%20diubah.%20Silakan%20masuk.");
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-busy={pending}>
      <label>
        Kata sandi baru
        <input name="password" type="password" minLength={12} required autoComplete="new-password" />
      </label>
      <label>
        Ulangi password baru
        <input name="confirm" type="password" minLength={12} required autoComplete="new-password" />
      </label>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <button type="submit" disabled={pending}>{pending ? "Menyimpan…" : "Simpan password"}</button>
    </form>
  );
}

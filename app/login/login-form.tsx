"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ initialError }: { initialError?: string }) {
  const router = useRouter();
  const [error, setError] = useState(initialError ?? "");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: signInError } = await createClient().auth.signInWithPassword(
      {
        email: String(form.get("email") ?? "").trim(),
        password: String(form.get("password") ?? ""),
      },
    );
    if (signInError) {
      setError("Email atau kata sandi tidak sesuai.");
      setPending(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <form className="form" onSubmit={submit} aria-busy={pending}>
      <label>
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          disabled={pending}
        />
      </label>
      <label>
        Kata sandi
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          disabled={pending}
        />
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button
        className="primary login-submit"
        type="submit"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? "Masuk…" : "Masuk"}
      </button>
    </form>
  );
}

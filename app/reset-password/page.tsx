import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";
import styles from "./reset-password.module.css";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=Link%20pemulihan%20tidak%20valid%20atau%20sudah%20kedaluwarsa.");
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.brand}>kawan<span>.</span>sela</div>
        <div className={styles.eyebrow}>PEMULIHAN AKUN</div>
        <h1>Buat password baru</h1>
        <p>Gunakan minimal 12 karakter. Setelah disimpan, masuk kembali dengan password baru.</p>
        <ResetPasswordForm />
      </section>
    </main>
  );
}

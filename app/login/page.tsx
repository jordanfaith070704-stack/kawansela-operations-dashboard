import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.wordmark}>kawan.sela</span>
        </div>
        <div className={styles.eyebrow}>OPERATIONS</div>
        <h1 className={styles.title}>Masuk</h1>
        <p className={styles.subtitle}>Gunakan akun Kawansela Anda.</p>
        <LoginForm initialError={params.error} />
        {params.message && (
          <div className={`${styles.message} notice`}>{params.message}</div>
        )}
        <p className={styles.footer}>
          Jika lupa kata sandi, hubungi Kawansela Master.
          <br />
          Akses mengikuti peran dan lokasi.
        </p>
      </section>
    </main>
  );
}

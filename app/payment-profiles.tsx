"use client";

import { FormEvent, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./location-staff.module.css";

type Location = { id: string; code: string; name: string };
type Profile = {
  location_id: string;
  provider: string;
  static_qris_reference: string | null;
  is_active: boolean;
};

export function PaymentProfiles({ locations }: { locations: Location[] }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [pending, setPending] = useState(false);
  async function load() {
    const { data } = await createClient()
      .from("payment_profiles")
      .select("location_id,provider,static_qris_reference,is_active");
    setProfiles(data ?? []);
  }
  useEffect(() => {
    void load();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setMessageError(false);
    const form = new FormData(event.currentTarget);
    const locationId = String(form.get("locationId"));
    const reference = String(form.get("reference") ?? "").trim();
    try {
      const { error } = await createClient().from("payment_profiles").upsert(
        { location_id: locationId, provider: "static_qris", static_qris_reference: reference || null, provider_config: {}, is_active: true },
        { onConflict: "location_id" },
      );
      setMessageError(Boolean(error));
      setMessage(error ? "Profil QRIS belum dapat disimpan." : "Profil QRIS manual berhasil disimpan.");
      if (!error) await load();
    } catch {
      setMessageError(true);
      setMessage("Koneksi terlalu lama. Profil QRIS belum disimpan.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className={styles.wrap}>
      <div>
        <span>PEMBAYARAN</span>
        <h3>QRIS per lokasi</h3>
        <p>
          Profil pembayaran terpisah dari akun Loyverse. QRIS statis tetap dapat
          digunakan.
        </p>
      </div>
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
          Referensi QRIS
          <input name="reference" placeholder="Nama pemilik / referensi file" />
        </label>
        <button
          className={styles.primary}
          disabled={pending || !locations.length}
        >
          {pending ? "Menyimpan…" : "Simpan QRIS manual"}
        </button>
      </form>
      {message ? (
        <div className={messageError ? styles.error : styles.success} role={messageError ? "alert" : "status"}>
          {message}
        </div>
      ) : null}
      {profiles.length ? (
        <p>{profiles.length} profil pembayaran dikonfigurasi.</p>
      ) : null}
    </section>
  );
}

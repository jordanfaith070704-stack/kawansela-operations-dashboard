"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./operator-home.module.css";

type Location = {
  id: string;
  code: string;
  name: string;
  city: string;
  is_active: boolean;
};
type Connection = {
  location_id: string;
  status: string;
  last_successful_sync_at: string | null;
};
const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function MasterOverview() {
  const [ready, setReady] = useState(false);
  const [sales, setSales] = useState({ cups: 0, revenue: 0 });
  const [locations, setLocations] = useState<Location[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      setReady(false);
      setError("");
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const db = createClient();
      const [salesResult, locationsResult, connectionsResult] = await Promise.all([
        db
          .from("sales")
          .select("quantity,total")
          .gte("occurred_at", start.toISOString()),
        db
          .from("locations")
          .select("id,code,name,city,is_active")
          .is("archived_at", null)
          .order("code"),
        db
          .from("pos_connections")
          .select("location_id,status,last_successful_sync_at")
          .eq("is_active", true),
      ]);
      if (salesResult.error || locationsResult.error || connectionsResult.error) {
        setError("Ringkasan jaringan tidak dapat dimuat. Periksa koneksi lalu coba lagi.");
        setReady(true);
        return;
      }
      const saleRows = salesResult.data;
      const locationRows = locationsResult.data;
      const connectionRows = connectionsResult.data;
      setSales(
        (saleRows ?? []).reduce(
          (total, sale) => ({
            cups: total.cups + sale.quantity,
            revenue: total.revenue + Number(sale.total),
          }),
          { cups: 0, revenue: 0 },
        ),
      );
      setLocations(locationRows ?? []);
      setConnections(connectionRows ?? []);
      setReady(true);
    })();
  }, []);
  const active = locations.filter((location) => location.is_active).length;
  return (
    <div className={styles.wrap}>
      {error ? (
        <section className={styles.error} role="alert">
          <span>{error}</span>
          <button
            className={styles.retry}
            type="button"
            onClick={() => window.location.reload()}
          >
            Coba lagi
          </button>
        </section>
      ) : null}
      <section className={styles.numbers}>
        <article className={styles.number}>
          <span>OMZET JARINGAN HARI INI</span>
          <strong>{ready ? rupiah.format(sales.revenue) : "—"}</strong>
          <small>Transaksi valid</small>
        </article>
        <article className={styles.number}>
          <span>CUP HARI INI</span>
          <strong>{ready ? sales.cups : "—"}</strong>
          <small>Penjualan yang diproses</small>
        </article>
        <article className={styles.number}>
          <span>LOKASI AKTIF</span>
          <strong>{ready ? active : "—"}</strong>
          <small>
            {ready ? `${locations.length} lokasi terdaftar` : "Memuat lokasi"}
          </small>
        </article>
      </section>
      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3>Status lokasi</h3>
              <p>POS dan status operasional per lokasi.</p>
            </div>
          </div>
          {!ready ? (
            <div className={styles.empty}>Memuat lokasi…</div>
          ) : error ? (
            <div className={styles.empty}>Ringkasan lokasi belum tersedia.</div>
          ) : locations.length ? (
            locations.map((location) => {
              const connection = connections.find(
                (item) => item.location_id === location.id,
              );
              return (
                <div className={styles.row} key={location.id}>
                  <div>
                    <strong>
                      {location.code} · {location.name}
                    </strong>
                    <small>{location.city}</small>
                  </div>
                  <div className={styles.quantity}>
                    <span className={styles.state}>
                      {connection?.status === "healthy"
                        ? "LOYVERSE TERHUBUNG"
                        : connection
                          ? "PERLU PERHATIAN"
                          : "BELUM TERHUBUNG"}
                    </span>
                    <small>
                      {connection?.last_successful_sync_at
                        ? `Diperbarui ${new Date(connection.last_successful_sync_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
                        : "Belum ada sinkronisasi"}
                    </small>
                  </div>
                </div>
              );
            })
          ) : (
            <div className={styles.empty}>
              Belum ada lokasi. Tambahkan dari halaman Lokasi.
            </div>
          )}
        </article>
        <article className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3>Perlu perhatian</h3>
              <p>Hanya item yang perlu diperiksa.</p>
            </div>
          </div>
          <div className={styles.sync}>
            {connections.some(
              (connection) =>
                connection.status === "error" ||
                connection.status === "warning",
            )
              ? "Periksa koneksi POS yang bermasalah."
              : "Tidak ada peringatan integrasi."}
          </div>
        </article>
      </section>
    </div>
  );
}

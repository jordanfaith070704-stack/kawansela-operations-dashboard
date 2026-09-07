"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./operator-home.module.css";

type Props = { locationId: string };
type Batch = {
  id: string;
  remaining_ml: number;
  produced_at: string;
  use_by: string;
  recipe_versions: { recipes: { name: string } | null } | null;
};

const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function jakartaStartOfToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), -7));
}

export function OperatorHome({ locationId }: Props) {
  const [sales, setSales] = useState({ cups: 0, revenue: 0 });
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [posStatus, setPosStatus] = useState({
    title: "Memuat status POS",
    note: "",
  });
  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError("");
      const start = jakartaStartOfToday();
      const db = createClient();
      const [salesResult, batchesResult, healthResult] = await Promise.all([
        db
          .from("sales")
          .select("quantity,total")
          .eq("location_id", locationId)
          .gte("occurred_at", start.toISOString()),
        db
          .from("production_batches")
          .select(
            "id,remaining_ml,produced_at,use_by,recipe_versions(recipes(name))",
          )
          .eq("location_id", locationId)
          .eq("status", "open")
          .gt("remaining_ml", 0)
          .order("produced_at"),
        db.rpc("get_pos_health", { p_location_id: locationId }),
      ]);
      if (salesResult.error || batchesResult.error) {
        setError("Data lokasi tidak dapat dimuat. Periksa koneksi lalu coba lagi.");
        setLoading(false);
        return;
      }
      const saleRows = salesResult.data;
      const batchRows = batchesResult.data;
      setSales(
        (saleRows ?? []).reduce(
          (total, sale) => ({
            cups: total.cups + sale.quantity,
            revenue: total.revenue + Number(sale.total),
          }),
          { cups: 0, revenue: 0 },
        ),
      );
      setBatches((batchRows ?? []) as unknown as Batch[]);
      if (healthResult.error) {
        setPosStatus({
          title: "Status Loyverse tidak tersedia",
          note: "Coba muat ulang halaman ini.",
        });
      } else {
        const health = (healthResult.data ?? []) as Array<{ status: string }>;
        setPosStatus(
          !health.length
            ? {
                title: "Loyverse belum terhubung",
                note: "Penjualan belum masuk otomatis ke dashboard ini.",
              }
            : health.some((connection) => connection.status !== "healthy")
              ? {
                  title: "Loyverse perlu diperiksa",
                  note: "Penjualan baru mungkin belum masuk ke dashboard.",
                }
              : {
                  title: "Loyverse terhubung",
                  note: "Penjualan diproses otomatis ke dashboard ini.",
                },
        );
      }
      setLoading(false);
    })();
  }, [locationId]);
  const first = batches[0];
  return (
    <div className={styles.wrap}>
      <section className={styles.next}>
        <div>
          <div className={styles.tag}>BATCH FIFO</div>
          <h2>
            {loading
              ? "Memuat status lokasi…"
              : first
                ? `Gunakan ${first.recipe_versions?.recipes?.name ?? "batch ini"} lebih dulu.`
                : "Belum ada batch siap jual."}
          </h2>
          <p>
            {first
              ? `${first.remaining_ml} ml tersedia. Batch yang dibuat lebih dulu akan dipakai lebih dulu.`
              : "Buat produksi setelah resep aktif dan stok bahan tersedia."}
          </p>
        </div>
      </section>
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
          <span>CUP HARI INI</span>
          <strong>{loading ? "—" : sales.cups}</strong>
          <small>Penjualan yang diproses</small>
        </article>
        <article className={styles.number}>
          <span>OMZET HARI INI</span>
          <strong>{loading ? "—" : rupiah.format(sales.revenue)}</strong>
          <small>Transaksi valid</small>
        </article>
        <article className={styles.number}>
          <span>BATCH SIAP JUAL</span>
          <strong>{loading ? "—" : batches.length}</strong>
          <small>Urutan FIFO</small>
        </article>
      </section>
      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3>Batch siap jual</h3>
              <p>Batch tertua digunakan lebih dulu.</p>
            </div>
            <span className={styles.state}>FIFO</span>
          </div>
          {loading ? (
            <div className={styles.empty}>Memuat batch…</div>
          ) : batches.length ? (
            batches.slice(0, 5).map((batch, index) => (
              <div className={styles.row} key={batch.id}>
                <div>
                  <strong>
                    {batch.recipe_versions?.recipes?.name ?? "Produk"}
                  </strong>
                  <small>
                    {index === 0
                      ? "Gunakan lebih dulu"
                      : `Dibuat ${new Date(batch.produced_at).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" })} WIB`}
                  </small>
                </div>
                <div className={styles.quantity}>
                  <strong>{batch.remaining_ml} ml</strong>
                  <small>{(batch.remaining_ml / 150).toFixed(1)} cup</small>
                </div>
              </div>
            ))
          ) : (
            <div className={styles.empty}>Belum ada batch siap jual.</div>
          )}
        </article>
        <article className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3>Status POS</h3>
              <p>Penjualan masuk otomatis setelah POS aktif.</p>
            </div>
          </div>
          <div className={styles.sync}>
            <strong>{posStatus.title}</strong>
            <br />
            {posStatus.note}
          </div>
        </article>
      </section>
    </div>
  );
}

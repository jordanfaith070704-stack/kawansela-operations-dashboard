"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
type RawStock = {
  id: string;
  quantity: number;
  inventory_items: { name: string; unit: string; category: string } | null;
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
  const [rawStock, setRawStock] = useState<RawStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [posStatus, setPosStatus] = useState({
    title: "Memuat status POS",
    note: "",
  });
  const load = useCallback(async () => {
      setLoading(true);
      setError("");
      const start = jakartaStartOfToday();
      const db = createClient();
      // While this screen is open, request an incremental POS pull as well as
      // the scheduled backend sync. This makes a new cashier receipt visible
      // without the operator having to press a refresh button.
      await fetch("/api/loyverse/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const [salesResult, batchesResult, stockResult, healthResult] = await Promise.all([
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
        db
          .from("location_inventory")
          .select("item_id,quantity,inventory_items(name,unit,category)")
          .eq("location_id", locationId)
          .gt("quantity", 0)
          .order("updated_at", { ascending: false }),
        db.rpc("get_pos_health", { p_location_id: locationId }),
      ]);
      if (salesResult.error || batchesResult.error || stockResult.error) {
        setError("Data lokasi tidak dapat dimuat. Periksa koneksi lalu coba lagi.");
        setLoading(false);
        return;
      }
      const saleRows = salesResult.data;
      const batchRows = batchesResult.data;
      setRawStock((stockResult.data ?? []) as unknown as RawStock[]);
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
  }, [locationId]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const drinksReady = useMemo(() => {
    const grouped = new Map<string, { ml: number; batches: number }>();
    for (const batch of batches) {
      const name = batch.recipe_versions?.recipes?.name ?? "Produk";
      const current = grouped.get(name) ?? { ml: 0, batches: 0 };
      current.ml += batch.remaining_ml;
      current.batches += 1;
      grouped.set(name, current);
    }
    return [...grouped.entries()].map(([name, value]) => ({ name, ...value }));
  }, [batches]);
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
          <span>MINUMAN SIAP JUAL</span>
          <strong>{loading ? "—" : drinksReady.length}</strong>
          <small>Produk dengan batch tersedia</small>
        </article>
      </section>
      <section className={styles.stockGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3>Stok bahan baku</h3>
              <p>Sisa bahan aktual di lokasi ini.</p>
            </div>
            <span className={styles.state}>BAHAN BAKU</span>
          </div>
          {loading ? (
            <div className={styles.empty}>Memuat stok bahan…</div>
          ) : rawStock.length ? (
            rawStock.map((item) => (
              <div className={styles.row} key={item.id}>
                <div>
                  <strong>{item.inventory_items?.name ?? "Bahan"}</strong>
                  <small>{item.inventory_items?.category === "packaging" ? "Kemasan" : "Bahan produksi"}</small>
                </div>
                <div className={styles.quantity}>
                  <strong>{item.quantity} {item.inventory_items?.unit ?? ""}</strong>
                  <small>Sisa tersedia</small>
                </div>
              </div>
            ))
          ) : (
            <div className={styles.empty}>Belum ada stok bahan di lokasi ini.</div>
          )}
        </article>
        <article className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3>Stok minuman siap jual</h3>
              <p>Hasil produksi yang tersisa dan dapat dijual.</p>
            </div>
            <span className={styles.state}>SIAP JUAL</span>
          </div>
          {loading ? (
            <div className={styles.empty}>Memuat stok minuman…</div>
          ) : drinksReady.length ? (
            drinksReady.map((drink) => (
              <div className={styles.row} key={drink.name}>
                <div><strong>{drink.name}</strong><small>{drink.batches} batch tersedia · FIFO saat penjualan</small></div>
                <div className={styles.quantity}><strong>{drink.ml} ml</strong><small>{(drink.ml / 150).toFixed(1)} cup</small></div>
              </div>
            ))
          ) : (
            <div className={styles.empty}>Belum ada minuman siap jual. Catat produksi terlebih dahulu.</div>
          )}
        </article>
      </section>
      <section className={styles.grid}>
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

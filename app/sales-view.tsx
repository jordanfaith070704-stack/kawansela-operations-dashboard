"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./sales-view.module.css";

type Sale = {
  id: string;
  quantity: number;
  total: number;
  cogs: number;
  payment_method: string;
  occurred_at: string;
  source: string;
  recipes: { name: string } | null;
  locations: { code: string } | null;
};
type PosHealth = {
  status: string;
  last_successful_sync_at: string | null;
};
type Period = "day" | "week" | "month";
type Rollup = {
  bucket: string;
  revenue: number;
  cogs: number;
  cups: number;
  cash: number;
  qris: number;
};
const money = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function SalesView({
  locationId,
  master = false,
}: {
  locationId: string | null;
  master?: boolean;
}) {
  const [rows, setRows] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [posStatus, setPosStatus] = useState("Memuat status");
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [period, setPeriod] = useState<Period>("day");
  const [rollups, setRollups] = useState<Rollup[]>([]);
  const lastUpdatedRef = useRef<Date | null>(null);
  const inFlightRef = useRef(false);
  const load = useCallback(async (quiet = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    const start = new Date();
    if (period === "day") start.setHours(0, 0, 0, 0);
    else if (period === "week") {
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
    const db = createClient();
    let query = db
      .from("sales")
      .select(
        "id,quantity,total,cogs,payment_method,occurred_at,source,recipes(name),locations(code)",
      )
      .gte("occurred_at", start.toISOString())
      .order("occurred_at", { ascending: false })
      .limit(100);
    if (locationId) query = query.eq("location_id", locationId);
    try {
    if (locationId && !master) {
      // Pull only from the browser's own cart. The API validates the session
      // and performs the provider call on the server.
      await fetch("/api/loyverse/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
    }
    const [salesResult, healthResult, rollupResult] = await Promise.all([
      query,
      db.rpc("get_pos_health", { p_location_id: locationId }),
      db.rpc("get_sales_rollup", { p_location_id: locationId, p_period: period }),
    ]);
    if (salesResult.error || rollupResult.error) {
      setError(
        lastUpdatedRef.current
          ? "Pembaruan penjualan gagal. Tampilan ini memakai data terakhir."
          : "Penjualan tidak dapat dimuat. Data ini mungkin belum terbaru.",
      );
    } else {
      setRows((salesResult.data ?? []) as unknown as Sale[]);
      setRollups(
        ((rollupResult.data ?? []) as Rollup[]).map((row) => ({
          ...row,
          revenue: Number(row.revenue),
          cogs: Number(row.cogs),
          cups: Number(row.cups),
          cash: Number(row.cash),
          qris: Number(row.qris),
        })),
      );
      const updatedAt = new Date();
      lastUpdatedRef.current = updatedAt;
      setLastUpdatedAt(updatedAt);
    }
    if (healthResult.error) setPosStatus("Status sinkronisasi tidak tersedia");
    else {
      const health = (healthResult.data ?? []) as PosHealth[];
      const latest = health
        .map((row) => row.last_successful_sync_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      setLastSyncAt(latest ?? null);
      setPosStatus(
        !health.length
          ? "Belum terhubung"
          : health.some((row) => row.status !== "healthy")
            ? "Perlu perhatian"
            : "Terhubung",
      );
    }
    } catch {
      setError(
        lastUpdatedRef.current
          ? "Pembaruan penjualan gagal. Tampilan ini memakai data terakhir."
          : "Penjualan tidak dapat dimuat. Data ini mungkin belum terbaru.",
      );
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [locationId, period]);
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 45_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const syncLabel = lastSyncAt
    ? `Terakhir sinkronisasi ${new Date(lastSyncAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
    : "Belum ada sinkronisasi berhasil";
  const refreshLabel = lastUpdatedAt
    ? `Diperbarui ${lastUpdatedAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
    : "Belum diperbarui";
  const summary = useMemo(
    () =>
      rollups.reduce(
        (value, row) => ({
          cups: value.cups + row.cups,
          revenue: value.revenue + row.revenue,
          cogs: value.cogs + Number(row.cogs),
          cash: value.cash + row.cash,
          qris: value.qris + row.qris,
        }),
        { cups: 0, revenue: 0, cogs: 0, cash: 0, qris: 0 },
      ),
    [rollups],
  );
  const chart = useMemo(
    () => rollups.map((row) => ({
      label: period === "day"
        ? `${row.bucket.slice(11, 13)}.00`
        : new Date(`${row.bucket}T00:00:00`).toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "short",
          }),
      value: row.revenue,
    })),
    [period, rollups],
  );
  const max = Math.max(1, ...chart.map((entry) => entry.value));
  const periodLabel = period === "day" ? "hari ini" : period === "week" ? "7 hari" : "bulan ini";
  return (
    <div className={styles.wrap}>
      {error ? (
        <div className={styles.empty} role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      ) : null}
      <div className={styles.liveBar} aria-live="polite">
        <span className={error ? styles.liveStale : styles.liveDot} />
        <span>{error ? "Data terakhir" : "Penjualan langsung"}</span>
        <small>{refreshLabel} · {syncLabel}</small>
        <button type="button" onClick={() => void load(true)} disabled={loading || refreshing}>
          {refreshing ? "Memuat…" : "Muat ulang"}
        </button>
      </div>
      <div className={styles.periods} aria-label="Periode laporan">
        {(["day", "week", "month"] as Period[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
          >
            {value === "day" ? "Harian" : value === "week" ? "Mingguan" : "Bulanan"}
          </button>
        ))}
      </div>
      <section className={styles.metrics}>
        <article className={styles.metric}>
          <span>OMZET · {periodLabel.toUpperCase()}</span>
          <strong>{loading ? "—" : money.format(summary.revenue)}</strong>
        </article>
        <article className={styles.metric}>
          <span>CUP · {periodLabel.toUpperCase()}</span>
          <strong>{loading ? "—" : summary.cups}</strong>
        </article>
        <article className={styles.metric}>
          <span>COGS TERJUAL</span>
          <strong>{loading ? "—" : money.format(summary.cogs)}</strong>
        </article>
        <article className={styles.metric}>
          <span>LABA KOTOR</span>
          <strong>
            {loading ? "—" : money.format(summary.revenue - summary.cogs)}
          </strong>
        </article>
      </section>
      <section className={styles.grid}>
        <article className={styles.panel}>
          <h2>{period === "day" ? "Penjualan per jam" : "Penjualan per hari"}</h2>
          <div className={styles.sub}>
            Ringkasan transaksi yang sudah diproses untuk {periodLabel}.
          </div>
          <div className={styles.chart}>
            {chart.map((entry) => (
              <div className={styles.barGroup} key={entry.label}>
                <span
                  className={styles.bar}
                  style={{
                    height: `${Math.max(2, (entry.value / max) * 155)}px`,
                  }}
                />
                <small>{entry.label}</small>
              </div>
            ))}
            {!loading && !chart.length ? <div className={styles.chartEmpty}>Belum ada data.</div> : null}
          </div>
        </article>
        <article className={styles.panel}>
          <h2>Metode pembayaran</h2>
          <div className={styles.sub}>
            Tunai dan QRIS berdasarkan transaksi valid.
          </div>
          <div className={styles.mix}>
            <div className={styles.mixRow}>
              <span>Tunai</span>
              <strong>{money.format(summary.cash)}</strong>
            </div>
            <div className={styles.mixRow}>
              <span>QRIS</span>
              <strong>{money.format(summary.qris)}</strong>
            </div>
            <div className={styles.mixRow}>
              <span>Loyverse</span>
              <span className={styles.status}>{posStatus}</span>
            </div>
            <div className={styles.mixRow}>
              <span>Sinkronisasi</span>
              <strong>{syncLabel}</strong>
            </div>
          </div>
        </article>
      </section>
      <article className={styles.panel}>
        <h2>{master ? "Transaksi seluruh lokasi" : "Transaksi terbaru"} · {periodLabel}</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>WAKTU</th>
                {master ? <th>LOKASI</th> : null}
                <th>PRODUK</th>
                <th>CUP</th>
                <th>PEMBAYARAN</th>
                <th>OMZET</th>
                <th>COGS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {period === "day"
                      ? new Date(row.occurred_at).toLocaleTimeString("id-ID", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : new Date(row.occurred_at).toLocaleString("id-ID", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                  </td>
                  {master ? <td>{row.locations?.code ?? "—"}</td> : null}
                  <td>{row.recipes?.name ?? "Produk"}</td>
                  <td>{row.quantity}</td>
                  <td>
                    {row.payment_method.replaceAll("_", " ").toUpperCase()}
                  </td>
                  <td>{money.format(row.total)}</td>
                  <td>{money.format(row.cogs)}</td>
                </tr>
              ))}
              {!loading && !rows.length ? (
                <tr>
                  <td colSpan={master ? 7 : 6}>
                    <div className={styles.empty}>
                      Belum ada penjualan untuk {periodLabel}.
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}

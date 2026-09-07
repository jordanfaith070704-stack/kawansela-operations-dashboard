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

const indonesiaOffsetHours: Record<string, number> = {
  "Asia/Jakarta": 7,
  "Asia/Makassar": 8,
  "Asia/Jayapura": 9,
};

function periodStart(period: Period, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let year = Number(value.year);
  let month = Number(value.month) - 1;
  let day = Number(value.day);
  if (period === "week") day -= 6;
  if (period === "month") day = 1;
  const offsetHours = indonesiaOffsetHours[timeZone] ?? 7;
  return new Date(Date.UTC(year, month, day, -offsetHours));
}

function safeDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatSaleTime(value: string, period: Period, timeZone: string) {
  const date = safeDate(value);
  if (!date) return "—";
  return period === "day"
    ? date.toLocaleTimeString("id-ID", { timeZone, hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("id-ID", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function fallbackRollups(rows: Sale[], period: Period, timeZone: string): Rollup[] {
  const groups = new Map<string, Rollup>();
  for (const sale of rows) {
    const date = safeDate(sale.occurred_at);
    if (!date) continue;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        ...(period === "day" ? { hour: "2-digit", hourCycle: "h23" } : {}),
      }).formatToParts(date).map((part) => [part.type, part.value]),
    );
    const bucket = period === "day"
      ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00`
      : `${parts.year}-${parts.month}-${parts.day}`;
    const entry = groups.get(bucket) ?? { bucket, revenue: 0, cogs: 0, cups: 0, cash: 0, qris: 0 };
    entry.revenue += Number(sale.total);
    entry.cogs += Number(sale.cogs);
    entry.cups += Number(sale.quantity);
    if (sale.payment_method === "cash") entry.cash += Number(sale.total);
    if (sale.payment_method === "qris_static" || sale.payment_method === "qris_provider") entry.qris += Number(sale.total);
    groups.set(bucket, entry);
  }
  return [...groups.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export function SalesView({
  locationId,
  master = false,
  autoSync = true,
}: {
  locationId: string | null;
  master?: boolean;
  /** Set false when the enclosing screen already owns the location sync. */
  autoSync?: boolean;
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
  const [displayTimeZone, setDisplayTimeZone] = useState("Asia/Jakarta");
  const lastUpdatedRef = useRef<Date | null>(null);
  const inFlightRef = useRef(false);
  const load = useCallback(async (quiet = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    const db = createClient();
    let reportTimeZone = "Asia/Jakarta";
    if (locationId) {
      const { data: location } = await db
        .from("locations")
        .select("timezone")
        .eq("id", locationId)
        .maybeSingle();
      reportTimeZone = location?.timezone ?? reportTimeZone;
    }
    setDisplayTimeZone(reportTimeZone);
    const start = periodStart(period, reportTimeZone);
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
    if (autoSync && master && !locationId) {
      const { data: activeConnections } = await db
        .from("pos_connections")
        .select("location_id")
        .eq("provider", "loyverse")
        .eq("is_active", true);
      const locationIds = [...new Set((activeConnections ?? []).map((connection) => connection.location_id))];
      await Promise.all(
        locationIds.map((activeLocationId) =>
          fetch("/api/loyverse/sync", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ locationId: activeLocationId }),
          }),
        ),
      );
    } else if (autoSync && locationId) {
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
    if (salesResult.error) {
      setError(
        lastUpdatedRef.current
          ? "Pembaruan penjualan gagal. Tampilan ini memakai data terakhir."
          : "Penjualan tidak dapat dimuat. Data ini mungkin belum terbaru.",
      );
    } else {
      const salesRows = (salesResult.data ?? []) as unknown as Sale[];
      setRows(salesRows);
      setRollups(rollupResult.error
        ? fallbackRollups(salesRows, period, reportTimeZone)
        : ((rollupResult.data ?? []) as Rollup[]).map((row) => ({
          ...row,
          revenue: Number(row.revenue),
          cogs: Number(row.cogs),
          cups: Number(row.cups),
          cash: Number(row.cash),
          qris: Number(row.qris),
        })));
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
  }, [autoSync, locationId, master, period]);
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 45_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const lastSyncDate = safeDate(lastSyncAt);
  const syncLabel = lastSyncDate
    ? `Terakhir sinkronisasi ${lastSyncDate.toLocaleTimeString("id-ID", { timeZone: displayTimeZone, hour: "2-digit", minute: "2-digit" })}`
    : "Belum ada sinkronisasi berhasil";
  const refreshLabel = lastUpdatedAt
    ? `Diperbarui ${lastUpdatedAt.toLocaleTimeString("id-ID", { timeZone: displayTimeZone, hour: "2-digit", minute: "2-digit" })}`
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
        : (() => {
            const date = safeDate(row.bucket.includes("T") ? row.bucket : `${row.bucket}T00:00:00`);
            return date ? date.toLocaleDateString("id-ID", { timeZone: displayTimeZone, day: "2-digit", month: "short" }) : "—";
          })(),
      value: row.revenue,
    })),
    [displayTimeZone, period, rollups],
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
                    {formatSaleTime(row.occurred_at, period, displayTimeZone)}
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

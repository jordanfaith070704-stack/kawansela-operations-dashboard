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
type ProductRecap = {
  product_name: string;
  cups: number;
  revenue: number;
  previous_cups: number;
  previous_revenue: number;
};
type CartPerformance = {
  location_id: string;
  location_code: string;
  location_name: string;
  cups: number;
  revenue: number;
  previous_revenue: number;
  active_days: number;
};
const money = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});
const compactMoney = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  notation: "compact",
  maximumFractionDigits: 1,
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
  const [productRecap, setProductRecap] = useState<ProductRecap[]>([]);
  const [recapError, setRecapError] = useState(false);
  const [cartPerformance, setCartPerformance] = useState<CartPerformance[]>([]);
  const [cartPerformanceError, setCartPerformanceError] = useState(false);
  const [displayTimeZone, setDisplayTimeZone] = useState("Asia/Jakarta");
  const lastUpdatedRef = useRef<Date | null>(null);
  const requestIdRef = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const requestId = ++requestIdRef.current;
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
    if (requestId !== requestIdRef.current) return;
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
    const [salesResult, healthResult, rollupResult, productResult, cartPerformanceResult] = await Promise.all([
      query,
      db.rpc("get_pos_health", { p_location_id: locationId }),
      db.rpc("get_sales_rollup", { p_location_id: locationId, p_period: period }),
      period === "day"
        ? Promise.resolve({ data: [], error: null })
        : db.rpc("get_sales_product_recap", { p_location_id: locationId, p_period: period }),
      period === "day" || !master
        ? Promise.resolve({ data: [], error: null })
        : db.rpc("get_cart_sales_performance", { p_period: period }),
    ]);
    if (requestId !== requestIdRef.current) return;
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
      setProductRecap(
        productResult.error
          ? []
          : ((productResult.data ?? []) as ProductRecap[]).map((row) => ({
              ...row,
              cups: Number(row.cups),
              revenue: Number(row.revenue),
              previous_cups: Number(row.previous_cups),
              previous_revenue: Number(row.previous_revenue),
            })),
      );
      setRecapError(Boolean(productResult.error));
      setCartPerformance(
        cartPerformanceResult.error
          ? []
          : ((cartPerformanceResult.data ?? []) as CartPerformance[]).map((row) => ({
              ...row,
              cups: Number(row.cups),
              revenue: Number(row.revenue),
              previous_revenue: Number(row.previous_revenue),
              active_days: Number(row.active_days),
            })),
      );
      setCartPerformanceError(Boolean(cartPerformanceResult.error));
      const updatedAt = new Date();
      lastUpdatedRef.current = updatedAt;
      setLastUpdatedAt(updatedAt);
      setError("");
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
      if (requestId !== requestIdRef.current) return;
      setError(
        lastUpdatedRef.current
          ? "Pembaruan penjualan gagal. Tampilan ini memakai data terakhir."
          : "Penjualan tidak dapat dimuat. Data ini mungkin belum terbaru.",
      );
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [autoSync, locationId, master, period]);
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, period === "day" ? 15_000 : 60_000);
    return () => window.clearInterval(interval);
  }, [load, period]);

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
      cups: row.cups,
    })),
    [displayTimeZone, period, rollups],
  );
  const max = Math.max(1, ...chart.map((entry) => entry.value));
  const periodLabel = period === "day" ? "hari ini" : period === "week" ? "7 hari" : "bulan ini";
  const topProducts = productRecap.filter((product) => product.cups > 0).slice(0, 5);
  const currentProductCups = productRecap.reduce((total, product) => total + product.cups, 0);
  const currentProductRevenue = productRecap.reduce((total, product) => total + product.revenue, 0);
  const previousRevenue = productRecap.reduce((total, product) => total + product.previous_revenue, 0);
  const revenueTrend = previousRevenue > 0
    ? ((currentProductRevenue - previousRevenue) / previousRevenue) * 100
    : currentProductRevenue > 0 ? null : 0;
  const bestDay = period === "day" || !chart.length
    ? null
    : chart.reduce((best, entry) => entry.value > best.value ? entry : best, chart[0]);
  const minimumActiveDays = period === "week" ? 2 : 5;
  const qualifiedCartDailyRevenue = cartPerformance
    .filter((cart) => cart.active_days >= minimumActiveDays)
    .map((cart) => cart.revenue / cart.active_days)
    .sort((a, b) => a - b);
  const medianCartDailyRevenue = qualifiedCartDailyRevenue.length
    ? qualifiedCartDailyRevenue.length % 2
      ? qualifiedCartDailyRevenue[Math.floor(qualifiedCartDailyRevenue.length / 2)]
      : (qualifiedCartDailyRevenue[qualifiedCartDailyRevenue.length / 2 - 1] + qualifiedCartDailyRevenue[qualifiedCartDailyRevenue.length / 2]) / 2
    : 0;
  const maxCartRevenue = Math.max(1, ...cartPerformance.map((cart) => cart.revenue));
  const visibleCartPerformance = cartPerformance.length <= 6
    ? cartPerformance
    : [...cartPerformance.slice(0, 3), ...cartPerformance.slice(-3)];
  const productPalette = ["#111", "#4c4c48", "#777771", "#a4a49d", "#c9c9c1"];
  let productShareCursor = 0;
  const productDonut = topProducts.length
    ? `conic-gradient(${[
        ...topProducts.map((product, index) => {
          const start = productShareCursor;
          productShareCursor += currentProductCups ? (product.cups / currentProductCups) * 100 : 0;
          return `${productPalette[index]} ${start}% ${productShareCursor}%`;
        }),
        `#ecece8 ${productShareCursor}% 100%`,
      ].join(", ")})`
    : "#ecece8";
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
          <div className={styles.chartHead}>
            <div>
              <h2>{period === "day" ? "Penjualan per jam" : "Penjualan per hari"}</h2>
              <div className={styles.sub}>
                Hanya waktu yang memiliki transaksi.
              </div>
            </div>
            {!loading && chart.length ? (
              <span className={styles.chartCount}>
                {chart.length} {period === "day" ? "jam" : "hari"} aktif
              </span>
            ) : null}
          </div>
          {loading ? (
            <div className={styles.chartEmpty}>Memuat penjualan…</div>
          ) : chart.length ? (
            <div className={styles.chartViewport}>
              <div className={styles.chart}>
                {chart.map((entry) => (
                  <div className={styles.barGroup} key={entry.label}>
                    <strong>{compactMoney.format(entry.value)}</strong>
                    <span
                      className={styles.bar}
                      style={{
                        height: `${Math.max(14, (entry.value / max) * 128)}px`,
                      }}
                      title={`${entry.label} · ${money.format(entry.value)} · ${entry.cups} cup`}
                    />
                    <small>{entry.label}</small>
                    <em>{entry.cups} cup</em>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.chartEmpty}>
              <strong>Belum ada penjualan</strong>
              <span>Grafik akan muncul setelah transaksi pertama masuk.</span>
            </div>
          )}
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
      {period !== "day" ? (
        <section className={styles.recapGrid}>
          <article className={styles.panel}>
            <div className={styles.chartHead}>
              <div>
                <h2>Produk terlaris</h2>
                <div className={styles.sub}>Berdasarkan jumlah cup · {periodLabel}</div>
              </div>
              {topProducts.length ? <span className={styles.chartCount}>{topProducts.length} PRODUK</span> : null}
            </div>
            {loading ? (
              <div className={styles.recapEmpty}>Memuat produk…</div>
            ) : recapError ? (
              <div className={styles.recapEmpty}>Recap produk belum dapat dimuat.</div>
            ) : topProducts.length ? (
              <div className={styles.productRecapBody}>
                <div
                  className={styles.donut}
                  style={{ background: productDonut }}
                  role="img"
                  aria-label={`Komposisi ${topProducts.map((product) => `${product.product_name} ${product.cups} cup`).join(", ")}`}
                >
                  <div><strong>{currentProductCups}</strong><span>CUP BERSIH</span></div>
                </div>
                <div className={styles.productList}>
                  {topProducts.map((product, index) => {
                    const share = currentProductCups ? (product.cups / currentProductCups) * 100 : 0;
                    return (
                      <div className={styles.productRow} key={product.product_name}>
                        <span className={styles.productDot} style={{ background: productPalette[index] }} />
                        <div className={styles.productInfo}>
                          <div><strong>{product.product_name}</strong><span>{product.cups} cup · {money.format(product.revenue)}</span></div>
                          <div className={styles.productTrack}><span style={{ width: `${share}%` }} /></div>
                        </div>
                        <b>{share.toFixed(0)}%</b>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className={styles.recapEmpty}>Belum ada produk terjual untuk {periodLabel}.</div>
            )}
          </article>
          <article className={styles.panel}>
            <h2>Ringkasan tren</h2>
            <div className={styles.sub}>Dibanding periode sebelumnya pada durasi yang sama.</div>
            <div className={styles.trendList}>
              <div>
                <span>PERUBAHAN OMZET</span>
                <strong className={revenueTrend !== null && revenueTrend < 0 ? styles.trendDown : styles.trendUp}>
                  {loading ? "—" : revenueTrend === null ? "Baru" : `${revenueTrend >= 0 ? "+" : ""}${revenueTrend.toFixed(0)}%`}
                </strong>
                <small>Omzet bersih sebelumnya {money.format(previousRevenue)}</small>
              </div>
              <div>
                <span>HARI TERBAIK</span>
                <strong>{loading ? "—" : bestDay?.label ?? "Belum ada"}</strong>
                <small>{bestDay ? `${bestDay.cups} cup · ${money.format(bestDay.value)}` : "Menunggu transaksi"}</small>
              </div>
            </div>
          </article>
        </section>
      ) : null}
      {master && period !== "day" ? (
        <article className={styles.panel}>
          <div className={styles.chartHead}>
            <div>
              <h2>Performa cart</h2>
              <div className={styles.sub}>Perbandingan seluruh cart aktif · {periodLabel}</div>
            </div>
            {!loading && qualifiedCartDailyRevenue.length ? <span className={styles.chartCount}>MEDIAN/HARI {compactMoney.format(medianCartDailyRevenue)}</span> : null}
          </div>
          {loading ? (
            <div className={styles.recapEmpty}>Memuat performa cart…</div>
          ) : cartPerformanceError ? (
            <div className={styles.recapEmpty}>Performa cart belum dapat dimuat.</div>
          ) : cartPerformance.length ? (
            <div className={styles.cartList}>
              {visibleCartPerformance.map((cart) => {
                const rank = cartPerformance.findIndex((item) => item.location_id === cart.location_id) + 1;
                const dailyRevenue = cart.active_days ? cart.revenue / cart.active_days : 0;
                const comparedToMedian = medianCartDailyRevenue ? dailyRevenue / medianCartDailyRevenue : 0;
                const status = cart.active_days < minimumActiveDays
                  ? "Data belum cukup"
                  : comparedToMedian >= 1.2
                    ? "Di atas median"
                    : comparedToMedian < 0.7
                      ? "Perlu perhatian"
                      : "Stabil";
                const trend = cart.previous_revenue > 0
                  ? ((cart.revenue - cart.previous_revenue) / cart.previous_revenue) * 100
                  : cart.revenue > 0 ? null : 0;
                return (
                  <div className={styles.cartRow} key={cart.location_id}>
                    <span className={styles.productRank}>{rank}</span>
                    <div className={styles.cartInfo}>
                      <div><strong>{cart.location_code} · {cart.location_name}</strong><span>{cart.cups} cup</span></div>
                      <div className={styles.productTrack}><span style={{ width: `${(cart.revenue / maxCartRevenue) * 100}%` }} /></div>
                    </div>
                    <div className={styles.cartRevenue}><strong>{money.format(cart.revenue)}</strong><small>{cart.active_days} hari aktif · {trend === null ? "baru" : `${trend >= 0 ? "+" : ""}${trend.toFixed(0)}%`}</small></div>
                    <span className={`${styles.performanceStatus} ${status === "Perlu perhatian" || status === "Data belum cukup" ? styles.performanceLow : ""}`}>{status}</span>
                  </div>
                );
              })}
              {cartPerformance.length > 6 ? <div className={styles.cartSummary}>Menampilkan 3 cart teratas dan 3 cart terbawah dari {cartPerformance.length} cart aktif.</div> : null}
            </div>
          ) : (
            <div className={styles.recapEmpty}>Belum ada cart aktif untuk dibandingkan.</div>
          )}
        </article>
      ) : null}
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

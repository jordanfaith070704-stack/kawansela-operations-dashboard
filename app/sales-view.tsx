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
  external_id: string | null;
  recipes: { name: string } | null;
  locations: { code: string } | null;
};
type PosHealth = {
  status: string;
  last_successful_sync_at: string | null;
};
type ReceiptGroup = {
  key: string;
  reference: string | null;
  rows: Sale[];
};
type ReceiptException = {
  id: string;
  external_receipt_id: string;
  event_kind: "sale" | "refund" | "void";
  received_at: string;
  processed_at: string | null;
  processing_error: string | null;
  pos_connections: { location_id: string; locations: { code: string; name: string } | null } | null;
};
type ConnectionIssue = {
  location_id: string;
  code: string;
  message: string;
  status: string;
  lastSuccessfulSyncAt: string | null;
};
type IssuesResponse = {
  pendingCount: number;
  issueCount: number;
  issues: ReceiptException[];
  connectionIssues?: ConnectionIssue[];
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

function receiptIdentity(sale: Sale) {
  // Only the current importer guarantees this format. Never infer a receipt
  // from a product name or timestamp: different customers can share either.
  const match = sale.external_id?.match(/^(.+):receipt:(.+):line:.+$/);
  return match
    ? { key: `${match[1]}:receipt:${match[2]}`, reference: match[2] }
    : { key: sale.id, reference: null };
}

function paymentLabel(method: string) {
  if (method === "cash") return "Tunai";
  if (method === "qris_static" || method === "qris_provider") return "QRIS";
  return "Lainnya / gabungan";
}

function exceptionLabel(issue: ReceiptException) {
  if (issue.event_kind === "refund") return { title: "Refund perlu diperiksa", detail: "Cocokkan pengembalian uang dan kondisi minuman bersama admin." };
  if (issue.event_kind === "void") return { title: "Pembatalan perlu diperiksa", detail: "Admin perlu memeriksa pembatalan struk dan pemakaian stok." };
  const error = issue.processing_error?.toLocaleLowerCase("id-ID") ?? "";
  if (/pembayaran|payment/.test(error)) return { title: "Pembayaran perlu dicocokkan", detail: "Periksa pembagian tunai dan QRIS pada struk bersama admin." };
  if (/petakan|pemetaan|mapping/.test(error)) return { title: "Menu belum terhubung", detail: "Admin perlu mencocokkan menu Loyverse dengan resep Kawansela." };
  if (/stok|stock|batch|inventory|fifo/.test(error)) return { title: "Stok perlu diperiksa", detail: "Cocokkan waktu produksi, sisa minuman, dan kemasan dengan admin." };
  return { title: "Struk belum selesai diimpor", detail: "Muat ulang, lalu hubungi admin jika struk ini tetap tertunda." };
}

export function SalesView({
  locationId,
  master = false,
  autoSync = true,
  onOpenCart,
}: {
  locationId: string | null;
  master?: boolean;
  /** Set false when the enclosing screen already owns the location sync. */
  autoSync?: boolean;
  onOpenCart?: (locationId: string) => void;
}) {
  const [rows, setRows] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [pendingReceipts, setPendingReceipts] = useState<number | null>(null);
  const [exceptions, setExceptions] = useState<ReceiptException[]>([]);
  const [exceptionCount, setExceptionCount] = useState<number | null>(null);
  const [exceptionError, setExceptionError] = useState(false);
  const [connectionIssues, setConnectionIssues] = useState<ConnectionIssue[]>([]);
  const [issueFeedback, setIssueFeedback] = useState("");
  const [totalsUnavailable, setTotalsUnavailable] = useState(false);
  const [historyLimited, setHistoryLimited] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [showInsights, setShowInsights] = useState(master);
  const [posStatus, setPosStatus] = useState("Memuat status");
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [period, setPeriod] = useState<Period>("day");
  const [rollups, setRollups] = useState<Rollup[]>([]);
  const [productRecap, setProductRecap] = useState<ProductRecap[]>([]);
  const [recapError, setRecapError] = useState(false);
  const [cartPerformance, setCartPerformance] = useState<CartPerformance[]>([]);
  const [cartPerformanceError, setCartPerformanceError] = useState(false);
  const [showTransactions, setShowTransactions] = useState(!master);
  const [displayTimeZone, setDisplayTimeZone] = useState("Asia/Jakarta");
  const lastUpdatedRef = useRef<Date | null>(null);
  const requestIdRef = useRef(0);
  const load = useCallback(async (quiet = false, refreshOnly = false): Promise<void> => {
    const requestId = ++requestIdRef.current;
    if (quiet) setRefreshing(true);
    else {
      setLoading(true);
      setRows([]);
      setRollups([]);
      setTotalsUnavailable(true);
      setLastUpdatedAt(null);
      setExceptions([]);
      setExceptionCount(null);
      setExceptionError(false);
      setConnectionIssues([]);
      setPendingReceipts(null);
      lastUpdatedRef.current = null;
    }
    setError("");
    try {
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
        "id,external_id,quantity,total,cogs,payment_method,occurred_at,source,recipes(name),locations(code)",
      )
      .gte("occurred_at", start.toISOString())
      .order("occurred_at", { ascending: false })
      .order("external_id", { ascending: false })
      .limit(101);
    if (locationId) query = query.eq("location_id", locationId);
    const syncProblems: string[] = [];
    let importedSales = false;
    const syncLocation = async (activeLocationId: string) => {
      try {
        const response = await fetch("/api/loyverse/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locationId: activeLocationId }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) syncProblems.push("Sinkronisasi Loyverse belum berhasil. Angka di bawah adalah data terakhir yang sudah tercatat.");
        else {
          const result = await response.json() as { processed?: number };
          importedSales ||= Number(result.processed ?? 0) > 0;
        }
      } catch {
        syncProblems.push("Loyverse belum dapat diperbarui. Periksa koneksi lalu coba lagi.");
      }
    };
    // Read saved sales immediately. Provider latency must never keep the phone
    // on a loading screen; a successful import triggers one read-only refresh.
    const syncTask = (async () => {
    if (autoSync && !refreshOnly && master && !locationId) {
      const { data: activeConnections, error: connectionError } = await db
        .from("pos_connections")
        .select("location_id")
        .eq("provider", "loyverse")
        .eq("is_active", true);
      const locationIds = [...new Set((activeConnections ?? []).map((connection) => connection.location_id))];
      if (connectionError) syncProblems.push("Daftar koneksi Loyverse belum dapat diperiksa.");
      await Promise.all(locationIds.map(syncLocation));
    } else if (autoSync && !refreshOnly && locationId) {
      // Pull only from the browser's own cart. The API validates the session
      // and performs the provider call on the server.
      await syncLocation(locationId);
    }
    })().catch(() => { syncProblems.push("Loyverse belum dapat diperbarui. Periksa koneksi lalu coba lagi."); });
    void syncTask.then(() => {
      if (requestId !== requestIdRef.current) return;
      if (!refreshOnly) setSyncError(syncProblems[0] ?? "");
      if (importedSales) void load(true, true);
    });
    // The server checks membership and returns only safe exception metadata.
    // Direct joins to POS connections can be hidden by operator RLS and must
    // never turn an inaccessible exception queue into an apparent zero count.
    const issuesTask: Promise<IssuesResponse | null> = fetch(`/api/loyverse/issues${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    }).then(async (response) => {
      if (!response.ok) return null;
      const result = await response.json() as IssuesResponse;
      if (!Number.isSafeInteger(result.pendingCount) || result.pendingCount < 0 || !Number.isSafeInteger(result.issueCount) || result.issueCount < 0 || !Array.isArray(result.issues)) return null;
      return result;
    }).catch(() => null);
    const [salesResult, healthResult, rollupResult, productResult, cartPerformanceResult, issuesResult] = await Promise.all([
      query,
      db.rpc("get_pos_health", { p_location_id: locationId }),
      db.rpc("get_sales_rollup", { p_location_id: locationId, p_period: period }),
      period === "day"
        ? Promise.resolve({ data: [], error: null })
        : db.rpc("get_sales_product_recap", { p_location_id: locationId, p_period: period }),
      period === "day" || !master
        ? Promise.resolve({ data: [], error: null })
        : db.rpc("get_cart_sales_performance", { p_period: period }),
      issuesTask,
    ]);
    if (requestId !== requestIdRef.current) return;
    setPendingReceipts(issuesResult?.pendingCount ?? null);
    setExceptionError(!issuesResult);
    setExceptionCount(issuesResult?.issueCount ?? null);
    setExceptions(issuesResult?.issues ?? []);
    setConnectionIssues(issuesResult?.connectionIssues ?? []);
    if (salesResult.error) {
      setError(
        lastUpdatedRef.current
          ? "Pembaruan penjualan gagal. Tampilan ini memakai data terakhir."
          : "Penjualan tidak dapat dimuat. Data ini mungkin belum terbaru.",
      );
    } else {
      const salesRows = (salesResult.data ?? []) as unknown as Sale[];
      setHistoryLimited(salesRows.length > 100);
      setRows(salesRows.slice(0, 100));
      setTotalsUnavailable(Boolean(rollupResult.error));
      setRollups(rollupResult.error
        ? []
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
    if (healthResult.error) {
      setPosStatus("Status sinkronisasi tidak tersedia");
      setLastSyncAt(null);
    }
    else {
      const health = (healthResult.data ?? []) as PosHealth[];
      // Across carts, the oldest successful sync is the useful freshness bound.
      const latest = health
        .map((row) => row.last_successful_sync_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(0);
      setLastSyncAt(health.some((row) => !row.last_successful_sync_at) ? null : (latest ?? null));
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
    return () => {
      window.clearInterval(interval);
      // Ignore reads and provider callbacks from the previous cart / period.
      requestIdRef.current += 1;
    };
  }, [load, period]);

  const lastSyncDate = safeDate(lastSyncAt);
  const syncLabel = lastSyncDate
    ? `Sinkronisasi ${master && !locationId ? "terlama " : ""}${lastSyncDate.toLocaleString("id-ID", { timeZone: displayTimeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
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
  const otherPayments = summary.revenue - summary.cash - summary.qris;
  const receiptGroups = useMemo(() => {
    const groups = new Map<string, ReceiptGroup>();
    for (const row of rows) {
      const identity = receiptIdentity(row);
      const group = groups.get(identity.key) ?? { ...identity, rows: [] };
      group.rows.push(row);
      groups.set(identity.key, group);
    }
    return [...groups.values()];
  }, [rows]);
  const filteredReceipts = useMemo(() => {
    const search = historySearch.trim().toLocaleLowerCase("id-ID");
    return receiptGroups.filter((receipt) => !search || [receipt.reference ?? "", ...receipt.rows.map((row) => row.recipes?.name ?? "")].join(" ").toLocaleLowerCase("id-ID").includes(search));
  }, [receiptGroups, historySearch]);
  const visibleReceipts = !master && !showAllHistory ? filteredReceipts.slice(0, 5) : filteredReceipts;
  const staleSync = !lastSyncDate || Date.now() - lastSyncDate.getTime() > 5 * 60_000;
  const needsAttention = Boolean(error || syncError || staleSync || posStatus !== "Terhubung" || pendingReceipts === null || pendingReceipts > 0 || exceptionError || exceptionCount === null || exceptionCount > 0 || connectionIssues.length > 0);
  const metricValue = (value: number, currency = true) => loading || totalsUnavailable ? "—" : currency ? money.format(value) : String(value);
  async function copyIssueForAdmin(issue: ReceiptException) {
    const label = exceptionLabel(issue);
    const message = `Mohon periksa struk Loyverse #${issue.external_receipt_id}. ${label.title}. Lokasi: ${issue.pos_connections?.locations?.name ?? issue.pos_connections?.locations?.code ?? "gerobak saya"}. Diterima: ${new Date(issue.received_at).toLocaleString("id-ID", { timeZone: displayTimeZone })}.`;
    try {
      await navigator.clipboard.writeText(message);
      setIssueFeedback(`Detail struk #${issue.external_receipt_id} disalin. Kirimkan kepada admin.`);
    } catch {
      setIssueFeedback(`Penyalinan otomatis belum tersedia. Salin nomor struk #${issue.external_receipt_id} dan hubungi admin.`);
    }
  }
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
  const productPalette = ["#52623e", "#dc6938", "#9caa7d", "#c8aa70", "#e1cdb0"];
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
  const historyPanel = showTransactions ? <article className={styles.panel}>
        <h2>{master ? "Riwayat seluruh lokasi" : "Struk & item terbaru"} · {periodLabel}</h2>
        <p className={styles.historyNote}>{historyLimited ? "Menampilkan 100 baris produk terbaru; riwayat ini belum lengkap." : `Menampilkan ${rows.length} baris produk yang sudah tercatat.`} Nilai kartu hanya mencakup item yang sudah diimpor.</p>
        <label className={styles.searchField}>Cari di daftar ini
          <input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Nomor struk atau nama minuman" />
        </label>
        <div className={`${styles.receiptCards} ${master ? styles.masterReceiptCards : ""}`}>
          {loading ? <p className={styles.empty}>Memuat riwayat penjualan…</p> : visibleReceipts.length ? visibleReceipts.map((receipt) => {
            const total = receipt.rows.reduce((sum, row) => sum + Number(row.total), 0);
            const cups = receipt.rows.reduce((sum, row) => sum + Number(row.quantity), 0);
            const methods = [...new Set(receipt.rows.map((row) => paymentLabel(row.payment_method)))];
            return <details className={styles.receiptCard} key={receipt.key}>
              <summary>
                <span className={styles.receiptIdentity}><strong>{receipt.reference ? `Struk #${receipt.reference}` : "Baris produk"}</strong><small>{formatSaleTime(receipt.rows[0].occurred_at, period, displayTimeZone)}{master ? ` · ${receipt.rows[0].locations?.code ?? "Lokasi"}` : ""}</small></span>
                <span className={styles.receiptAmount}><strong>{money.format(total)}</strong><small>{cups} gelas tercatat</small></span>
              </summary>
              <div className={styles.receiptBody}>
                <p className={styles.paymentBadge}>{methods.join(" · ")}</p>
                {receipt.rows.map((row) => <div className={styles.receiptLine} key={row.id}><span>{row.quantity} × {row.recipes?.name ?? "Produk"}{Number(row.total) === 0 ? <small>Nilai Rp0 · cek promo di Loyverse</small> : null}</span><strong>{money.format(Number(row.total))}</strong></div>)}
                <p className={styles.historyNote}>Nilai item tercatat. {receipt.reference ? "Cocokkan dengan struk Loyverse untuk jumlah lengkap." : "Nomor struk belum dikenali; baris ini tidak dihitung sebagai satu struk."}</p>
              </div>
            </details>;
          }) : <p className={styles.empty}>{rows.length ? "Tidak ada hasil dalam daftar ini." : error ? "Riwayat belum tersedia. Coba muat ulang." : "Belum ada item penjualan yang diimpor untuk periode ini."}</p>}
        </div>
        {!master && filteredReceipts.length > 5 ? <button type="button" className={styles.moreHistory} onClick={() => setShowAllHistory((open) => !open)}>{showAllHistory ? "Ringkas daftar" : "Lihat lebih banyak"}</button> : null}
        {master ? <div className={styles.tableWrap}>
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
              {filteredReceipts.flatMap((receipt) => receipt.rows).map((row) => (
                <tr key={row.id}>
                  <td>
                    {formatSaleTime(row.occurred_at, period, displayTimeZone)}
                  </td>
                  {master ? <td>{row.locations?.code ?? "—"}</td> : null}
                  <td>{row.recipes?.name ?? "Produk"}</td>
                  <td>{row.quantity}</td>
                  <td>
                    {paymentLabel(row.payment_method)}
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
        </div> : null}
      </article> : null;
  const periodControls = (<div className={styles.periods} aria-label="Periode laporan">
        {(["day", "week", "month"] as Period[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
          >
            {value === "day" ? "Hari ini" : value === "week" ? "7 hari" : "Bulan ini"}
          </button>
        ))}
      </div>);
  const salesMetrics = (<section className={styles.metrics}>
        <article className={styles.metric}>
          <span>OMZET TERCATAT · {periodLabel.toUpperCase()}</span>
          <strong>{metricValue(summary.revenue)}</strong>
        </article>
        <article className={styles.metric}>
          <span>GELAS TERCATAT · {periodLabel.toUpperCase()}</span>
          <strong>{metricValue(summary.cups, false)}</strong>
        </article>
        {master ? <article className={styles.metric}>
          <span>COGS TERJUAL</span>
          <strong>{metricValue(summary.cogs)}</strong>
        </article> : null}
        {master ? <article className={styles.metric}>
          <span>LABA KOTOR</span>
          <strong>
            {metricValue(summary.revenue - summary.cogs)}
          </strong>
        </article> : null}
        {!master ? <article className={styles.metric}><span>TUNAI</span><strong>{metricValue(summary.cash)}</strong></article> : null}
        {!master ? <article className={styles.metric}><span>QRIS</span><strong>{metricValue(summary.qris)}</strong></article> : null}
      </section>);
  return (
    <div className={`${styles.wrap} ${!master ? styles.operatorWrap : ""}`}>
      {periodControls}
      {salesMetrics}
      {!master ? <p className={styles.summaryCaption}>{loading ? "Memuat angka tercatat…" : totalsUnavailable ? "Total lengkap belum tersedia." : needsAttention ? "Angka terakhir tercatat · ada pembaruan yang perlu diperiksa." : "Dari struk yang sudah diimpor."}</p> : null}
      {!master && !loading && !totalsUnavailable && otherPayments !== 0 ? <p className={styles.warning}><strong>Lainnya / gabungan: {money.format(otherPayments)}.</strong> Hubungi admin untuk mencocokkan pembayaran sebelum tutup hari.</p> : null}
      {!master ? historyPanel : null}
      <section className={styles.exceptionInbox} aria-label="Struk perlu diperiksa">
        <div className={styles.exceptionHeading}><h2>Perlu diperiksa</h2><span className={styles.issueCount}>{exceptionCount === null ? "—" : exceptionCount + connectionIssues.length}</span></div>
        {connectionIssues.map((connection) => <div className={styles.warning} key={connection.location_id}><strong>Loyverse{master ? ` · ${connection.code}` : ""}</strong><p>{connection.message}</p>{connection.lastSuccessfulSyncAt ? <small>Terakhir berhasil: {formatSaleTime(connection.lastSuccessfulSyncAt, "week", displayTimeZone)}</small> : null}<p>Hubungi admin untuk memeriksa koneksi ini.</p></div>)}
        {loading ? <p className={styles.historyNote}>Memeriksa struk tertunda…</p> : exceptionError || exceptionCount === null ? <p className={styles.warning}>Daftar belum dapat dimuat. Muat ulang sebelum tutup hari.</p> : exceptionCount === 0 ? <p className={styles.historyNote}>Tidak ada peringatan struk yang tercatat.</p> : <>
          <p className={styles.historyNote}>Hubungi admin untuk menyelesaikan struk berikut.</p>
          <div className={styles.exceptionList}>{exceptions.map((issue) => {
            const label = exceptionLabel(issue);
            return <article className={styles.exceptionItem} key={issue.id}>
              <div className={styles.issueReference}><strong>Struk #{issue.external_receipt_id}</strong><small>{formatSaleTime(issue.received_at, "week", displayTimeZone)}{master ? ` · ${issue.pos_connections?.locations?.code ?? "Lokasi"}` : ""}</small></div>
              <span className={styles.issueLabel}>{label.title}</span>
              <p>{label.detail}</p>
              <div className={styles.issueAction}><strong>Hubungi admin</strong><button type="button" onClick={() => void copyIssueForAdmin(issue)}>Salin detail</button></div>
            </article>;
          })}</div>
          {(exceptionCount ?? 0) > exceptions.length ? <p className={styles.historyNote}>Menampilkan {exceptions.length} dari {exceptionCount} kejadian tertua. Admin dapat memeriksa daftar lengkap.</p> : null}
        </>}
        <p role="status" className={styles.historyNote}>{issueFeedback}</p>
      </section>
      {error ? (
        <div className={styles.empty} role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      ) : null}
      <div className={styles.liveBar} aria-live="polite">
        <span className={needsAttention ? styles.liveStale : styles.liveDot} aria-hidden="true" />
        <div className={styles.freshness}><strong>{loading ? "Memeriksa penjualan…" : needsAttention ? "Periksa pembaruan data" : "Data impor Loyverse"}</strong>
          <small>{syncLabel} · {refreshLabel}</small>
        </div>
        <button type="button" onClick={() => void load(true)} disabled={loading || refreshing}>
          {refreshing ? "Memuat…" : "Muat ulang"}
        </button>
      </div>
      {syncError ? <div className={styles.warning} role="status">{syncError}</div> : null}
      {!loading && staleSync ? <p className={styles.warning}>Sinkronisasi belum tersedia atau sudah lebih dari 5 menit. Angka dapat tertinggal dari Loyverse.</p> : null}
      {!loading && totalsUnavailable ? <div className={styles.warning} role="alert"><strong>Total periode belum tersedia.</strong> Daftar item terbaru tetap dapat dilihat. Total lengkap tidak dihitung dari daftar yang terbatas.</div> : null}
      {!master ? <section className={styles.operatorGuide} aria-label="Panduan Loyverse">
        <button type="button" className={styles.guideToggle} aria-expanded={guideOpen} aria-controls="loyverse-sales-guide" onClick={() => setGuideOpen((open) => !open)}>Panduan Loyverse <span aria-hidden="true">{guideOpen ? "−" : "+"}</span></button>
        <div id="loyverse-sales-guide" className={styles.guideSteps} hidden={!guideOpen}>
          <ol>
            <li><strong>Buka aplikasi Loyverse.</strong> Pilih gerai yang sesuai.</li>
            <li><strong>Pilih menu dan jumlah.</strong> Periksa stok dan total.</li>
            <li><strong>Konfirmasi pembayaran.</strong> Periksa dana QRIS masuk sebelum menyelesaikan struk.</li>
            <li><strong>Periksa hasil impor di sini.</strong> Jika terlambat, muat ulang atau hubungi admin. Jangan buat ulang struk.</li>
          </ol>
          <p>Minuman gratis dicatat memakai promo atau diskon yang disetujui di Loyverse agar stok tetap tercatat.</p>
        </div>
      </section> : null}

      {master && period === "day" ? (
        <button className={styles.recapHint} type="button" onClick={() => setPeriod("week")}>
          <span>Recap produk & tren tersedia</span>
          <strong>Lihat laporan mingguan</strong>
        </button>
      ) : null}

      <section className={styles.grid}>
        <article className={`${styles.panel} ${styles.chartPanel}`}>
          {!master ? <button type="button" className={styles.insightsToggle} aria-expanded={showInsights} aria-controls="sales-insights" onClick={() => setShowInsights((open) => !open)}>{showInsights ? "Tutup grafik & biaya" : "Lihat grafik & biaya"}</button> : null}
          <div id="sales-insights" hidden={!showInsights}>
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
          ) : totalsUnavailable ? <div className={styles.chartEmpty}>Grafik belum dapat dimuat. Total periode tidak tersedia.</div> : chart.length ? (
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
          {!master ? <div className={styles.costSummary}><span>Biaya pokok terjual <strong>{metricValue(summary.cogs)}</strong></span><span>Laba kotor <strong>{metricValue(summary.revenue - summary.cogs)}</strong></span><small>Laba kotor belum dikurangi biaya operasional.</small></div> : null}
          </div>
        </article>
        {master ? <article className={styles.panel}>
          <h2>Metode pembayaran</h2>
          <div className={styles.sub}>
            Nilai item yang sudah diimpor. Cocokkan QRIS dengan laporan penyedia.
          </div>
          <div className={styles.mix}>
            <div className={styles.mixRow}>
              <span>Tunai</span>
              <strong>{metricValue(summary.cash)}</strong>
            </div>
            <div className={styles.mixRow}>
              <span>QRIS</span>
              <strong>{metricValue(summary.qris)}</strong>
            </div>
            <div className={`${styles.mixRow} ${otherPayments !== 0 ? styles.paymentAttention : ""}`}>
              <span>Lainnya / gabungan</span>
              <strong>{metricValue(otherPayments)}</strong>
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
          {!loading && !totalsUnavailable && otherPayments !== 0 ? <p className={styles.warning}>Ada pembayaran yang belum dipisahkan ke tunai atau QRIS. Periksa bersama Master sebelum tutup hari.</p> : null}
        </article> : null}
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
                  <button className={styles.cartRow} key={cart.location_id} type="button" onClick={() => onOpenCart?.(cart.location_id)}>
                    <span className={styles.productRank}>{rank}</span>
                    <div className={styles.cartInfo}>
                      <div><strong>{cart.location_code} · {cart.location_name}</strong><span>{cart.cups} cup</span></div>
                      <div className={styles.productTrack}><span style={{ width: `${(cart.revenue / maxCartRevenue) * 100}%` }} /></div>
                    </div>
                    <div className={styles.cartRevenue}><strong>{money.format(cart.revenue)}</strong><small>{cart.active_days} hari aktif · {trend === null ? "baru" : `${trend >= 0 ? "+" : ""}${trend.toFixed(0)}%`}</small></div>
                    <span className={`${styles.performanceStatus} ${status === "Perlu perhatian" || status === "Data belum cukup" ? styles.performanceLow : ""}`}>{status}</span>
                    <span className={styles.cartOpen}>Buka gerobak</span>
                  </button>
                );
              })}
              {cartPerformance.length > 6 ? <div className={styles.cartSummary}>Menampilkan 3 cart teratas dan 3 cart terbawah dari {cartPerformance.length} cart aktif.</div> : null}
            </div>
          ) : (
            <div className={styles.recapEmpty}>Belum ada cart aktif untuk dibandingkan.</div>
          )}
        </article>
      ) : null}
      {master ? (
        <button className={styles.transactionToggle} type="button" aria-expanded={showTransactions} onClick={() => setShowTransactions((visible) => !visible)}>
          <span>Detail transaksi seluruh lokasi</span>
          <strong>{showTransactions ? "Tutup detail" : "Lihat transaksi"}</strong>
        </button>
      ) : null}
      {master ? historyPanel : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./operator-home.module.css";
import { OperatorCashDay } from "./operator-cash-day";

type Destination = "Penjualan" | "Produksi" | "Stok" | "Tutup Hari";
type Props = { locationId: string; onNavigate?: (view: Destination) => void };
type Batch = {
  id: string;
  remaining_ml: number;
  produced_at: string;
  use_by: string;
  status: string;
  recipe_versions: { recipes: { name: string } | null } | null;
};
type RawStock = {
  item_id: string;
  quantity: number;
  safety_stock: number;
  par_level: number;
  inventory_items: { name: string; unit: string; category: string } | null;
};
type Sales = { cups: number; revenue: number; cash: number; qris: number };
type Health = { provider: string; status: string; last_successful_sync_at: string | null };
type LoadErrors = { sales: boolean; batches: boolean; stock: boolean; health: boolean };
const noErrors: LoadErrors = { sales: false, batches: false, stock: false, health: false };
const rupiah = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
function time(value: string | number) {
  return new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " WIB";
}

export function OperatorHome({ locationId, onNavigate }: Props) {
  const [sales, setSales] = useState<Sales | null>(null);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [rawStock, setRawStock] = useState<RawStock[] | null>(null);
  const [health, setHealth] = useState<Health[] | null>(null);
  const [errors, setErrors] = useState<LoadErrors>(noErrors);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [readAt, setReadAt] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const syncingRef = useRef(false);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    setRefreshing(true);
    setNow(Date.now());
    try {
      const db = createClient();
      // Read each section independently; a slow POS pull cannot block inventory.
      await Promise.all([
        (async () => {
          try {
            const result = await db.rpc("get_sales_rollup", { p_location_id: locationId, p_period: "day" }).abortSignal(controller.signal);
            if (result.error) throw result.error;
            if (requestId !== requestIdRef.current) return;
            const rows = (result.data ?? []) as Array<{ cups: number; revenue: number; cash: number; qris: number }>;
            setSales(rows.reduce((total, row) => ({ cups: total.cups + Number(row.cups), revenue: total.revenue + Number(row.revenue), cash: total.cash + Number(row.cash), qris: total.qris + Number(row.qris) }), { cups: 0, revenue: 0, cash: 0, qris: 0 }));
            setErrors((previous) => ({ ...previous, sales: false }));
          } catch { if (requestId === requestIdRef.current) setErrors((previous) => ({ ...previous, sales: true })); }
        })(),
        (async () => {
          try {
            const result = await db.from("production_batches").select("id,remaining_ml,produced_at,use_by,status,recipe_versions(recipes(name))").eq("location_id", locationId).in("status", ["open", "expired"]).gt("remaining_ml", 0).order("produced_at").abortSignal(controller.signal);
            if (result.error) throw result.error;
            if (requestId !== requestIdRef.current) return;
            setBatches((result.data ?? []) as unknown as Batch[]);
            setErrors((previous) => ({ ...previous, batches: false }));
          } catch { if (requestId === requestIdRef.current) setErrors((previous) => ({ ...previous, batches: true })); }
        })(),
        (async () => {
          try {
            const result = await db.from("location_inventory").select("item_id,quantity,safety_stock,par_level,inventory_items(name,unit,category)").eq("location_id", locationId).order("quantity").abortSignal(controller.signal);
            if (result.error) throw result.error;
            if (requestId !== requestIdRef.current) return;
            setRawStock((result.data ?? []) as unknown as RawStock[]);
            setErrors((previous) => ({ ...previous, stock: false }));
          } catch { if (requestId === requestIdRef.current) setErrors((previous) => ({ ...previous, stock: true })); }
        })(),
        (async () => {
          try {
            const result = await db.rpc("get_pos_health", { p_location_id: locationId }).abortSignal(controller.signal);
            if (result.error) throw result.error;
            if (requestId !== requestIdRef.current) return;
            setHealth(((result.data ?? []) as Health[]).filter((row) => row.provider === "loyverse"));
            setErrors((previous) => ({ ...previous, health: false }));
          } catch { if (requestId === requestIdRef.current) setErrors((previous) => ({ ...previous, health: true })); }
        })(),
      ]);
      if (requestId === requestIdRef.current) setReadAt(Date.now());
    } catch {
      if (requestId === requestIdRef.current) setErrors({ sales: true, batches: true, stock: true, health: true });
    } finally {
      window.clearTimeout(timeout);
      if (requestId === requestIdRef.current) {
        controllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [locationId]);

  useEffect(() => {
    let disposed = false;
    let syncController: AbortController | null = null;
    setSales(null); setBatches(null); setRawStock(null); setHealth(null); setReadAt(null); setErrors(noErrors);
    void load();
    const sync = async () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      const controller = new AbortController();
      syncController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch("/api/loyverse/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locationId }), signal: controller.signal });
        if (response.ok && !disposed) void load();
      } catch { /* Health and its last successful timestamp remain the source of sync status. */ }
      finally { window.clearTimeout(timeout); syncingRef.current = false; }
    };
    void sync();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") { void load(); void sync(); }
    }, 15_000);
    const visible = () => { if (document.visibilityState === "visible") { void load(); void sync(); } };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      syncController?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      ++requestIdRef.current;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [load, locationId]);

  const usable = useMemo(() => (batches ?? []).filter((batch) => batch.status === "open" && Number(batch.remaining_ml) > 0 && Date.parse(batch.produced_at) <= now && Date.parse(batch.use_by) > now), [batches, now]);
  const expired = (batches ?? []).filter((batch) => batch.status === "expired" || Date.parse(batch.use_by) <= now);
  const future = (batches ?? []).filter((batch) => batch.status === "open" && Date.parse(batch.produced_at) > now);
  const stockAlerts = (rawStock ?? []).filter((item) => Number(item.quantity) <= 0 || Number(item.quantity) <= Math.max(Number(item.safety_stock), Number(item.par_level)));
  const drinksReady = useMemo(() => {
    const grouped = new Map<string, { name: string; ml: number; batches: number; useBy: string }>();
    for (const batch of usable) {
      const name = batch.recipe_versions?.recipes?.name ?? "Produk";
      const current = grouped.get(name) ?? { name, ml: 0, batches: 0, useBy: batch.use_by };
      current.ml += Number(batch.remaining_ml);
      current.batches += 1;
      if (Date.parse(batch.use_by) < Date.parse(current.useBy)) current.useBy = batch.use_by;
      grouped.set(name, current);
    }
    return [...grouped.values()];
  }, [usable]);
  const readyCups = drinksReady.reduce((total, drink) => total + Math.floor(drink.ml / 150), 0);
  const lastSyncTimes = (health ?? []).map((row) => Date.parse(row.last_successful_sync_at ?? "")).filter(Number.isFinite);
  const lastSync = lastSyncTimes.length ? Math.min(...lastSyncTimes) : null;
  const syncBehind = health?.length && (health.some((row) => row.status !== "healthy") || !lastSync || now - lastSync > 120_000);
  const anyError = Object.values(errors).some(Boolean);
  const unknownStock = errors.stock || errors.batches;

  const emptyStock = stockAlerts.filter((item) => Number(item.quantity) <= 0);
  const lowStock = stockAlerts.filter((item) => Number(item.quantity) > 0);
  const posNeedsCheck = Boolean(syncBehind) || (health !== null && health.length === 0);
  const showAlerts = anyError || expired.length > 0 || future.length > 0 || stockAlerts.length > 0 || posNeedsCheck;
  const posTitle = errors.health ? "Status Loyverse belum tersedia" : health === null ? "Memuat status Loyverse…" : !health.length ? "Loyverse belum terhubung" : syncBehind ? "Penjualan mungkin belum lengkap" : "Loyverse tersinkronisasi";

  return (
    <div className={`${styles.wrap} ${styles.home}`}>
      <section className={styles.homeMetrics} aria-label="Ringkasan hari ini">
        <article className={styles.homeRevenueCompact}>
          <span>Omzet tercatat hari ini</span>
          <strong>{sales ? rupiah.format(sales.revenue) : errors.sales ? "Tidak tersedia" : "Memuat…"}</strong>
          <small>{errors.sales ? sales ? "Belum diperbarui · angka terakhir" : "Periksa koneksi dan perbarui" : "Sebelum pengembalian dana"}</small>
        </article>
        <article className={styles.homeMetricCompact}>
          <span>Gelas tercatat</span>
          <strong>{sales ? number.format(sales.cups) : "—"}</strong>
          <small>Termasuk minuman gratis</small>
        </article>
        <article className={styles.homeMetricCompact}>
          <span>Minuman tersedia</span>
          <strong>{batches ? readyCups : "—"}<small> gelas</small></strong>
          <small>{errors.batches ? "Belum terverifikasi" : "150 ml / gelas · cek cup & tutup"}</small>
        </article>
      </section>
      <div className={styles.homeFreshness} aria-live="polite">
        <span>{refreshing ? "Memperbarui data…" : readAt ? `Diperiksa ${time(readAt)}` : anyError ? "Data belum berhasil dimuat." : "Memuat data lokasi…"}</span>
        <button type="button" className={styles.taskButton} onClick={() => void load()} disabled={refreshing}>{refreshing ? "Memuat…" : "Perbarui"}</button>
      </div>
      {showAlerts ? (
        <details className={styles.homeAlertDetails} aria-label="Perlu ditangani">
          <summary>
            <span className={styles.homeAlertSummary} aria-live="polite">
              {expired.length > 0 ? <strong>{expired.length} batch kedaluwarsa. Jangan dijual.</strong> : null}
              {unknownStock ? <span>Stok belum terverifikasi.</span> : null}
              {emptyStock.length > 0 ? <span>{emptyStock.length} bahan / kemasan habis.</span> : null}
              {lowStock.length > 0 ? <span>{lowStock.length} stok menipis.</span> : null}
              {future.length > 0 ? <span>{future.length} waktu batch perlu dicek.</span> : null}
              {errors.sales || errors.health || posNeedsCheck ? <span>Penjualan perlu diperiksa.</span> : null}
            </span>
            <span className={styles.homeDetailHint}>Detail</span>
          </summary>
          <div className={styles.homeAlertBody}>
            {anyError ? <div className={styles.homeAlertRow} role="alert"><div><strong>Sebagian data belum dapat diperbarui.</strong><p>{unknownStock ? "Status stok belum dapat dipastikan. Periksa kembali sebelum menyiapkan atau menjual minuman." : "Angka terakhir yang tersedia tetap ditampilkan. Coba perbarui lagi."}</p></div></div> : null}
            {expired.length > 0 ? <div className={styles.homeAlertRow}><div><strong>{expired.length} batch kedaluwarsa</strong><p>{expired.map((batch) => `${batch.recipe_versions?.recipes?.name ?? "Produk"} · ${number.format(Number(batch.remaining_ml))} ml`).join("; ")}. Pisahkan dan catat sebagai terbuang.</p></div>{onNavigate ? <button type="button" className={styles.taskButton} onClick={() => onNavigate("Stok")}>Buka stok</button> : null}</div> : null}
            {future.length > 0 ? <div className={styles.homeAlertRow}><div><strong>Waktu produksi belum sesuai</strong><p>{future.length} batch bertanggal mendatang, sehingga belum dihitung sebagai minuman tersedia.</p></div></div> : null}
            {stockAlerts.map((item) => <div className={styles.homeAlertRow} key={item.item_id}><div><strong>{item.inventory_items?.name ?? "Bahan"} {Number(item.quantity) <= 0 ? "habis" : "menipis"}</strong><p>Sisa {number.format(Number(item.quantity))} {item.inventory_items?.unit}. Periksa stok fisik dan kebutuhan bahan.</p></div><span className={Number(item.quantity) <= 0 ? styles.homeEmptyTag : styles.homeLowTag}>{Number(item.quantity) <= 0 ? "Habis" : "Menipis"}</span></div>)}
            {errors.sales || errors.health || posNeedsCheck ? <div className={styles.homeAlertRow}><div><strong>{posTitle}</strong><p>{lastSync ? `Sinkronisasi berhasil terakhir ${time(lastSync)}.` : "Belum ada sinkronisasi berhasil yang dapat ditampilkan."} Periksa sebelum tutup hari.</p></div></div> : null}
          </div>
        </details>
      ) : null}
      {onNavigate ? <nav className={styles.homeActions} aria-label="Aksi cepat"><button type="button" onClick={() => onNavigate("Produksi")}><strong>Buat batch</strong><span>900 ml · 6 gelas</span></button><button type="button" onClick={() => onNavigate("Stok")}><strong>Kelola stok</strong><span>Terima, hitung, terbuang</span></button></nav> : null}
      <OperatorCashDay compact locationId={locationId} onCommitted={() => { void load(); }} />
      <details className={styles.homeDetails} aria-label="Minuman tersedia">
        <summary><span>Minuman per menu</span><small>{batches ? `${readyCups} gelas tersedia` : "Belum dimuat"}</small></summary>
        <div className={styles.homeDetailsBody}>
          <p className={styles.homeSecondaryNote}>Porsi 150 ml. Periksa cup dan tutup sebelum menjual.</p>
          {errors.batches ? <p className={styles.warning}>Data batch belum diperbarui. Jumlah minuman perlu diperiksa kembali.</p> : null}
          {!batches ? <p className={styles.empty}>{errors.batches ? "Data batch tidak tersedia." : "Memuat minuman…"}</p> : drinksReady.length ? drinksReady.map((drink) => <div className={styles.row} key={drink.name}><div><strong>{drink.name}</strong><small>{number.format(drink.ml)} ml · sisa di luar porsi {number.format(drink.ml % 150)} ml</small><small>Gunakan sebelum {time(drink.useBy)}</small></div><div className={styles.quantity}><strong>{Math.floor(drink.ml / 150)} gelas</strong><small>{drink.batches} batch · FIFO</small></div></div>) : <div className={styles.empty}>Belum ada minuman tersedia. Siapkan bahan, lalu catat produksi.</div>}
        </div>
      </details>
      <details className={styles.homeDetails} aria-label="Bahan dan kemasan">
        <summary><span>Bahan & kemasan</span><small>{rawStock ? `${rawStock.length} item` : "Belum dimuat"}</small></summary>
        <div className={styles.homeDetailsBody}>
          <p className={styles.homeSecondaryNote}>Jumlah sistem. Cocokkan dengan hitungan fisik.</p>
          {errors.stock ? <p className={styles.warning}>Stok belum diperbarui. Periksa jumlah fisik sebelum produksi.</p> : null}
          {!rawStock ? <p className={styles.empty}>{errors.stock ? "Data stok tidak tersedia." : "Memuat stok…"}</p> : rawStock.length ? rawStock.map((item) => <div className={styles.row} key={item.item_id}><div><strong>{item.inventory_items?.name ?? "Bahan"}</strong><small>{item.inventory_items?.category === "packaging" ? "Kemasan" : "Bahan produksi"}{Number(item.quantity) <= 0 ? " · Habis" : ""}</small></div><div className={styles.quantity}><strong>{number.format(Number(item.quantity))} {item.inventory_items?.unit}</strong></div></div>) : <p className={styles.empty}>Belum ada stok tercatat. Catat bahan yang diterima melalui menu Stok.</p>}
        </div>
      </details>
      <details className={styles.homeDetails} aria-label="Rincian penjualan">
        <summary><span>Rincian penjualan</span><small>Tunai & QRIS</small></summary>
        <div className={styles.homeDetailsBody}>
          <div className={styles.row}><strong>Tunai</strong><span>{sales ? rupiah.format(sales.cash) : "—"}</span></div>
          <div className={styles.row}><strong>QRIS</strong><span>{sales ? rupiah.format(sales.qris) : "—"}</span></div>
          <p className={styles.homeSecondaryNote}>Dari Loyverse, termasuk minuman gratis. Omzet sebelum pengembalian dana. {errors.sales ? "Angka belum berhasil diperbarui." : ""}</p>
          {onNavigate ? <button type="button" className={styles.taskButton} onClick={() => onNavigate("Penjualan")}>Lihat penjualan</button> : null}
        </div>
      </details>
      <details className={styles.homeDetails} aria-label="Status sinkronisasi">
        <summary><span>{posTitle}</span><small>{lastSync ? time(lastSync) : "Detail koneksi"}</small></summary>
        <div className={styles.homeDetailsBody}>
          <p className={styles.homeSecondaryNote}>{lastSync ? `Sinkronisasi berhasil terakhir ${time(lastSync)}.` : "Belum ada waktu sinkronisasi berhasil yang dapat ditampilkan."} Penjualan tetap dicatat di aplikasi Loyverse. {syncBehind ? "Periksa koneksi dan perbarui sebelum tutup hari." : ""}</p>
          {onNavigate ? <button type="button" className={styles.taskButton} onClick={() => onNavigate("Tutup Hari")}>Tutup hari</button> : null}
        </div>
      </details>
    </div>
  );
}

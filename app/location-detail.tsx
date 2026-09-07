"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SalesView } from "./sales-view";
import styles from "./location-detail.module.css";

type Location = {
  id: string;
  code: string;
  name: string;
  city: string;
  timezone: string;
  is_active: boolean;
  opening_date: string | null;
};
type Connection = {
  connection_name: string;
  status: string;
  external_store_id: string | null;
  last_successful_sync_at: string | null;
  last_error: string | null;
};
type InventoryRow = {
  item_id: string;
  quantity: number;
  par_level: number;
  lead_days: number;
  name: string;
  unit: string;
};
type CatalogItem = { id: string; name: string; unit: string };
type Reconciliation = {
  business_date: string;
  expected_cash: number;
  expected_qris: number;
  cash_variance: number | null;
  qris_variance: number | null;
  closed_at: string | null;
  invalidated_at: string | null;
};

const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function LocationDetail({
  location,
  onBack,
  onArchived,
}: {
  location: Location;
  onBack: () => void;
  onArchived: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [batch, setBatch] = useState({ count: 0, remainingMl: 0 });
  const [qris, setQris] = useState<{ provider: string; reference: string | null } | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [leadDrafts, setLeadDrafts] = useState<Record<string, number>>({});
  const [savingLead, setSavingLead] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const db = createClient();
    const [connectionResult, inventoryResult, catalogResult, batchResult, paymentResult, closeResult] =
      await Promise.all([
        db
          .from("pos_connections")
          .select("connection_name,status,external_store_id,last_successful_sync_at,last_error")
          .eq("location_id", location.id)
          .eq("is_active", true),
        db
          .from("location_inventory")
          .select("item_id,quantity,par_level,lead_days")
          .eq("location_id", location.id),
        db.from("inventory_items").select("id,name,unit").order("name"),
        db
          .from("production_batches")
          .select("remaining_ml")
          .eq("location_id", location.id)
          .eq("status", "open"),
        db
          .from("payment_profiles")
          .select("provider,static_qris_reference")
          .eq("location_id", location.id)
          .eq("is_active", true)
          .maybeSingle(),
        db
          .from("daily_reconciliations")
          .select("business_date,expected_cash,expected_qris,cash_variance,qris_variance,closed_at,invalidated_at")
          .eq("location_id", location.id)
          .order("business_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
    const firstError = [connectionResult, inventoryResult, catalogResult, batchResult, paymentResult, closeResult]
      .map((result) => result.error)
      .find(Boolean);
    if (firstError) {
      setError("Ringkasan cart belum dapat dimuat. Coba muat ulang.");
    } else {
      setConnections((connectionResult.data ?? []) as Connection[]);
      const locationRows = inventoryResult.data ?? [];
      const catalogRows = (catalogResult.data ?? []) as CatalogItem[];
      const combined = catalogRows.map((item) => {
        const stored = locationRows.find((row) => row.item_id === item.id);
        return {
          item_id: item.id,
          name: item.name,
          unit: item.unit,
          quantity: Number(stored?.quantity ?? 0),
          par_level: Number(stored?.par_level ?? 0),
          lead_days: Number(stored?.lead_days ?? 1),
        };
      });
      setInventory(combined);
      setLeadDrafts(Object.fromEntries(combined.map((row) => [row.item_id, row.lead_days])));
      const openBatches = batchResult.data ?? [];
      setBatch({
        count: openBatches.length,
        remainingMl: openBatches.reduce(
          (total, row) => total + Number(row.remaining_ml),
          0,
        ),
      });
      setQris(
        paymentResult.data
          ? {
              provider: paymentResult.data.provider,
              reference: paymentResult.data.static_qris_reference,
            }
          : null,
      );
      setReconciliation((closeResult.data as Reconciliation | null) ?? null);
    }
    setLoading(false);
  }, [location.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const lowStock = useMemo(
    () => inventory.filter((row) => row.par_level > 0 && row.quantity <= row.par_level),
    [inventory],
  );
  const connection = connections[0];
  const posLabel = !connection
    ? "Belum terhubung"
    : connection.status === "healthy"
      ? "Terhubung"
      : "Perlu perhatian";
  const closeLabel = !reconciliation?.closed_at
    ? "Belum ditutup"
    : reconciliation.invalidated_at
      ? "Perlu ditinjau ulang"
      : "Selesai";

  async function saveLeadTime(itemId: string) {
    setSavingLead(itemId);
    setActionMessage("");
    const { error: saveError } = await createClient().rpc("set_location_lead_time", {
      p_location_id: location.id,
      p_item_id: itemId,
      p_lead_days: leadDrafts[itemId] ?? 1,
    });
    setSavingLead("");
    if (saveError) setActionMessage("Lead time belum dapat disimpan.");
    else {
      setActionMessage("Lead time lokasi berhasil disimpan.");
      await load();
    }
  }

  async function archiveLocation() {
    if (!window.confirm(`Hapus ${location.code} dari lokasi aktif? Operator tidak dapat lagi memakai cart ini. Riwayat penjualan, stok, COGS, dan audit tetap tersimpan.`)) return;
    if (archiving) return;
    setArchiving(true);
    setActionMessage("");
    try {
      const { error: archiveError } = await createClient().rpc("archive_location", {
        p_location_id: location.id,
      });
      if (archiveError) {
        setActionMessage("Cart belum dapat dihapus dari daftar aktif.");
        return;
      }
      onArchived();
    } catch {
      setActionMessage("Koneksi terlalu lama. Cart belum diubah.");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.heading}>
        <button type="button" onClick={onBack} className={styles.back}>
          ← Semua lokasi
        </button>
        <div className={styles.titleRow}>
          <div>
            <span>RINGKASAN CART</span>
            <h2>{location.code} · {location.name}</h2>
            <p>{location.city} · {location.timezone}</p>
          </div>
          <div className={styles.headingActions}>
            <span className={styles.state}>{location.is_active ? "AKTIF" : "BELUM SIAP"}</span>
          </div>
        </div>
      </section>

      {actionMessage ? <div className={styles.notice} role="status">{actionMessage}</div> : null}

      {error ? (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>Coba lagi</button>
        </div>
      ) : null}

      <section className={styles.metrics} aria-busy={loading}>
        <article>
          <span>LOYVERSE</span>
          <strong>{loading ? "—" : posLabel}</strong>
          <small>
            {connection?.last_successful_sync_at
              ? `Sinkronisasi ${new Date(connection.last_successful_sync_at).toLocaleString("id-ID")}`
              : "Belum ada sinkronisasi"}
          </small>
        </article>
        <article>
          <span>QRIS</span>
          <strong>{loading ? "—" : qris ? "Dikonfigurasi" : "Belum tersedia"}</strong>
          <small>{qris?.reference ?? "Profil pembayaran terpisah dari POS"}</small>
        </article>
        <article>
          <span>BATCH SIAP JUAL</span>
          <strong>{loading ? "—" : `${number.format(batch.remainingMl)} ml`}</strong>
          <small>{batch.count} batch terbuka · sekitar {Math.floor(batch.remainingMl / 150)} cup</small>
        </article>
        <article>
          <span>STOK PERLU DIPERIKSA</span>
          <strong>{loading ? "—" : lowStock.length}</strong>
          <small>{inventory.length} item stok tercatat</small>
        </article>
      </section>

      <section className={styles.statusGrid}>
        <article className={styles.panel}>
          <h3>Status operasional</h3>
          <dl>
            <div><dt>POS</dt><dd>{posLabel}</dd></div>
            <div><dt>ID gerai</dt><dd>{connection?.external_store_id ?? "—"}</dd></div>
            <div><dt>QRIS</dt><dd>{qris ? qris.provider.replaceAll("_", " ").toUpperCase() : "BELUM ADA"}</dd></div>
            <div><dt>Tutup hari terakhir</dt><dd>{closeLabel}</dd></div>
          </dl>
          {connection?.last_error ? <p className={styles.warning}>Sinkronisasi Loyverse perlu diperiksa. Data terbaru mungkin belum masuk.</p> : null}
        </article>
        <article className={styles.panel}>
          <h3>Rekonsiliasi terakhir</h3>
          {reconciliation ? (
            <dl>
              <div><dt>Tanggal</dt><dd>{reconciliation.business_date}</dd></div>
              <div><dt>Kas sistem</dt><dd>{money.format(reconciliation.expected_cash)}</dd></div>
              <div><dt>QRIS sistem</dt><dd>{money.format(reconciliation.expected_qris)}</dd></div>
              <div>
                <dt>Selisih</dt>
                <dd>{money.format(Number(reconciliation.cash_variance ?? 0) + Number(reconciliation.qris_variance ?? 0))}</dd>
              </div>
            </dl>
          ) : (
            <p className={styles.empty}>Belum ada Tutup Hari untuk cart ini.</p>
          )}
        </article>
      </section>

      {lowStock.length ? (
        <section className={styles.panel}>
          <h3>Stok perlu diperiksa</h3>
          <div className={styles.stockList}>
            {lowStock.slice(0, 8).map((row, index) => (
              <div key={`${row.item_id}-${index}`}>
                <span>{row.name}</span>
                <strong>{number.format(row.quantity)} {row.unit}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.panel}>
        <h3>Lead time per lokasi</h3>
        <p className={styles.supporting}>Atur waktu pengiriman untuk cart ini. Nilainya dapat berbeda dari lokasi lain.</p>
        {inventory.length ? (
          <div className={styles.leadList}>
            {inventory.map((row) => (
              <div key={row.item_id}>
                <span>{row.name}</span>
                <label>
                  <input
                    type="number"
                    min="0"
                    max="120"
                    value={leadDrafts[row.item_id] ?? row.lead_days}
                    onChange={(event) => setLeadDrafts((current) => ({
                      ...current,
                      [row.item_id]: Number(event.target.value),
                    }))}
                    aria-label={`Lead time ${row.name}`}
                  />
                  hari
                </label>
                <button
                  type="button"
                  disabled={savingLead === row.item_id}
                  onClick={() => void saveLeadTime(row.item_id)}
                >
                  {savingLead === row.item_id ? "Menyimpan…" : "Simpan"}
                </button>
              </div>
            ))}
          </div>
        ) : <p className={styles.empty}>Tambahkan item stok untuk mengatur lead time.</p>}
      </section>

      <section className={styles.sales}>
        <div className={styles.sectionLabel}>PENJUALAN CART</div>
        <SalesView locationId={location.id} />
      </section>

      <section className={styles.dangerZone}>
        <div>
          <span>PENGELOLAAN CART</span>
          <h3>Hapus dari lokasi aktif</h3>
          <p>
            Cart akan disembunyikan dari operasional dan seluruh akses operator
            dihentikan. Data historis tetap tersedia untuk laporan dan audit.
          </p>
        </div>
        <button type="button" disabled={archiving} onClick={() => void archiveLocation()}>
          {archiving ? "Menghapus…" : "Hapus cart"}
        </button>
      </section>
    </div>
  );
}

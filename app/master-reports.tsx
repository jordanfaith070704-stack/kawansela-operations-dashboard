"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SalesView } from "./sales-view";
import styles from "./master-reports.module.css";

type AuditRow = {
  id: string;
  action: string;
  entity_type: string;
  created_at: string;
  location_id: string | null;
  locations: { code: string } | null;
};

export function MasterReports({ onOpenCart }: { onOpenCart: (locationId: string) => void }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const { data, error: queryError } = await createClient()
      .from("audit_logs")
      .select("id,action,entity_type,created_at,location_id,locations(code)")
      .order("created_at", { ascending: false })
      .limit(50);
    if (queryError) setError("Riwayat perubahan tidak dapat dimuat.");
    else setRows((data ?? []) as unknown as AuditRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return (
    <div className={styles.wrap}>
      <SalesView locationId={null} master onOpenCart={onOpenCart} />
      <details className={styles.auditDetails}>
        <summary><span>Audit operasional</span><strong>Lihat aktivitas terbaru →</strong></summary>
      <section className={styles.audit}>
        <div className={styles.heading}>
          <div>
            <span>AUDIT OPERASIONAL</span>
            <h2>Perubahan terakhir</h2>
            <p>Aktivitas penting dari seluruh lokasi.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Memuat…" : "Muat ulang"}
          </button>
        </div>
        {error ? (
          <div className={styles.error} role="alert">
            {error}{" "}
            <button type="button" onClick={() => void load()}>
              Coba lagi
            </button>
          </div>
        ) : null}
        {!error && !loading && rows.length === 0 ? (
          <div className={styles.empty}>Belum ada perubahan operasional.</div>
        ) : null}
        {!error && rows.length > 0 ? (
          <div className={styles.list}>
            {rows.map((row) => (
              <div className={styles.row} key={row.id}>
                <div>
                  <strong>
                    {labelAction(row.action)} · {labelEntity(row.entity_type)}
                  </strong>
                  <small>{row.locations?.code ?? "Master"}</small>
                </div>
                <time dateTime={row.created_at}>
                  {new Date(row.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}
                </time>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      </details>
    </div>
  );
}

function labelAction(action: string) {
  if (action === "INSERT") return "Dibuat";
  if (action === "UPDATE") return "Diubah";
  if (action === "DELETE") return "Dihapus";
  return action.replaceAll("_", " ");
}

function labelEntity(entity: string) {
  const labels: Record<string, string> = {
    production_batches: "batch produksi",
    inventory_movements: "pergerakan stok",
    sales: "penjualan",
    recipe_versions: "versi resep",
    stock_counts: "stok opname",
    daily_reconciliations: "tutup hari",
    locations: "lokasi",
    pos_connections: "koneksi POS",
    payment_profiles: "profil pembayaran",
  };
  return labels[entity] ?? entity.replaceAll("_", " ");
}

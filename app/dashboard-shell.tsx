"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LocationWizard } from "./location-wizard";
import { OperatorHome } from "./operator-home";
import { MasterOverview } from "./master-overview";
import { SalesView } from "./sales-view";
import { OperatorOperations } from "./operator-operations";
import { MasterCatalog } from "./master-catalog";
import { MasterReports } from "./master-reports";
import { AccountSettings } from "./account-settings";
import styles from "./shell-v10.module.css";

type Props = {
  master: boolean;
  locationId: string | null;
  locationName: string;
  locationMeta: string;
};
type Section = {
  kicker: string;
  title: string;
  description: string;
  metrics: [string, string, string][];
};
const operatorNav = [
  "Hari Ini",
  "Penjualan",
  "Produksi",
  "Stok",
  "Resep",
  "Tutup Hari",
];
const masterNav = [
  "Ringkasan",
  "Lokasi",
  "Resep Master",
  "Laporan & Audit",
  "Pengaturan Akun",
];
const operator: Record<string, Section> = {
  "Hari Ini": {
    kicker: "HARI INI",
    title: "Status operasional hari ini.",
    description:
      "Lihat batch yang perlu dipakai lebih dulu, kebutuhan produksi, dan kondisi stok.",
    metrics: [
      [
        "Penjualan hari ini",
        "Belum ada data",
        "Aktif setelah sinkronisasi POS",
      ],
      ["Batch siap jual", "Belum ada batch", "Produksi tercatat per 900 ml"],
      ["Status stok", "Belum ada data", "Stok fisik diperbarui melalui opname"],
    ],
  },
  Penjualan: {
    kicker: "PENJUALAN",
    title: "Penjualan dari Loyverse.",
    description:
      "Setiap penjualan valid mengurangi 150 ml dari batch siap jual tertua serta kemasan yang sesuai.",
    metrics: [
      ["Sinkronisasi", "Belum terhubung", "Hubungi Kawansela Master"],
      [
        "Penjualan hari ini",
        "Belum ada data",
        "Tidak ada data yang ditampilkan sebagai live",
      ],
      ["Pembayaran", "Belum ada data", "Tunai dan QRIS akan direkonsiliasi"],
    ],
  },
  Produksi: {
    kicker: "PRODUKSI",
    title: "Batch 900 ml dan FIFO.",
    description:
      "Produksi memakai Resep Master aktif, mengurangi bahan baku, lalu membuat batch siap jual.",
    metrics: [
      ["Batch FIFO", "Belum ada batch", "Batch lama digunakan lebih dulu"],
      [
        "Saran produksi",
        "Belum ada data",
        "Berdasarkan penjualan dan stok siap jual",
      ],
      [
        "Resep aktif",
        "Belum ada resep",
        "Resep diterbitkan oleh Kawansela Master",
      ],
    ],
  },
  Stok: {
    kicker: "STOK",
    title: "Bahan baku, batch siap jual, dan kemasan.",
    description:
      "Pantau stok, waste, stok opname, dan kebutuhan pemesanan untuk lokasi ini.",
    metrics: [
      [
        "Bahan baku",
        "Belum ada data",
        "Diperbarui saat barang diterima atau produksi",
      ],
      ["Kemasan", "Belum ada data", "Cup dan lid berkurang saat penjualan"],
      [
        "Pemesanan",
        "Belum ada data",
        "Rekomendasi muncul saat stok perlu dipesan",
      ],
    ],
  },
  Resep: {
    kicker: "RESEP AKTIF",
    title: "Gunakan standar yang diterbitkan.",
    description:
      "Perubahan resep dilakukan oleh Kawansela Master. Riwayat batch sebelumnya tidak berubah.",
    metrics: [
      ["Resep aktif", "Belum ada resep", "Standar produksi per 900 ml"],
      ["Versi", "—", "Riwayat tersimpan per batch"],
      ["COGS", "—", "Dihitung dari batch dan kemasan"],
    ],
  },
  "Tutup Hari": {
    kicker: "TUTUP HARI",
    title: "Penjualan, stok fisik, kas, dan QRIS.",
    description:
      "Cocokkan angka sistem dengan kondisi fisik, lalu tandai selisih yang perlu ditindaklanjuti.",
    metrics: [
      ["Penjualan", "Belum ada data", "Dari transaksi yang diproses"],
      ["Stok opname", "Belum dilakukan", "Masukkan jumlah fisik"],
      ["Kas & QRIS", "Belum direkonsiliasi", "QRIS manual dapat digunakan"],
    ],
  },
};
const master: Record<string, Section> = {
  Ringkasan: {
    kicker: "RINGKASAN JARINGAN",
    title: "Pantau lokasi dan pengecualian.",
    description:
      "Lihat kesehatan lokasi, koneksi POS, stok, dan hal yang perlu ditindaklanjuti.",
    metrics: [
      ["Lokasi aktif", "Memuat data", "Data lokasi dari database"],
      ["Koneksi POS", "Memuat data", "Status per lokasi"],
      ["Rekonsiliasi hari ini", "Memuat data", "Setelah operasional dimulai"],
    ],
  },
  Lokasi: {
    kicker: "PENGATURAN LOKASI",
    title: "Lokasi memiliki data dan koneksi yang terpisah.",
    description:
      "Tambah Lokasi → Sambungkan Loyverse → Pilih Gerai → Pemetaan Produk → Uji Koneksi → Selesai.",
    metrics: [],
  },
  "Resep Master": {
    kicker: "STANDAR RESEP",
    title: "Versi resep dan riwayat batch.",
    description:
      "Versi yang diterbitkan berlaku untuk produksi berikutnya. Batch dan COGS sebelumnya tidak berubah.",
    metrics: [
      ["Resep aktif", "Belum ada resep", "Tambahkan produk dan versi pertama"],
      ["Versi draf", "Belum ada draf", "Hanya Master yang dapat menerbitkan"],
      ["Riwayat", "Belum ada perubahan", "Setiap penerbitan diaudit"],
    ],
  },
  "Laporan & Audit": {
    kicker: "LAPORAN & AUDIT",
    title: "Laporan yang dapat ditelusuri.",
    description:
      "Tinjau penjualan, FIFO, waste, stok opname, QRIS, dan perubahan penting untuk setiap lokasi.",
    metrics: [
      ["Aktivitas", "Belum ada data", "Tindakan penting dicatat"],
      ["Margin", "Belum ada data", "Dari penjualan dan COGS"],
      ["Ekspor", "Belum ada data", "Tersedia setelah transaksi masuk"],
    ],
  },
  "Pengaturan Akun": {
    kicker: "PENGATURAN AKUN",
    title: "Kelola akses dengan aman.",
    description:
      "Ubah password Master, buat akun operator, dan pulihkan akses tanpa membuka konfigurasi backend.",
    metrics: [],
  },
};

export function DashboardShell({
  master: isMaster,
  locationId,
  locationName,
  locationMeta,
}: Props) {
  const router = useRouter();
  const navigation = isMaster ? masterNav : operatorNav;
  const [active, setActive] = useState(navigation[0]);
  const [posStatus, setPosStatus] = useState("Loyverse · Memuat status");
  const current = (isMaster ? master : operator)[active];
  useEffect(() => {
    void (async () => {
      const { data, error } = await createClient().rpc("get_pos_health", {
        p_location_id: isMaster ? null : locationId,
      });
      if (error) {
        setPosStatus("Loyverse · Status tidak tersedia");
        return;
      }
      const rows = (data ?? []) as Array<{
        status: string;
        last_successful_sync_at: string | null;
      }>;
      if (!rows.length) {
        setPosStatus("Loyverse · Belum terhubung");
        return;
      }
      if (rows.some((row) => row.status !== "healthy")) {
        setPosStatus("Loyverse · Perlu perhatian");
        return;
      }
      setPosStatus(
        isMaster
          ? `Loyverse · ${rows.length} koneksi aktif`
          : "Loyverse · Terhubung",
      );
    })();
  }, [isMaster, locationId]);
  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <span>
            kawan<span className={styles.brandDot}>.</span>sela
          </span>
        </div>
        <nav className={styles.nav} aria-label="Navigasi utama">
          {navigation.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={item === active}
              className={`${styles.navButton} ${item === active ? styles.navButtonActive : ""}`}
              onClick={() => setActive(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className={styles.account}>
          {locationName}
          <button
            className={styles.accountButton}
            type="button"
            onClick={signOut}
          >
            Keluar
          </button>
        </div>
      </header>
      <div className={styles.context} aria-label="Konteks halaman">
        <span className="active">{current.kicker}</span>
        <span>{locationMeta}</span>
      </div>
      <nav className={styles.mobileNav} aria-label="Navigasi seluler">
        {navigation.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === active}
            className={item === active ? "active" : ""}
            onClick={() => setActive(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      <main className={styles.main}>
        <div className={styles.pageBar}>
          <div>
            <div className={styles.kicker}>
              {isMaster ? "KAWANSELA MASTER" : "OPERASIONAL LOKASI"}
            </div>
            <h1 className={styles.title}>{active}</h1>
          </div>
          <span className={styles.sync} aria-live="polite">
            {posStatus}
          </span>
        </div>
        {isMaster && active === "Ringkasan" ? (
          <MasterOverview />
        ) : isMaster && active === "Resep Master" ? (
          <MasterCatalog initialTab="recipes" />
        ) : isMaster && active === "Laporan & Audit" ? (
          <MasterReports />
        ) : isMaster && active === "Pengaturan Akun" ? (
          <AccountSettings />
        ) : !isMaster && active === "Hari Ini" && locationId ? (
          <OperatorHome locationId={locationId} />
        ) : !isMaster && active === "Penjualan" && locationId ? (
          <SalesView locationId={locationId} />
        ) : !isMaster &&
          locationId &&
          ["Produksi", "Stok", "Resep", "Tutup Hari"].includes(active) ? (
          <OperatorOperations
            view={active as "Produksi" | "Stok" | "Resep" | "Tutup Hari"}
            locationId={locationId}
          />
        ) : (
          <>
            <section className={styles.lead}>
              <div className={styles.kicker}>{current.kicker}</div>
              <h2>{current.title}</h2>
              <p>{current.description}</p>
            </section>
            {isMaster && active === "Lokasi" ? (
              <LocationWizard />
            ) : (
              <>
                {current.metrics.length ? (
                  <section className={styles.grid}>
                    {current.metrics.map(([label, value, note]) => (
                      <article className={styles.panel} key={label}>
                        <div className={styles.panelLabel}>{label}</div>
                        <div className={styles.panelValue}>{value}</div>
                        <div className={styles.panelNote}>{note}</div>
                      </article>
                    ))}
                  </section>
                ) : null}
                <section className={styles.empty}>
                  Belum ada data operasional untuk halaman ini. Data akan muncul
                  setelah lokasi, standar, atau integrasi yang relevan
                  dikonfigurasi.
                </section>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

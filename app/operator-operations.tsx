"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { OperatorActions } from "./operator-actions";
import styles from "./operator-home.module.css";

type View = "Produksi" | "Stok" | "Resep" | "Tutup Hari";
type MasterItem = { id: string; name: string; unit: string };
type Inventory = {
  item_id: string;
  quantity: number;
  par_level: number;
  safety_stock: number;
  inventory_items: { name: string; unit: string; category: string } | null;
};
type Recipe = {
  id: string;
  name: string;
  selling_price: number;
  active_version: number;
  recipe_versions: {
    id: string;
    version: number;
    batch_ml: number;
    serving_ml: number;
    carry_days: number;
    note: string;
    recipe_version_lines: {
      quantity: number;
      inventory_items: { name: string; unit: string; standard_unit_cost: number } | null;
    }[];
  }[];
};
type Batch = {
  id: string;
  remaining_ml: number;
  produced_at: string;
  use_by: string;
  status: string;
  recipe_versions: { version: number; recipes: { name: string } | null } | null;
};
type BatchAudit = {
  id: string;
  action: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
};
type ProductionMovement = {
  id: string;
  label: string;
  product: string;
  quantityMl: number;
  createdAt: string;
};
type ProductionPeriod = "day" | "week" | "month";
type ProductionRecap = {
  produced_ml: number;
  produced_batches: number;
  sold_ml: number;
  wasted_ml: number;
  restored_ml: number;
  net_change_ml: number;
  ready_ml: number;
};

type CloseStatus = { sales: number; counted: boolean; reconciled: boolean; closed: boolean; expectedCash: number; expectedQris: number; actualCash: number | null; actualQris: number | null; cashVariance: number | null; qrisVariance: number | null };
type OpnameLine = { system_quantity: number; physical_quantity: number; inventory_items: { name: string; unit: string } | null };
const rupiah = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
function jakartaParts() {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
}
function todayInJakarta() { const p = jakartaParts(); return `${p.year}-${p.month}-${p.day}`; }
function todayStartInJakarta() { const p = jakartaParts(); return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), -7)); }
function formatWib(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }); }

export function OperatorOperations({
  view,
  locationId,
}: {
  view: View;
  locationId: string;
}) {
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchAudits, setBatchAudits] = useState<BatchAudit[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [productionPeriod, setProductionPeriod] = useState<ProductionPeriod>("day");
  const [productionRecap, setProductionRecap] = useState<ProductionRecap | null>(null);
  const [productionRecapError, setProductionRecapError] = useState(false);
  const [masterItems, setMasterItems] = useState<MasterItem[]>([]);
  const [closeStatus, setCloseStatus] = useState<CloseStatus>({ sales: 0, counted: false, reconciled: false, closed: false, expectedCash: 0, expectedQris: 0, actualCash: null, actualQris: null, cashVariance: null, qrisVariance: null });
  const [lastOpname, setLastOpname] = useState<OpnameLine[]>([]);
  const [todayPayments, setTodayPayments] = useState({ cash: 0, qris: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError("");
      const db = createClient();
      const dayStart = todayStartInJakarta();
      const businessDate = todayInJakarta();
      const [inventoryResult, recipeResult, batchResult, itemResult, salesResult, countResult, reconciliationResult, batchAuditResult, productionRecapResult] =
        await Promise.all([
          db
            .from("location_inventory")
            .select(
              "item_id,quantity,par_level,safety_stock,inventory_items(name,unit,category)",
            )
            .eq("location_id", locationId),
          db
            .from("recipes")
            .select(
              "id,name,selling_price,active_version,recipe_versions(id,version,batch_ml,serving_ml,carry_days,note,recipe_version_lines(quantity,inventory_items(name,unit,standard_unit_cost)))",
            )
            .order("name"),
          db
            .from("production_batches")
            .select(
              "id,remaining_ml,produced_at,use_by,status,recipe_versions(version,recipes(name))",
            )
            .eq("location_id", locationId)
            .order("produced_at", { ascending: false }),
          db.from("inventory_items").select("id,name,unit").order("name"),
          db.from("sales").select("id,total,payment_method").eq("location_id", locationId).gte("occurred_at", dayStart.toISOString()),
          db.from("stock_counts").select("id,stock_count_lines(system_quantity,physical_quantity,inventory_items(name,unit))").eq("location_id", locationId).gte("counted_at", dayStart.toISOString()).order("counted_at", { ascending: false }).limit(1).maybeSingle(),
          db.from("daily_reconciliations").select("closed_at,expected_cash,expected_qris,actual_cash,actual_qris,cash_variance,qris_variance").eq("location_id", locationId).eq("business_date", businessDate).maybeSingle(),
          db
            .from("audit_logs")
            .select("id,action,before_data,after_data,created_at")
            .eq("location_id", locationId)
            .eq("entity_type", "production_batches")
            .order("created_at", { ascending: false })
            .limit(12),
          db.rpc("get_production_movement_recap", {
            p_location_id: locationId,
            p_period: productionPeriod,
          }),
        ]);
      if (
        inventoryResult.error ||
        recipeResult.error ||
        batchResult.error ||
        itemResult.error
      ) {
        setError(
          "Data operasional tidak dapat dimuat. Jangan gunakan data ini sampai koneksi pulih.",
        );
      }
      setInventory((inventoryResult.data ?? []) as unknown as Inventory[]);
      setRecipes((recipeResult.data ?? []) as unknown as Recipe[]);
      setBatches((batchResult.data ?? []) as unknown as Batch[]);
      setBatchAudits((batchAuditResult.data ?? []) as BatchAudit[]);
      setHistoryError(Boolean(batchAuditResult.error));
      const recap = (productionRecapResult.data?.[0] ?? null) as ProductionRecap | null;
      setProductionRecap(recap ? {
        produced_ml: Number(recap.produced_ml),
        produced_batches: Number(recap.produced_batches),
        sold_ml: Number(recap.sold_ml),
        wasted_ml: Number(recap.wasted_ml),
        restored_ml: Number(recap.restored_ml),
        net_change_ml: Number(recap.net_change_ml),
        ready_ml: Number(recap.ready_ml),
      } : null);
      setProductionRecapError(Boolean(productionRecapResult.error));
      setMasterItems((itemResult.data ?? []) as MasterItem[]);
      const sales = (salesResult.data ?? []) as Array<{ total: number; payment_method: string }>;
      setTodayPayments(sales.reduce((totals, sale) => ({
        cash: totals.cash + (sale.payment_method === "cash" ? Number(sale.total) : 0),
        qris: totals.qris + (["qris_static", "qris_provider"].includes(sale.payment_method) ? Number(sale.total) : 0),
      }), { cash: 0, qris: 0 }));
      const reconciliation = reconciliationResult.data as { closed_at: string | null; expected_cash: number; expected_qris: number; actual_cash: number | null; actual_qris: number | null; cash_variance: number | null; qris_variance: number | null } | null;
      setLastOpname(((countResult.data as { stock_count_lines?: OpnameLine[] } | null)?.stock_count_lines ?? []) as OpnameLine[]);
      setCloseStatus({ sales: sales.length, counted: Boolean(countResult.data), reconciled: Boolean(reconciliation), closed: Boolean(reconciliation?.closed_at), expectedCash: Number(reconciliation?.expected_cash ?? 0), expectedQris: Number(reconciliation?.expected_qris ?? 0), actualCash: reconciliation?.actual_cash ?? null, actualQris: reconciliation?.actual_qris ?? null, cashVariance: reconciliation?.cash_variance ?? null, qrisVariance: reconciliation?.qris_variance ?? null });
      setLoading(false);
    })();
  }, [locationId, productionPeriod, reloadKey]);
  // Master can publish a new recipe while an operator keeps the dashboard open.
  // Refresh the operational source of truth without requiring a logout.
  useEffect(() => {
    const interval = window.setInterval(
      () => setReloadKey((key) => key + 1),
      45_000,
    );
    return () => window.clearInterval(interval);
  }, []);
  const recipeVersions = recipes.flatMap((recipe) => {
    const version = recipe.recipe_versions.find(
      (item) => item.version === recipe.active_version,
    );
    return version
      ? [{ id: version.id, name: recipe.name, version: version.version }]
      : [];
  });
  const countItems = inventory.flatMap((item) =>
    item.inventory_items
      ? [
          {
            id: item.item_id,
            name: item.inventory_items.name,
            unit: item.inventory_items.unit,
            systemQuantity: Number(item.quantity),
          },
        ]
      : [],
  );
  const preparedBatches = batches
    .filter((batch) => batch.status === "open" && batch.remaining_ml > 0)
    .map((batch) => ({
      id: batch.id,
      name: batch.recipe_versions?.recipes?.name ?? "Batch",
      remainingMl: batch.remaining_ml,
    }));
  // Prepared drink stock is derived from open production batches, never typed manually.
  const readyDrinks = Object.values(
    batches
      .filter((batch) => batch.status === "open" && batch.remaining_ml > 0)
      .reduce<Record<string, { name: string; remainingMl: number; batches: number }>>(
        (groups, batch) => {
          const name = batch.recipe_versions?.recipes?.name ?? "Produk";
          const current = groups[name] ?? { name, remainingMl: 0, batches: 0 };
          current.remainingMl += batch.remaining_ml;
          current.batches += 1;
          groups[name] = current;
          return groups;
        },
        {},
      ),
  );
  const refresh = () => setReloadKey((key) => key + 1);
  const productionMovements = batchAudits
    .flatMap<ProductionMovement>((audit) => {
      const before = audit.before_data;
      const after = audit.after_data;
      const data = after ?? before;
      if (!data) return [];
      const recipeVersionId = String(data.recipe_version_id ?? "");
      const recipe = recipeVersions.find((item) => item.id === recipeVersionId);
      if (audit.action === "INSERT") {
        return [{
          id: audit.id,
          label: "Batch dibuat",
          product: recipe?.name ?? "Produk",
          quantityMl: Number(data.initial_ml ?? 900),
          createdAt: audit.created_at,
        }];
      }
      if (audit.action !== "UPDATE" || !before || !after) return [];
      const quantityMl = Number(after.remaining_ml ?? 0) - Number(before.remaining_ml ?? 0);
      if (!quantityMl) return [];
      return [{
        id: audit.id,
        label:
          quantityMl > 0
            ? "Volume dikembalikan"
            : after.status === "wasted"
              ? "Waste batch"
              : "Volume terpakai",
        product: recipe?.name ?? "Produk",
        quantityMl,
        createdAt: audit.created_at,
      }];
    })
    .slice(0, 8);
  if (error)
    return (
      <div className={styles.wrap}>
        <div className={styles.empty} role="alert">
          {error}{" "}
          <button type="button" onClick={refresh}>
            Coba lagi
          </button>
        </div>
      </div>
    );
  if (view === "Produksi")
    return (
      <div className={styles.wrap}>
        <section className={styles.next}>
          <div>
            <div className={styles.tag}>PRODUKSI 900 ML</div>
            <h2>
              {batches.find((batch) => batch.status === "open")
                ? "Periksa FIFO sebelum membuat batch baru."
                : "Belum ada batch siap jual."}
            </h2>
            <p>
              Produksi mengurangi bahan baku berdasarkan Resep Master aktif dan
              membuat batch siap jual 900 ml.
            </p>
          </div>
        </section>
        <section className={styles.grid}>
          <article className={styles.panel}>
            <h3>Batch aktif</h3>
            <p>Urutan penggunaan berdasarkan waktu produksi.</p>
            {loading ? (
              <div className={styles.empty}>Memuat batch…</div>
            ) : batches.filter((batch) => batch.status === "open").length ? (
              batches
                .filter((batch) => batch.status === "open")
                .map((batch) => (
                  <div className={styles.row} key={batch.id}>
                    <div>
                      <strong>
                        {batch.recipe_versions?.recipes?.name ?? "Produk"}
                      </strong>
                      <small>
                        Versi {batch.recipe_versions?.version ?? "—"} ·{" "}
                        {formatWib(batch.produced_at)} WIB
                      </small>
                    </div>
                    <div className={styles.quantity}>
                      <strong>{batch.remaining_ml} ml</strong>
                      <small>{(batch.remaining_ml / 150).toFixed(1)} cup</small>
                    </div>
                  </div>
                ))
            ) : (
              <div className={styles.empty}>Belum ada batch aktif.</div>
            )}
          </article>
          <article className={styles.panel}>
            <h3>Resep tersedia</h3>
            <p>Hanya versi aktif yang digunakan untuk produksi baru.</p>
            {recipes.map((recipe) => (
              <div className={styles.row} key={recipe.id}>
                <div>
                  <strong>{recipe.name}</strong>
                  <small>Versi {recipe.active_version}</small>
                </div>
                <span className={styles.state}>900 ML</span>
              </div>
            ))}
            {!loading && !recipes.length ? (
              <div className={styles.empty}>
                Master belum menerbitkan resep.
              </div>
            ) : null}
          </article>
        </section>
        <OperatorActions
          locationId={locationId}
          recipeVersions={recipeVersions}
          countItems={countItems}
          visibleKinds={["production"]}
          onCommitted={refresh}
        />
        <section className={`${styles.panel} ${styles.productionRecap}`}>
          <div className={styles.recapHead}>
            <div>
              <h3>Recap produksi</h3>
              <p>Ringkasan volume masuk dan keluar untuk cart ini.</p>
            </div>
            <div className={styles.recapPeriods} aria-label="Periode recap produksi">
              {(["day", "week", "month"] as ProductionPeriod[]).map((period) => (
                <button
                  key={period}
                  type="button"
                  aria-pressed={productionPeriod === period}
                  onClick={() => setProductionPeriod(period)}
                >
                  {period === "day" ? "Harian" : period === "week" ? "Mingguan" : "Bulanan"}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className={styles.empty}>Memuat recap produksi…</div>
          ) : productionRecapError ? (
            <div className={styles.empty}>Recap produksi belum dapat dimuat.</div>
          ) : productionRecap && (productionRecap.produced_ml || productionRecap.sold_ml || productionRecap.wasted_ml || productionRecap.restored_ml) ? (
            <div className={styles.recapNumbers}>
              <div><span>PRODUKSI MASUK</span><strong>+{productionRecap.produced_ml} ml</strong><small>{productionRecap.produced_batches} batch{productionRecap.restored_ml ? ` · ${productionRecap.restored_ml} ml kembali` : ""}</small></div>
              <div><span>TERJUAL KELUAR</span><strong>−{productionRecap.sold_ml} ml</strong><small>{(productionRecap.sold_ml / 150).toFixed(0)} cup diproses</small></div>
              <div><span>WASTE</span><strong>−{productionRecap.wasted_ml} ml</strong><small>Tumpah, rusak, atau dibuang</small></div>
              <div><span>SISA SIAP JUAL</span><strong>{productionRecap.ready_ml} ml</strong><small>{(productionRecap.ready_ml / 150).toFixed(1)} cup · saat ini</small></div>
            </div>
          ) : (
            <div className={styles.empty}>Belum ada pergerakan produksi pada periode ini.</div>
          )}
        </section>
        <section className={`${styles.panel} ${styles.historyPanel}`}>
          <div className={styles.panelHead}>
            <div>
              <h3>Riwayat keluar–masuk</h3>
              <p>Aktivitas volume batch terbaru.</p>
            </div>
            <span className={styles.state}>8 TERBARU</span>
          </div>
          {loading ? (
            <div className={styles.empty}>Memuat riwayat…</div>
          ) : historyError ? (
            <div className={styles.empty}>Riwayat belum dapat dimuat.</div>
          ) : productionMovements.length ? (
            <div className={styles.historyList}>
              {productionMovements.map((movement) => (
                <div className={styles.historyRow} key={movement.id}>
                  <div>
                    <strong>{movement.label}</strong>
                    <small>{movement.product} · {formatWib(movement.createdAt)} WIB</small>
                  </div>
                  <b className={movement.quantityMl > 0 ? styles.movementIn : styles.movementOut}>
                    {movement.quantityMl > 0 ? "+" : "−"}{Math.abs(movement.quantityMl)} ml
                  </b>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>Belum ada aktivitas produksi.</div>
          )}
        </section>
      </div>
    );
  if (view === "Stok")
    return (
      <div className={styles.wrap}>
        <section className={styles.next}>
          <div>
            <div className={styles.tag}>PANDUAN STOK</div>
            <h2>Catat pergerakan—jangan menimpa angka.</h2>
            <p>Barang datang: Penerimaan stok. Koreksi jumlah: Stock Opname. Barang rusak/tumpah: Waste. Semua perubahan tersimpan dalam riwayat audit.</p>
          </div>
        </section>
        <section className={styles.stockGrid}>
          <article className={styles.panel}>
            <div className={styles.panelHead}><div><h3>Bahan baku</h3><p>Sisa bahan dan kemasan di lokasi.</p></div><span className={styles.state}>BAHAN</span></div>
            {loading ? <div className={styles.empty}>Memuat bahan baku…</div> : inventory.length ? inventory.map((item) => (
              <div className={styles.row} key={item.item_id}><div><strong>{item.inventory_items?.name ?? "Item"}</strong><small>{item.inventory_items?.category === "packaging" ? "Kemasan" : "Bahan produksi"}</small></div><div className={styles.quantity}><strong>{item.quantity} {item.inventory_items?.unit}</strong><small>Sisa tersedia</small></div></div>
            )) : <div className={styles.empty}>Belum ada bahan baku.</div>}
          </article>
          <article className={styles.panel}>
            <div className={styles.panelHead}><div><h3>Minuman siap jual</h3><p>Hasil produksi yang masih tersedia untuk dijual.</p></div><span className={styles.state}>SIAP JUAL</span></div>
            {loading ? <div className={styles.empty}>Memuat stok minuman…</div> : readyDrinks.length ? readyDrinks.map((drink) => (
              <div className={styles.row} key={drink.name}><div><strong>{drink.name}</strong><small>{drink.batches} batch · FIFO saat penjualan</small></div><div className={styles.quantity}><strong>{drink.remainingMl} ml</strong><small>{(drink.remainingMl / 150).toFixed(1)} cup</small></div></div>
            )) : <div className={styles.empty}>Belum ada minuman siap jual. Catat produksi terlebih dahulu.</div>}
          </article>
        </section>
        <OperatorActions
          locationId={locationId}
          recipeVersions={recipeVersions}
          countItems={countItems}
          receiveItems={masterItems}
          preparedBatches={preparedBatches}
          visibleKinds={["receive", "count", "waste"]}
          onCommitted={refresh}
        />
        <section className={styles.numbers}>
          <article className={styles.number}>
            <span>BAHAN BAKU</span>
            <strong>
              {loading
                ? "—"
                : inventory.filter(
                    (item) => item.inventory_items?.category === "ingredient",
                  ).length}
            </strong>
            <small>Item tercatat</small>
          </article>
          <article className={styles.number}>
            <span>KEMASAN</span>
            <strong>
              {loading
                ? "—"
                : inventory.filter(
                    (item) => item.inventory_items?.category === "packaging",
                  ).length}
            </strong>
            <small>Item tercatat</small>
          </article>
          <article className={styles.number}>
            <span>PERLU DIPESAN</span>
            <strong>
              {loading
                ? "—"
                : inventory.filter((item) => item.quantity <= item.safety_stock)
                    .length}
            </strong>
            <small>Berdasarkan safety stock</small>
          </article>
        </section>
        <article className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3>Stok lokasi</h3>
              <p>
                Jumlah sistem setelah penerimaan, produksi, penjualan, waste,
                dan opname.
              </p>
            </div>
          </div>
          {inventory.map((item, index) => (
            <div
              className={styles.row}
              key={`${item.inventory_items?.name}-${index}`}
            >
              <div>
                <strong>{item.inventory_items?.name ?? "Item"}</strong>
                <small>
                  {item.inventory_items?.category === "ingredient"
                    ? "Bahan baku"
                    : "Kemasan"}
                </small>
              </div>
              <div className={styles.quantity}>
                <strong>
                  {item.quantity} {item.inventory_items?.unit}
                </strong>
                <small>Minimum {item.safety_stock}</small>
              </div>
            </div>
          ))}
          {!loading && !inventory.length ? (
            <div className={styles.empty}>Belum ada stok untuk lokasi ini.</div>
          ) : null}
        </article>
      </div>
    );
  if (view === "Resep") {
    const recipe = recipes.find((item) => item.id === selectedRecipeId);
    const version = recipe?.recipe_versions.find((item) => item.version === recipe.active_version);
    if (recipe && version) return <div className={styles.wrap}><article className={styles.recipeDetail}>
      <button type="button" className={styles.backButton} onClick={() => setSelectedRecipeId(null)}>← Semua resep</button>
      <header className={styles.recipeHero}><div><span>RESEP AKTIF · V{version.version}</span><h2>{recipe.name}</h2><p>{version.note && version.note !== "New Recipe" ? version.note : "Standar produksi dari Kawansela Master."}</p></div><b>AKTIF</b></header>
      <div className={styles.recipeMetrics}><div><span>Hasil batch</span><strong>{version.batch_ml} ml</strong></div><div><span>Porsi</span><strong>{version.serving_ml} ml</strong></div><div><span>Estimasi hasil</span><strong>{Math.floor(version.batch_ml / version.serving_ml)} cup</strong></div><div><span>Gunakan ≤</span><strong>{version.carry_days} hari</strong></div></div>
      <section className={styles.recipeSection}><div><span>01 · SIAPKAN</span><h3>Bahan</h3></div><div className={styles.ingredientList}>{version.recipe_version_lines.map((line,index)=><div key={`${line.inventory_items?.name}-${index}`}><span>{line.quantity} {line.inventory_items?.unit}</span><strong>{line.inventory_items?.name ?? "Bahan"}</strong></div>)}</div></section>
      <section className={styles.recipeSection}><div><span>02 · KERJAKAN</span><h3>Urutan produksi</h3></div><ol className={styles.workSteps}><li>Siapkan wadah produksi bersih.</li><li>Ukur bahan mengikuti daftar di atas.</li><li>Campurkan sesuai standar produk.</li><li>Buka menu <strong>Produksi</strong> untuk mencatat batch yang dibuat.</li></ol></section>
      <footer className={styles.recipeCallout}>Operator hanya menjalankan resep ini. Perubahan nama, bahan, atau versi dilakukan oleh Master.</footer>
    </article></div>;
    return <div className={styles.wrap}><article className={styles.panel}><div className={styles.panelHead}><div><h3>Resep kerja</h3><p>Pilih produk, ikuti takaran, lalu catat produksi.</p></div></div><div className={styles.recipeCards}>{recipes.map((item)=>{const active=item.recipe_versions.find((entry)=>entry.version===item.active_version);return <button type="button" className={styles.recipeCard} key={item.id} onClick={()=>setSelectedRecipeId(item.id)}><span>AKTIF · V{item.active_version}</span><strong>{item.name}</strong><small>{active?.batch_ml ?? 900} ml · {active?.serving_ml ?? 150} ml/cup</small><b>Lihat panduan →</b></button>;})}</div>{!loading&&!recipes.length?<div className={styles.empty}>Belum ada resep aktif.</div>:null}</article></div>;
  }
  const today = new Date().toLocaleDateString("id-ID", { dateStyle: "full", timeZone: "Asia/Jakarta" });
  return (
    <div className={styles.wrap}>
      <section className={styles.next}>
        <div>
          <div className={styles.tag}>TUTUP HARI · {today.toUpperCase()}</div>
          <h2>Selesaikan pemeriksaan sebelum menutup hari.</h2>
          <p>
            Urutan: Penjualan → Stok opname → Kas & QRIS → Review → Hari
            selesai.
          </p>
        </div>
      </section>
      <section className={styles.grid}>
        <article className={styles.panel}>
          <h3>Pemeriksaan</h3>
          <div className={styles.row}>
            <div>
              <strong>1. Penjualan</strong>
              <small>Transaksi valid dari POS</small>
            </div>
            <span className={styles.state}>{closeStatus.sales ? `${closeStatus.sales} TRANSAKSI` : "BELUM ADA DATA"}</span>
          </div>
          <div className={styles.row}>
            <div>
              <strong>2. Stok opname</strong>
              <small>Bandingkan stok sistem dan fisik</small>
            </div>
            <span className={styles.state}>{closeStatus.counted ? "SELESAI" : "BELUM DIMULAI"}</span>
          </div>
          <div className={styles.row}>
            <div>
              <strong>3. Kas & QRIS</strong>
              <small>Masukkan jumlah aktual</small>
            </div>
            <span className={styles.state}>{closeStatus.reconciled ? "SELESAI" : "BELUM DIMULAI"}</span>
          </div>
        </article>
        <article className={styles.panel}>
          <h3>Status penutupan</h3>
          <p>
            {closeStatus.closed ? "Hari sudah ditutup dan direkonsiliasi." : "Hari belum dapat ditutup sampai stok opname dan rekonsiliasi diselesaikan."}
          </p>
          <div className={styles.sync}>{closeStatus.closed ? "Tutup hari selesai." : closeStatus.counted && closeStatus.reconciled ? "Siap ditutup." : "Belum siap ditutup."}</div>
        </article>
      </section>
      <article className={styles.panel}>
        <div className={styles.panelHead}><div><h3>Rekap hasil hari ini</h3><p>Hasil otomatis dari penjualan Loyverse, opname, dan rekonsiliasi.</p></div></div>
        <div className={styles.row}><div><strong>Cash</strong><small>Sistem {rupiah.format(closeStatus.reconciled ? closeStatus.expectedCash : todayPayments.cash)} · aktual {closeStatus.actualCash === null ? "belum diisi" : rupiah.format(closeStatus.actualCash)}</small></div><div className={styles.quantity}><strong>{closeStatus.cashVariance === null ? "—" : rupiah.format(closeStatus.cashVariance)}</strong><small>Selisih cash</small></div></div>
        <div className={styles.row}><div><strong>QRIS</strong><small>Dari Loyverse {rupiah.format(closeStatus.reconciled ? closeStatus.expectedQris : todayPayments.qris)} · aktual {closeStatus.actualQris === null ? "belum diisi" : rupiah.format(closeStatus.actualQris)}</small></div><div className={styles.quantity}><strong>{closeStatus.qrisVariance === null ? "—" : rupiah.format(closeStatus.qrisVariance)}</strong><small>Selisih QRIS</small></div></div>
        <div className={styles.row}><div><strong>Stock opname terakhir</strong><small>{lastOpname.length ? `${lastOpname.length} item dihitung` : "Belum ada opname hari ini"}</small></div><div className={styles.quantity}><strong>{lastOpname.length ? lastOpname.filter((line) => Number(line.physical_quantity) !== Number(line.system_quantity)).length : "—"}</strong><small>Item berselisih</small></div></div>
        {lastOpname.filter((line) => Number(line.physical_quantity) !== Number(line.system_quantity)).map((line, index) => <div className={styles.row} key={`${line.inventory_items?.name}-${index}`}><div><strong>{line.inventory_items?.name ?? "Item"}</strong><small>Sistem {line.system_quantity} {line.inventory_items?.unit}</small></div><div className={styles.quantity}><strong>{Number(line.physical_quantity) - Number(line.system_quantity)} {line.inventory_items?.unit}</strong><small>Selisih opname</small></div></div>)}
      </article>
      <OperatorActions
        locationId={locationId}
        recipeVersions={recipeVersions}
        countItems={countItems}
        expectedCashSales={todayPayments.cash}
        expectedQrisSales={todayPayments.qris}
        visibleKinds={["count", "close"]}
        onCommitted={refresh}
      />
    </div>
  );
}

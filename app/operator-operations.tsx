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

type CloseStatus = { sales: number; counted: boolean; reconciled: boolean; closed: boolean; invalidated: boolean; invalidationReason: string | null; expectedCash: number; expectedQris: number; actualCash: number | null; actualQris: number | null; cashVariance: number | null; qrisVariance: number | null };
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
  onNavigate,
}: {
  view: View;
  locationId: string;
  onNavigate?: (view: View) => void;
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
  const [closeStatus, setCloseStatus] = useState<CloseStatus>({ sales: 0, counted: false, reconciled: false, closed: false, invalidated: false, invalidationReason: null, expectedCash: 0, expectedQris: 0, actualCash: null, actualQris: null, cashVariance: null, qrisVariance: null });
  const [lastOpname, setLastOpname] = useState<OpnameLine[]>([]);
  const [todayPayments, setTodayPayments] = useState({ cash: 0, qris: 0, other: 0, otherCount: 0 });
  const [closeError, setCloseError] = useState(false);
  const [syncNeedsReview, setSyncNeedsReview] = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const db = createClient();
        const dayStart = todayStartInJakarta();
        const businessDate = todayInJakarta();
        const dayEnd = new Date(dayStart.getTime() + 86_400_000);
        const [inventoryResult, recipeResult, batchResult, itemResult, salesResult, countResult, reconciliationResult, batchAuditResult, productionRecapResult, healthResult] =
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
              .in("status", ["open", "expired"])
              .gt("remaining_ml", 0)
              .order("produced_at", { ascending: true }),
            db.from("inventory_items").select("id,name,unit").order("name"),
            db.from("sales").select("id,total,payment_method").eq("location_id", locationId).gte("occurred_at", dayStart.toISOString()).lt("occurred_at", dayEnd.toISOString()),
            db.from("stock_counts").select("id,stock_count_lines(system_quantity,physical_quantity,inventory_items(name,unit))").eq("location_id", locationId).gte("counted_at", dayStart.toISOString()).lt("counted_at", dayEnd.toISOString()).order("counted_at", { ascending: false }).limit(1).maybeSingle(),
            db.from("daily_reconciliations").select("closed_at,invalidated_at,invalidation_reason,expected_cash,expected_qris,actual_cash,actual_qris,cash_variance,qris_variance").eq("location_id", locationId).eq("business_date", businessDate).maybeSingle(),
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
            db.rpc("get_pos_health", { p_location_id: locationId }),
          ]);
        if (!active) return;
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
        setCloseError(Boolean(salesResult.error || countResult.error || reconciliationResult.error));
        const health = (healthResult.data ?? []) as Array<{ provider: string; status: string; last_successful_sync_at: string | null }>;
        const loyverseHealth = health.filter((item) => item.provider === "loyverse");
        setSyncNeedsReview(Boolean(healthResult.error) || !loyverseHealth.length || loyverseHealth.some((item) => { const syncedAt = new Date(item.last_successful_sync_at ?? "").getTime(); return item.status !== "healthy" || !Number.isFinite(syncedAt) || Date.now() - syncedAt > 5 * 60_000; }));
        setLastSyncAt(loyverseHealth[0]?.last_successful_sync_at ?? null);
        const sales = (salesResult.data ?? []) as Array<{ total: number; payment_method: string }>;
        setTodayPayments(sales.reduce((totals, sale) => ({
          cash: totals.cash + (sale.payment_method === "cash" ? Number(sale.total) : 0),
          qris: totals.qris + (["qris_static", "qris_provider"].includes(sale.payment_method) ? Number(sale.total) : 0),
          other: totals.other + (!["cash", "qris_static", "qris_provider"].includes(sale.payment_method) ? Number(sale.total) : 0),
          otherCount: totals.otherCount + (!["cash", "qris_static", "qris_provider"].includes(sale.payment_method) ? 1 : 0),
        }), { cash: 0, qris: 0, other: 0, otherCount: 0 }));
        const reconciliation = reconciliationResult.data as { closed_at: string | null; invalidated_at: string | null; invalidation_reason: string | null; expected_cash: number; expected_qris: number; actual_cash: number | null; actual_qris: number | null; cash_variance: number | null; qris_variance: number | null } | null;
        setLastOpname(((countResult.data as { stock_count_lines?: OpnameLine[] } | null)?.stock_count_lines ?? []) as OpnameLine[]);
        setCloseStatus({ sales: sales.length, counted: Boolean(countResult.data), reconciled: Boolean(reconciliation), closed: Boolean(reconciliation?.closed_at), invalidated: Boolean(reconciliation?.invalidated_at), invalidationReason: reconciliation?.invalidation_reason ?? null, expectedCash: Number(reconciliation?.expected_cash ?? 0), expectedQris: Number(reconciliation?.expected_qris ?? 0), actualCash: reconciliation?.actual_cash ?? null, actualQris: reconciliation?.actual_qris ?? null, cashVariance: reconciliation?.cash_variance ?? null, qrisVariance: reconciliation?.qris_variance ?? null });
      } catch {
        if (active) {
          setError("Koneksi terputus. Data belum dapat diperbarui; coba lagi sebelum mencatat aktivitas.");
          setCloseError(true);
          setSyncNeedsReview(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
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
  const now = Date.now();
  const usableBatches = batches.filter((batch) => batch.status === "open" && Number(batch.remaining_ml) > 0 && new Date(batch.produced_at).getTime() <= now && new Date(batch.use_by).getTime() > now);
  const expiredBatches = batches.filter((batch) => Number(batch.remaining_ml) > 0 && (batch.status === "expired" || (batch.status === "open" && new Date(batch.use_by).getTime() <= now)));
  const preparedBatches = batches
    .filter((batch) => ["open", "expired"].includes(batch.status) && Number(batch.remaining_ml) > 0)
    .map((batch) => ({
      id: batch.id,
      name: `${batch.recipe_versions?.recipes?.name ?? "Batch"} · ${formatWib(batch.produced_at)} WIB${expiredBatches.some((item) => item.id === batch.id) ? " · kedaluwarsa" : ""}`,
      remainingMl: Number(batch.remaining_ml),
    }));
  // Prepared drink stock is derived from open production batches, never typed manually.
  const readyDrinks = Object.values(
    usableBatches
      .reduce<Record<string, { name: string; remainingMl: number; batches: number }>>(
        (groups, batch) => {
          const name = batch.recipe_versions?.recipes?.name ?? "Produk";
          const current = groups[name] ?? { name, remainingMl: 0, batches: 0 };
          current.remainingMl += Number(batch.remaining_ml);
          current.batches += 1;
          groups[name] = current;
          return groups;
        },
        {},
      ),
  );
  const refresh = () => setReloadKey((key) => key + 1);
  const taskNavigation = onNavigate ? <nav className={styles.taskTabs} aria-label="Kelola stok">{(["Stok", "Produksi", "Resep"] as const).map((item) => <button key={item} type="button" aria-current={view === item ? "page" : undefined} onClick={() => { setSelectedRecipeId(null); onNavigate(item); }}>{item}</button>)}</nav> : null;
  const productionMovements = batchAudits
    .flatMap<ProductionMovement>((audit) => {
      const before = audit.before_data;
      const after = audit.after_data;
      const data = after ?? before;
      if (!data) return [];
      const recipeVersionId = String(data.recipe_version_id ?? "");
      const recipe = recipes.find((item) => item.recipe_versions.some((version) => version.id === recipeVersionId));
      const batch = batches.find((item) => item.id === String(data.id ?? ""));
      const product = recipe?.name ?? batch?.recipe_versions?.recipes?.name ?? "Produk";
      if (audit.action === "INSERT") {
        return [{
          id: audit.id,
          label: "Batch dibuat",
          product,
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
              ? "Batch terbuang"
              : "Volume terpakai",
        product,
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
        {taskNavigation}
        <section className={styles.next}>
          <div>
            <div className={styles.tag}>PRODUKSI 900 ML</div>
            <h2>
              {usableBatches.length
                ? "Gunakan batch paling lama terlebih dahulu."
                : "Siapkan minuman untuk gerobakmu."}
            </h2>
            <p>
              Catat batch setelah selesai diracik. Bahan berkurang sesuai resep aktif; satu batch menghasilkan 900 ml.
            </p>
          </div>
        </section>
        {!loading && expiredBatches.length > 0 ? <div className={styles.warning} role="status"><strong>{expiredBatches.length} batch kedaluwarsa.</strong><p>Jangan gunakan. Buka Stok untuk mencatat minuman yang dibuang.</p></div> : null}
        <OperatorActions
          locationId={locationId}
          recipeVersions={recipeVersions}
          countItems={countItems}
          visibleKinds={["production"]}
          onCommitted={refresh}
        />
        <section className={styles.grid}>
          <article className={styles.panel}>
            <h3>Batch yang bisa digunakan</h3>
            <p>Paling lama di atas. Batch kedaluwarsa tidak termasuk.</p>
            {loading ? (
              <div className={styles.empty}>Memuat batch…</div>
            ) : usableBatches.length ? (
              usableBatches
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
                      <small>Gunakan sebelum {formatWib(batch.use_by)} WIB</small>
                    </div>
                    <div className={styles.quantity}>
                      <strong>{batch.remaining_ml} ml</strong>
                      <small>{Math.floor(Number(batch.remaining_ml) / 150)} porsi</small>
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
        <section className={`${styles.panel} ${styles.productionRecap}`}>
          <div className={styles.recapHead}>
            <div>
              <h3>Ringkasan produksi</h3>
              <p>Volume masuk dan keluar di gerobak ini.</p>
            </div>
            <div className={styles.recapPeriods} aria-label="Periode ringkasan produksi">
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
            <div className={styles.empty}>Memuat ringkasan produksi…</div>
          ) : productionRecapError ? (
            <div className={styles.empty}>Ringkasan produksi belum dapat dimuat.</div>
          ) : productionRecap && (productionRecap.produced_ml || productionRecap.sold_ml || productionRecap.wasted_ml || productionRecap.restored_ml) ? (
            <div className={styles.recapNumbers}>
              <div><span>PRODUKSI MASUK</span><strong>{productionRecap.produced_ml ? "+" : ""}{productionRecap.produced_ml} ml</strong><small>{productionRecap.produced_batches} batch{productionRecap.restored_ml ? ` · ${productionRecap.restored_ml} ml kembali` : ""}</small></div>
              <div><span>TERJUAL KELUAR</span><strong>{productionRecap.sold_ml ? "−" : ""}{productionRecap.sold_ml} ml</strong><small>{(productionRecap.sold_ml / 150).toFixed(0)} porsi diproses</small></div>
              <div><span>TERBUANG</span><strong>{productionRecap.wasted_ml ? "−" : ""}{productionRecap.wasted_ml} ml</strong><small>Tumpah, rusak, atau dibuang</small></div>
              <div><span>PORSI TERSEDIA</span><strong>{readyDrinks.reduce((sum, drink) => sum + drink.remainingMl, 0)} ml</strong><small>{readyDrinks.reduce((sum, drink) => sum + Math.floor(drink.remainingMl / 150), 0)} porsi · belum kedaluwarsa</small></div>
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
        {taskNavigation}
        <section className={styles.next}>
          <div>
            <h2>Stok gerobak</h2>
            <p>Terima, siapkan, hitung stok.</p>
          </div>
        </section>
        {!loading && expiredBatches.length > 0 ? <div className={styles.warning} role="status"><strong>{expiredBatches.length} batch kedaluwarsa — jangan digunakan.</strong><p>Pisahkan dari minuman yang layak. Catat melalui “Terbuang” saat dibuang.</p>{expiredBatches.map((batch) => <p key={batch.id}>{batch.recipe_versions?.recipes?.name ?? "Produk"} · {batch.remaining_ml} ml · batas {formatWib(batch.use_by)} WIB</p>)}</div> : null}
        <OperatorActions
          locationId={locationId}
          recipeVersions={recipeVersions}
          countItems={countItems}
          receiveItems={masterItems}
          preparedBatches={preparedBatches}
          visibleKinds={["receive", "production", "waste", "count"]}
          onCommitted={refresh}
        />
        <article className={styles.panel}>
          <div className={styles.panelHead}><div><h3>Porsi minuman tersedia</h3><p>Hasil batch yang belum kedaluwarsa. Satu porsi = 150 ml; periksa juga kemasan dan es.</p></div></div>
          {loading ? <div className={styles.empty}>Memuat minuman…</div> : readyDrinks.length ? readyDrinks.map((drink) => (
            <div className={styles.row} key={drink.name}><div><strong>{drink.name}</strong><small>{drink.batches} batch · gunakan paling lama dahulu</small></div><div className={styles.quantity}><strong>{Math.floor(drink.remainingMl / 150)} porsi</strong><small>{drink.remainingMl} ml{drink.remainingMl % 150 ? ` · sisa ${drink.remainingMl % 150} ml` : ""}</small></div></div>
          )) : <div className={styles.empty}>Belum ada minuman tersedia. Pilih “Buat batch” setelah meracik minuman.</div>}
        </article>
        <article className={styles.panel}>
          <div className={styles.panelHead}><div><h3>Bahan dan kemasan</h3><p>Sisa bahan untuk produksi dan perlengkapan untuk melayani.</p></div></div>
          {loading ? <div className={styles.empty}>Memuat bahan dan kemasan…</div> : inventory.length ? [...inventory].sort((a,b) => Number(Number(b.quantity) <= Number(b.safety_stock)) - Number(Number(a.quantity) <= Number(a.safety_stock))).map((item) => (
            <div className={styles.row} key={item.item_id}><div><strong>{item.inventory_items?.name ?? "Item"}</strong><small>{item.inventory_items?.category === "packaging" ? "Kemasan" : "Bahan produksi"} · minimum {item.safety_stock} {item.inventory_items?.unit}</small>{Number(item.quantity) <= Number(item.safety_stock) ? <small><strong>{Number(item.quantity) <= 0 ? "Habis · perlu diisi" : "Menipis · siapkan pesanan stok"}</strong></small> : null}</div><div className={styles.quantity}><strong>{item.quantity} {item.inventory_items?.unit}</strong><small>Tercatat di sistem</small></div></div>
          )) : <div className={styles.empty}>Belum ada stok di gerobak ini. Catat bahan dan kemasan melalui “Terima stok”.</div>}
        </article>
      </div>
    );
  if (view === "Resep") {
    const recipe = recipes.find((item) => item.id === selectedRecipeId);
    const version = recipe?.recipe_versions.find((item) => item.version === recipe.active_version);
    if (recipe && version) return <div className={styles.wrap}>{taskNavigation}<article className={styles.recipeDetail}>
      <button type="button" className={styles.backButton} onClick={() => setSelectedRecipeId(null)}>Semua resep</button>
      <header className={styles.recipeHero}><div><span>RESEP AKTIF · V{version.version}</span><h2>{recipe.name}</h2><p>{version.note && version.note !== "New Recipe" ? version.note : "Standar produksi dari Kawansela Master."}</p></div><b>AKTIF</b></header>
      <div className={styles.recipeMetrics}><div><span>Hasil batch</span><strong>{version.batch_ml} ml</strong></div><div><span>Porsi</span><strong>{version.serving_ml} ml</strong></div><div><span>Estimasi hasil</span><strong>{Math.floor(version.batch_ml / version.serving_ml)} cup</strong></div><div><span>Gunakan ≤</span><strong>{version.carry_days} hari</strong></div></div>
      <section className={styles.recipeSection}><div><span>01 · SIAPKAN</span><h3>Bahan</h3></div><div className={styles.ingredientList}>{version.recipe_version_lines.map((line,index)=><div key={`${line.inventory_items?.name}-${index}`}><span>{line.quantity} {line.inventory_items?.unit}</span><strong>{line.inventory_items?.name ?? "Bahan"}</strong></div>)}</div></section>
      <section className={styles.recipeSection}><div><span>02 · KERJAKAN</span><h3>Urutan produksi</h3></div><ol className={styles.workSteps}><li>Siapkan wadah produksi bersih.</li><li>Ukur bahan mengikuti daftar di atas.</li><li>Campurkan sesuai standar produk.</li><li>Buka menu <strong>Produksi</strong> untuk mencatat batch yang dibuat.</li></ol></section>
      <footer className={styles.recipeCallout}>Operator hanya menjalankan resep ini. Perubahan nama, bahan, atau versi dilakukan oleh Master.</footer>
    </article></div>;
    return <div className={styles.wrap}>{taskNavigation}<article className={styles.panel}><div className={styles.panelHead}><div><h3>Resep kerja</h3><p>Pilih produk, ikuti takaran, lalu catat produksi.</p></div></div><div className={styles.recipeCards}>{recipes.map((item)=>{const active=item.recipe_versions.find((entry)=>entry.version===item.active_version);return <button type="button" className={styles.recipeCard} key={item.id} disabled={!active} onClick={()=>setSelectedRecipeId(item.id)}><span>{active ? `AKTIF · V${item.active_version}` : "BELUM TERSEDIA"}</span><strong>{item.name}</strong><small>{active?.batch_ml ?? 900} ml · {active?.serving_ml ?? 150} ml/cup</small><b>{active ? "Lihat resep" : "Minta resep ke admin"}</b></button>;})}</div>{loading?<div className={styles.empty}>Memuat resep…</div>:!recipes.length?<div className={styles.empty}>Belum ada resep aktif. Minta admin menerbitkan resep untuk gerobakmu.</div>:null}</article></div>;
  }
  const today = new Date().toLocaleDateString("id-ID", { dateStyle: "full", timeZone: "Asia/Jakarta" });
  const closeBlockedReason = loading ? "Memuat pemeriksaan penutupan…"
    : closeError ? "Data penjualan atau pemeriksaan belum dapat dimuat. Coba muat ulang sebelum menutup hari."
    : closeStatus.invalidated ? closeStatus.invalidationReason ?? "Ada transaksi baru setelah penutupan. Minta admin meninjau ulang hari ini."
    : syncNeedsReview ? "Sinkronisasi Loyverse perlu diperiksa. Pastikan semua struk sudah masuk, lalu muat ulang. Hubungi admin jika status belum pulih."
    : todayPayments.otherCount ? "Ada metode pembayaran lain yang belum masuk perhitungan tunai atau QRIS. Minta admin memeriksa sebelum penutupan."
    : closeStatus.closed ? "Penutupan hari ini sudah tercatat."
    : !closeStatus.counted ? "Hitung stok fisik terlebih dahulu, lalu isi tunai dan QRIS."
    : "";
  const reviewRequired = loading || closeError || closeStatus.invalidated || syncNeedsReview || todayPayments.otherCount > 0;
  return (
    <div className={styles.wrap}>
      <section className={styles.next}>
        <div>
          <div className={styles.tag}>TUTUP HARI · {today.toUpperCase()}</div>
          <h2>{closeStatus.closed && !reviewRequired ? "Penutupan sudah tercatat." : "Hitung stok, lalu cocokkan uang."}</h2>
          <p>Periksa struk Loyverse, hitung sisa stok, lalu isi tunai dan QRIS sesuai hasil pemeriksaan.</p>
        </div>
      </section>
      {closeBlockedReason && !(closeStatus.closed && !reviewRequired) ? <div className={styles.warning} role="status"><strong>Perlu diselesaikan</strong><p>{closeBlockedReason}</p>{closeError || syncNeedsReview ? <button type="button" className={styles.taskButton} onClick={refresh}>Muat ulang pemeriksaan</button> : null}</div> : null}
      <article className={styles.panel}>
        <h3>Pemeriksaan hari ini</h3>
        <div className={styles.row}><div><strong>1. Periksa penjualan</strong><small>{closeError ? "Data belum dapat dipastikan" : `${closeStatus.sales} baris penjualan tercatat`}. Pastikan tidak ada struk tertunda di Loyverse.</small><small>{lastSyncAt ? `Sinkron terakhir ${formatWib(lastSyncAt)} WIB` : "Belum ada sinkronisasi yang terkonfirmasi"}</small></div><span className={styles.state}>{loading ? "MEMUAT" : syncNeedsReview || closeError ? "PERIKSA" : "TERHUBUNG"}</span></div>
        <div className={styles.row}><div><strong>2. Hitung stok fisik</strong><small>Hitung bahan dan kemasan yang diminta; pisahkan batch kedaluwarsa.</small></div><span className={styles.state}>{loading ? "MEMUAT" : closeStatus.counted ? "TERCATAT" : "BELUM"}</span></div>
        <div className={styles.row}><div><strong>3. Cocokkan tunai & QRIS</strong><small>Gunakan uang yang dihitung dan total transaksi dari penyedia QRIS.</small></div><span className={styles.state}>{loading ? "MEMUAT" : closeStatus.invalidated ? "TINJAU ULANG" : closeStatus.reconciled ? "TERCATAT" : "BELUM"}</span></div>
      </article>
      {todayPayments.otherCount > 0 && !closeError ? <div className={styles.warning} role="alert"><strong>{todayPayments.otherCount} baris pembayaran lain · {rupiah.format(todayPayments.other)}</strong><p>Total ini tidak termasuk tunai atau QRIS. Hubungi admin untuk memastikan pemetaan metode bayar.</p></div> : null}
      <article className={styles.panel}>
        <div className={styles.panelHead}><div><h3>Tunai dan QRIS</h3><p>Saldo tunai dihitung saat formulir diisi. Cocokkan QRIS sebelum biaya atau potongan penyedia.</p></div></div>
        <div className={styles.row}><div><strong>Tunai</strong><small>{closeError || loading ? "Belum dapat dipastikan" : closeStatus.reconciled && !closeStatus.invalidated ? `Seharusnya ${rupiah.format(closeStatus.expectedCash)}` : `Penjualan tercatat ${rupiah.format(todayPayments.cash)}`}</small><small>Aktual {closeStatus.actualCash === null ? "belum diisi" : rupiah.format(closeStatus.actualCash)}</small></div><div className={styles.quantity}><strong>{closeStatus.cashVariance === null || reviewRequired ? "—" : rupiah.format(closeStatus.cashVariance)}</strong><small>{closeStatus.invalidated ? "Perlu ditinjau ulang" : "Selisih tunai"}</small></div></div>
        <div className={styles.row}><div><strong>QRIS</strong><small>{closeError || loading ? "Belum dapat dipastikan" : `Dari Loyverse ${rupiah.format(closeStatus.reconciled && !closeStatus.invalidated ? closeStatus.expectedQris : todayPayments.qris)}`}</small><small>Aktual {closeStatus.actualQris === null ? "belum diisi" : rupiah.format(closeStatus.actualQris)}</small></div><div className={styles.quantity}><strong>{closeStatus.qrisVariance === null || reviewRequired ? "—" : rupiah.format(closeStatus.qrisVariance)}</strong><small>Selisih QRIS</small></div></div>
      </article>
      {!loading && !closeError ? <OperatorActions
        locationId={locationId}
        recipeVersions={recipeVersions}
        countItems={countItems}
        expectedCashSales={todayPayments.cash}
        expectedQrisSales={todayPayments.qris}
        visibleKinds={closeStatus.closed ? [] : closeBlockedReason ? ["count"] : ["count", "close"]}
        onCommitted={refresh}
      /> : null}
      {lastOpname.length ? <article className={styles.panel}><h3>Hasil hitung stok terakhir</h3><p>{lastOpname.length} item dihitung · {lastOpname.filter((line) => Number(line.physical_quantity) !== Number(line.system_quantity)).length} item berselisih</p>{lastOpname.filter((line) => Number(line.physical_quantity) !== Number(line.system_quantity)).map((line, index) => <div className={styles.row} key={`${line.inventory_items?.name}-${index}`}><div><strong>{line.inventory_items?.name ?? "Item"}</strong><small>Sistem {line.system_quantity} {line.inventory_items?.unit}</small></div><div className={styles.quantity}><strong>{Number(line.physical_quantity) - Number(line.system_quantity)} {line.inventory_items?.unit}</strong><small>Selisih hasil hitung</small></div></div>)}</article> : null}
    </div>
  );
}

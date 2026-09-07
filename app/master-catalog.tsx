"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./master-catalog.module.css";

type CatalogTab = "recipes" | "inventory";
type Supplier = {
  id: string;
  name: string;
  lead_days: number;
  is_active: boolean;
};
type Item = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  category: "ingredient" | "packaging";
  supplier_id: string | null;
  standard_unit_cost: number;
};
type RecipeLine = {
  item_id: string;
  quantity: number;
  inventory_items: Pick<
    Item,
    "id" | "name" | "unit" | "standard_unit_cost"
  > | null;
};
type RecipeVersion = {
  id: string;
  version: number;
  batch_ml: number;
  serving_ml: number;
  carry_days: number;
  note: string;
  published_at: string;
  recipe_version_lines: RecipeLine[];
};
type Recipe = {
  id: string;
  name: string;
  selling_price: number;
  active_version: number;
  recipe_versions: RecipeVersion[];
};
type Notice = { tone: "success" | "error"; text: string } | null;

const money = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });

function latestVersion(recipe: Recipe) {
  return (
    recipe.recipe_versions.find(
      (version) => version.version === recipe.active_version,
    ) ?? recipe.recipe_versions[0]
  );
}

function apiError(error: { message?: string } | null, fallback: string) {
  if (!error) return fallback;
  if (error.message?.toLowerCase().includes("permission"))
    return "Akses Master diperlukan untuk tindakan ini.";
  return fallback;
}

export function MasterCatalog({
  initialTab = "recipes",
}: {
  initialTab?: CatalogTab;
}) {
  const [tab, setTab] = useState<CatalogTab>(initialTab);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [draft, setDraft] = useState<{
    price: string;
    carryDays: string;
    note: string;
    quantities: Record<string, string>;
  }>({ price: "", carryDays: "1", note: "", quantities: {} });
  const [newDraft, setNewDraft] = useState<{
    name: string;
    price: string;
    carryDays: string;
    note: string;
    quantities: Record<string, string>;
  }>({ name: "", price: "", carryDays: "1", note: "", quantities: {} });

  const creatingRecipe = selectedRecipeId === "__new__";
  const selectedRecipe = creatingRecipe
    ? undefined
    : (recipes.find((recipe) => recipe.id === selectedRecipeId) ?? recipes[0]);
  const selectedVersion = selectedRecipe
    ? latestVersion(selectedRecipe)
    : undefined;
  const sortedVersions = useMemo(
    () =>
      selectedRecipe?.recipe_versions
        .slice()
        .sort((a, b) => b.version - a.version) ?? [],
    [selectedRecipe],
  );

  async function loadCatalog() {
    setLoading(true);
    const db = createClient();
    const [{ data: itemRows }, { data: supplierRows }, { data: recipeRows }] =
      await Promise.all([
        db
          .from("inventory_items")
          .select("id,sku,name,unit,category,supplier_id,standard_unit_cost")
          .order("category")
          .order("name"),
        db
          .from("suppliers")
          .select("id,name,lead_days,is_active")
          .order("name"),
        db
          .from("recipes")
          .select(
            "id,name,selling_price,active_version,recipe_versions(id,version,batch_ml,serving_ml,carry_days,note,published_at,recipe_version_lines(item_id,quantity,inventory_items(id,name,unit,standard_unit_cost)))",
          )
          .order("name"),
      ]);
    const nextItems = (itemRows ?? []) as Item[];
    const nextRecipes = (recipeRows ?? []) as unknown as Recipe[];
    setItems(nextItems);
    setSuppliers((supplierRows ?? []) as Supplier[]);
    setRecipes(nextRecipes);
    setSelectedRecipeId((current) => current || nextRecipes[0]?.id || "");
    setLoading(false);
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  useEffect(() => {
    if (!selectedRecipe || !selectedVersion) return;
    setDraft({
      price: String(selectedRecipe.selling_price),
      carryDays: String(selectedVersion.carry_days),
      note: "",
      quantities: Object.fromEntries(
        selectedVersion.recipe_version_lines.map((line) => [
          line.item_id,
          String(line.quantity),
        ]),
      ),
    });
  }, [selectedRecipeId, recipes]);

  function changeQuantity(itemId: string, value: string) {
    setDraft((current) => ({
      ...current,
      quantities: { ...current.quantities, [itemId]: value },
    }));
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRecipe) return;
    const price = Number(draft.price);
    const carryDays = Number(draft.carryDays);
    const lines = Object.entries(draft.quantities)
      .map(([item_id, quantity]) => ({ item_id, quantity: Number(quantity) }))
      .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
    if (
      !Number.isFinite(price) ||
      price < 0 ||
      !Number.isInteger(carryDays) ||
      carryDays < 0 ||
      carryDays > 7 ||
      !draft.note.trim() ||
      !lines.length
    ) {
      setNotice({
        tone: "error",
        text: "Isi harga, batas simpan, alasan perubahan, dan minimal satu bahan.",
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    const { error } = await createClient().rpc("publish_recipe_version", {
      p_recipe_id: selectedRecipe.id,
      p_name: selectedRecipe.name,
      p_selling_price: price,
      p_carry_days: carryDays,
      p_note: draft.note.trim(),
      p_lines: lines,
    });
    setSaving(false);
    if (error) {
      setNotice({
        tone: "error",
        text: apiError(
          error,
          "Versi resep belum dapat diterbitkan. Periksa data lalu coba lagi.",
        ),
      });
      return;
    }
    setNotice({
      tone: "success",
      text: `${selectedRecipe.name} diterbitkan sebagai versi baru. Batch lama tidak berubah.`,
    });
    await loadCatalog();
  }

  async function createRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const price = Number(newDraft.price);
    const carryDays = Number(newDraft.carryDays);
    const lines = Object.entries(newDraft.quantities)
      .map(([item_id, quantity]) => ({ item_id, quantity: Number(quantity) }))
      .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
    if (
      !newDraft.name.trim() ||
      !Number.isFinite(price) ||
      price < 0 ||
      !Number.isInteger(carryDays) ||
      carryDays < 0 ||
      carryDays > 7 ||
      !newDraft.note.trim() ||
      !lines.length
    ) {
      setNotice({
        tone: "error",
        text: "Isi nama produk, harga, batas simpan, catatan, dan minimal satu bahan.",
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    const { error } = await createClient().rpc("publish_recipe_version", {
      p_recipe_id: null,
      p_name: newDraft.name.trim(),
      p_selling_price: price,
      p_carry_days: carryDays,
      p_note: newDraft.note.trim(),
      p_lines: lines,
    });
    setSaving(false);
    if (error) {
      setNotice({
        tone: "error",
        text: apiError(
          error,
          "Resep belum dapat diterbitkan. Periksa data lalu coba lagi.",
        ),
      });
      return;
    }
    setNotice({
      tone: "success",
      text: `${newDraft.name.trim()} diterbitkan sebagai versi 1.`,
    });
    setNewDraft({
      name: "",
      price: "",
      carryDays: "1",
      note: "",
      quantities: {},
    });
    setSelectedRecipeId("");
    await loadCatalog();
  }

  async function addSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("supplier_name") ?? "").trim();
    const leadDays = Number(form.get("lead_days"));
    if (!name || !Number.isInteger(leadDays) || leadDays < 0) {
      setNotice({
        tone: "error",
        text: "Masukkan nama pemasok dan lead time yang valid.",
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    const { error } = await createClient()
      .from("suppliers")
      .insert({ name, lead_days: leadDays, is_active: true });
    setSaving(false);
    if (error) {
      setNotice({
        tone: "error",
        text:
          error.code === "23505"
            ? "Pemasok dengan nama ini sudah ada."
            : apiError(error, "Pemasok belum dapat disimpan."),
      });
      return;
    }
    event.currentTarget.reset();
    setNotice({ tone: "success", text: "Pemasok ditambahkan." });
    await loadCatalog();
  }

  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const sku = String(form.get("sku") ?? "")
      .trim()
      .toUpperCase();
    const name = String(form.get("item_name") ?? "").trim();
    const unit = String(form.get("unit") ?? "").trim();
    const category = String(form.get("category") ?? "");
    const supplierId = String(form.get("supplier_id") ?? "") || null;
    const cost = Number(form.get("standard_unit_cost"));
    if (
      !sku ||
      !name ||
      !unit ||
      !["ingredient", "packaging"].includes(category) ||
      !Number.isFinite(cost) ||
      cost < 0
    ) {
      setNotice({
        tone: "error",
        text: "Lengkapi SKU, nama, unit, kategori, dan biaya standar.",
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    const { error } = await createClient().from("inventory_items").insert({
      sku,
      name,
      unit,
      category,
      supplier_id: supplierId,
      standard_unit_cost: cost,
    });
    setSaving(false);
    if (error) {
      setNotice({
        tone: "error",
        text:
          error.code === "23505"
            ? "SKU ini sudah digunakan."
            : apiError(error, "Item belum dapat disimpan."),
      });
      return;
    }
    event.currentTarget.reset();
    setNotice({ tone: "success", text: "Item master ditambahkan." });
    await loadCatalog();
  }

  return (
    <section className={styles.catalog} aria-label="Master katalog">
      <div className={styles.tabs} role="tablist" aria-label="Master katalog">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "recipes"}
          className={tab === "recipes" ? styles.tabActive : styles.tab}
          onClick={() => setTab("recipes")}
        >
          Resep Master
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "inventory"}
          className={tab === "inventory" ? styles.tabActive : styles.tab}
          onClick={() => setTab("inventory")}
        >
          Stok & Pemasok
        </button>
      </div>
      {notice ? (
        <div
          className={`${styles.notice} ${notice.tone === "error" ? styles.noticeError : styles.noticeSuccess}`}
          role="status"
        >
          {notice.text}
        </div>
      ) : null}

      {tab === "recipes" ? (
        <div className={styles.recipeLayout}>
          <aside className={styles.recipeList} aria-label="Daftar resep">
            <div className={styles.listHead}>
              <span>RESEP AKTIF</span>
              <small>{loading ? "Memuat…" : `${recipes.length} produk`}</small>
            </div>
            <button
              type="button"
              onClick={() => setSelectedRecipeId("__new__")}
              className={
                creatingRecipe ? styles.recipeActive : styles.recipeButton
              }
            >
              <strong>+ Resep baru</strong>
              <span>Terbitkan versi pertama</span>
            </button>
            {recipes.map((recipe) => (
              <button
                key={recipe.id}
                type="button"
                onClick={() => setSelectedRecipeId(recipe.id)}
                className={
                  recipe.id === selectedRecipe?.id
                    ? styles.recipeActive
                    : styles.recipeButton
                }
              >
                <strong>{recipe.name}</strong>
                <span>
                  V{recipe.active_version} ·{" "}
                  {money.format(Number(recipe.selling_price))}
                </span>
              </button>
            ))}
            {!loading && !recipes.length ? (
              <p className={styles.muted}>
                Belum ada resep. Pilih “Resep baru”.
              </p>
            ) : null}
          </aside>
          <div className={styles.recipeContent}>
            {loading ? (
              <div className={styles.loading}>Memuat Resep Master…</div>
            ) : creatingRecipe ? (
              <form className={styles.editor} onSubmit={createRecipe}>
                <div className={styles.editorHead}>
                  <div>
                    <div className={styles.eyebrow}>RESEP BARU</div>
                    <h3>Terbitkan versi pertama</h3>
                  </div>
                  <p>Standar ini akan dipakai untuk produksi 900 ml.</p>
                </div>
                <div className={styles.formGrid}>
                  <label>
                    Nama produk
                    <input
                      value={newDraft.name}
                      onChange={(event) =>
                        setNewDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="Americano"
                      required
                    />
                  </label>
                  <label>
                    Harga jual
                    <input
                      value={newDraft.price}
                      onChange={(event) =>
                        setNewDraft((current) => ({
                          ...current,
                          price: event.target.value,
                        }))
                      }
                      type="number"
                      min="0"
                      step="500"
                      required
                    />
                  </label>
                  <label>
                    Batas simpan (hari)
                    <input
                      value={newDraft.carryDays}
                      onChange={(event) =>
                        setNewDraft((current) => ({
                          ...current,
                          carryDays: event.target.value,
                        }))
                      }
                      type="number"
                      min="0"
                      max="7"
                      step="1"
                      required
                    />
                  </label>
                </div>
                <div className={styles.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th>Bahan per 900 ml</th>
                        <th>Unit</th>
                        <th>Jumlah tepat</th>
                        <th>Biaya standar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items
                        .filter((item) => item.category === "ingredient")
                        .map((item) => (
                          <tr key={item.id}>
                            <td>
                              <strong>{item.name}</strong>
                              <small>{item.sku}</small>
                            </td>
                            <td>{item.unit}</td>
                            <td>
                              <input
                                aria-label={`Jumlah ${item.name}`}
                                value={newDraft.quantities[item.id] ?? ""}
                                onChange={(event) =>
                                  setNewDraft((current) => ({
                                    ...current,
                                    quantities: {
                                      ...current.quantities,
                                      [item.id]: event.target.value,
                                    },
                                  }))
                                }
                                type="number"
                                min="0"
                                step="0.001"
                                placeholder="0"
                              />
                            </td>
                            <td>
                              {money.format(Number(item.standard_unit_cost))}
                              <small>per {item.unit}</small>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {!items.some((item) => item.category === "ingredient") ? (
                  <p className={styles.muted}>
                    Tambahkan bahan baku di tab Stok & Pemasok terlebih dahulu.
                  </p>
                ) : null}
                <label className={styles.note}>
                  Catatan versi
                  <textarea
                    value={newDraft.note}
                    onChange={(event) =>
                      setNewDraft((current) => ({
                        ...current,
                        note: event.target.value,
                      }))
                    }
                    rows={3}
                    placeholder="Contoh: Standar awal peluncuran."
                    required
                  />
                </label>
                <div className={styles.formFooter}>
                  <span>
                    900 ml per batch · 150 ml per serving · 6 serving teoritis.
                  </span>
                  <button
                    type="submit"
                    disabled={
                      saving ||
                      !items.some((item) => item.category === "ingredient")
                    }
                  >
                    {saving ? "Menerbitkan…" : "Terbitkan versi 1"}
                  </button>
                </div>
              </form>
            ) : selectedRecipe && selectedVersion ? (
              <>
                <header className={styles.recipeHeader}>
                  <div>
                    <div className={styles.eyebrow}>
                      RESEP AKTIF · V{selectedVersion.version}
                    </div>
                    <h2>{selectedRecipe.name}</h2>
                    <p>
                      Batch 900 ml · 150 ml per serving · 6 serving teoritis.
                      Publikasi hanya memengaruhi produksi berikutnya.
                    </p>
                  </div>
                  <div className={styles.versionTag}>
                    Aktif
                    <br />
                    <strong>V{selectedVersion.version}</strong>
                  </div>
                </header>
                <div className={styles.specs}>
                  <div>
                    <span>Batch</span>
                    <strong>{selectedVersion.batch_ml} ml</strong>
                  </div>
                  <div>
                    <span>Serving</span>
                    <strong>{selectedVersion.serving_ml} ml</strong>
                  </div>
                  <div>
                    <span>Batas simpan</span>
                    <strong>{selectedVersion.carry_days} hari</strong>
                  </div>
                  <div>
                    <span>Harga jual</span>
                    <strong>
                      {money.format(Number(selectedRecipe.selling_price))}
                    </strong>
                  </div>
                </div>
                <form className={styles.editor} onSubmit={publish}>
                  <div className={styles.editorHead}>
                    <div>
                      <div className={styles.eyebrow}>TERBITKAN VERSI BARU</div>
                      <h3>Ubah standar produksi berikutnya</h3>
                    </div>
                    <p>Versi aktif dan histori batch tidak ditimpa.</p>
                  </div>
                  <div className={styles.formGrid}>
                    <label>
                      Harga jual
                      <input
                        value={draft.price}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            price: event.target.value,
                          }))
                        }
                        inputMode="decimal"
                        type="number"
                        min="0"
                        step="500"
                        required
                      />
                    </label>
                    <label>
                      Batas simpan (hari)
                      <input
                        value={draft.carryDays}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            carryDays: event.target.value,
                          }))
                        }
                        type="number"
                        min="0"
                        max="7"
                        step="1"
                        required
                      />
                    </label>
                  </div>
                  <div className={styles.tableWrap}>
                    <table>
                      <thead>
                        <tr>
                          <th>Bahan per 900 ml</th>
                          <th>Unit</th>
                          <th>Jumlah</th>
                          <th>Biaya standar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items
                          .filter((item) => item.category === "ingredient")
                          .map((item) => (
                            <tr key={item.id}>
                              <td>
                                <strong>{item.name}</strong>
                                <small>{item.sku}</small>
                              </td>
                              <td>{item.unit}</td>
                              <td>
                                <input
                                  aria-label={`Jumlah ${item.name}`}
                                  value={draft.quantities[item.id] ?? ""}
                                  onChange={(event) =>
                                    changeQuantity(item.id, event.target.value)
                                  }
                                  type="number"
                                  min="0"
                                  step="0.001"
                                  placeholder="0"
                                />
                              </td>
                              <td>
                                {money.format(Number(item.standard_unit_cost))}
                                <small>per {item.unit}</small>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <label className={styles.note}>
                    Alasan perubahan
                    <textarea
                      value={draft.note}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          note: event.target.value,
                        }))
                      }
                      rows={3}
                      placeholder="Contoh: Sesuaikan susu untuk konsistensi rasa."
                      required
                    />
                  </label>
                  <div className={styles.formFooter}>
                    <span>
                      Versi {selectedVersion.version + 1} akan dipakai untuk
                      batch baru.
                    </span>
                    <button type="submit" disabled={saving}>
                      {saving
                        ? "Menerbitkan…"
                        : `Terbitkan versi ${selectedVersion.version + 1}`}
                    </button>
                  </div>
                </form>
                <section className={styles.history}>
                  <div className={styles.editorHead}>
                    <div>
                      <div className={styles.eyebrow}>RIWAYAT VERSI</div>
                      <h3>Catatan perubahan</h3>
                    </div>
                  </div>
                  {sortedVersions.map((version) => (
                    <article className={styles.historyRow} key={version.id}>
                      <div>
                        <strong>
                          Versi {version.version}
                          {version.version === selectedRecipe.active_version
                            ? " · Aktif"
                            : ""}
                        </strong>
                        <span>
                          {new Intl.DateTimeFormat("id-ID", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(version.published_at))}{" "}
                          · Batas simpan {version.carry_days} hari
                        </span>
                      </div>
                      <p>{version.note}</p>
                    </article>
                  ))}
                </section>
              </>
            ) : (
              <div className={styles.loading}>
                Pilih resep untuk melihat detail.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.inventoryLayout}>
          <section className={styles.inventoryPanel}>
            <header className={styles.sectionHead}>
              <div>
                <div className={styles.eyebrow}>PEMASOK</div>
                <h2>Daftar pemasok</h2>
              </div>
              <span>{suppliers.length} aktif</span>
            </header>
            <form className={styles.inlineForm} onSubmit={addSupplier}>
              <input name="supplier_name" placeholder="Nama pemasok" required />
              <input
                name="lead_days"
                aria-label="Lead time hari"
                type="number"
                min="0"
                step="1"
                placeholder="Lead time"
                required
              />
              <button disabled={saving} type="submit">
                Tambah
              </button>
            </form>
            <div className={styles.rows}>
              {suppliers.map((supplier) => (
                <div className={styles.row} key={supplier.id}>
                  <div>
                    <strong>{supplier.name}</strong>
                    <small>
                      {supplier.is_active ? "Aktif" : "Tidak aktif"}
                    </small>
                  </div>
                  <span>{supplier.lead_days} hari</span>
                </div>
              ))}
              {!loading && !suppliers.length ? (
                <p className={styles.muted}>Belum ada pemasok.</p>
              ) : null}
            </div>
          </section>
          <section className={styles.inventoryPanel}>
            <header className={styles.sectionHead}>
              <div>
                <div className={styles.eyebrow}>MASTER ITEM</div>
                <h2>Bahan dan kemasan</h2>
              </div>
              <span>{items.length} item</span>
            </header>
            <form className={styles.itemForm} onSubmit={addItem}>
              <input name="sku" placeholder="SKU · contoh CUP-12OZ" required />
              <input name="item_name" placeholder="Nama item" required />
              <select name="category" defaultValue="ingredient">
                <option value="ingredient">Bahan baku</option>
                <option value="packaging">Kemasan</option>
              </select>
              <input name="unit" placeholder="Unit · ml / g / pcs" required />
              <select name="supplier_id" defaultValue="">
                <option value="">Tanpa pemasok</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
              <input
                name="standard_unit_cost"
                type="number"
                min="0"
                step="0.01"
                placeholder="Biaya per unit"
                required
              />
              <button disabled={saving} type="submit">
                Tambah item
              </button>
            </form>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Tipe</th>
                    <th>Pemasok</th>
                    <th>Biaya standar</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.name}</strong>
                        <small>
                          {item.sku} · {item.unit}
                        </small>
                      </td>
                      <td>
                        {item.category === "ingredient"
                          ? "Bahan baku"
                          : "Kemasan"}
                      </td>
                      <td>
                        {suppliers.find(
                          (supplier) => supplier.id === item.supplier_id,
                        )?.name ?? "—"}
                      </td>
                      <td>
                        {money.format(Number(item.standard_unit_cost))}
                        <small>per {item.unit}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loading && !items.length ? (
              <p className={styles.muted}>Belum ada item master.</p>
            ) : null}
          </section>
        </div>
      )}
    </section>
  );
}

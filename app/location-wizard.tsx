"use client";

import { FormEvent, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PaymentProfiles } from "./payment-profiles";
import { LocationDetail } from "./location-detail";
import { fetchJson } from "@/lib/fetch-json";

type Location = {
  id: string;
  code: string;
  name: string;
  city: string;
  timezone: string;
  is_active: boolean;
  opening_date: string | null;
};
type External = { id: string; name: string };
type Recipe = { id: string; name: string };

function productKey(value: string) {
  return value
    .replace(/^\[demo\]\s*/i, "")
    .trim()
    .toLocaleLowerCase("id-ID")
    .replace(/[^a-z0-9]+/g, "");
}

function matchRecipeItems(recipes: Recipe[], items: External[]) {
  const next: Record<string, string> = {};
  for (const recipe of recipes) {
    const match = items.find((item) => productKey(item.name) === productKey(recipe.name));
    if (match) next[recipe.id] = match.id;
  }
  return next;
}
const steps = [
  "Tambah Lokasi",
  "Sambungkan Loyverse",
  "Pilih Gerai",
  "Pemetaan Produk",
  "Uji Koneksi",
  "Selesai",
];
const errorText: Record<string, string> = {
  credential_storage_not_configured:
    "Penyimpanan kredensial server belum dikonfigurasi. Tidak ada token yang disimpan.",
  loyverse_auth_failed: "Token Loyverse tidak valid atau tidak memiliki akses.",
  loyverse_unavailable: "Loyverse tidak dapat dihubungi. Coba lagi.",
  required_products_not_mapped: "Semua produk peluncuran harus dipetakan.",
  store_not_found: "Gerai tidak ditemukan di akun ini.",
  mapped_item_not_found: "Salah satu item Loyverse tidak ditemukan.",
};

export function LocationWizard() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Location | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [stores, setStores] = useState<External[]>([]);
  const [items, setItems] = useState<External[]>([]);
  const [storeId, setStoreId] = useState("");
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [replacingConnection, setReplacingConnection] = useState(false);

  async function load() {
    const db = createClient();
    const [locationResult, recipeResult] = await Promise.all([
      db
        .from("locations")
        .select("id,code,name,city,timezone,is_active,opening_date")
        .is("archived_at", null)
        .order("code"),
      db.from("recipes").select("id,name").order("name"),
    ]);
    setLocations(locationResult.data ?? []);
    setRecipes(recipeResult.data ?? []);
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        setOpen(false);
        if (replacingConnection && created) setSelectedLocation(created);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [created, open, pending, replacingConnection]);
  function resetWizard() {
    setOpen(true);
    setStep(0);
    setError("");
    setCreated(null);
    setConnectionId("");
    setStores([]);
    setItems([]);
    setStoreId("");
    setMappings({});
    setReplacingConnection(false);
  }
  function configurePos(location: Location) {
    setCreated(location);
    setConnectionId("");
    setStores([]);
    setItems([]);
    setStoreId("");
    setMappings({});
    setError("");
    setStep(1);
    setReplacingConnection(location.is_active);
    setSelectedLocation(null);
    setOpen(true);
    void resumePendingConnection(location);
  }

  async function resumePendingConnection(location: Location) {
    setPending(true);
    try {
      const { response, body } = await fetchJson<{
        connectionId?: string;
        stores?: External[];
        items?: External[];
        suggestedStoreId?: string;
      }>(`/api/admin/pos-connections?locationId=${encodeURIComponent(location.id)}`, undefined, 45000);
      if (!response.ok || !body.connectionId) return;
      const resumedItems = body.items ?? [];
      const resumedMappings = matchRecipeItems(recipes, resumedItems);
      setConnectionId(body.connectionId);
      setStores(body.stores ?? []);
      setItems(resumedItems);
      setStoreId(body.suggestedStoreId ?? "");
      setMappings(resumedMappings);
      const readyForTest =
        Boolean(body.suggestedStoreId) &&
        recipes.length > 0 &&
        recipes.every((recipe) => resumedMappings[recipe.id]);
      setStep(readyForTest ? 4 : 2);
    } finally {
      setPending(false);
    }
  }
  function closeWizard() {
    setOpen(false);
    if (replacingConnection && created) setSelectedLocation(created);
  }

  async function createLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get("name") ?? "").trim(),
      code: String(form.get("code") ?? "")
        .trim()
        .toUpperCase(),
      city: String(form.get("city") ?? "").trim(),
      timezone: String(form.get("timezone") ?? "Asia/Jakarta"),
      opening_date: String(form.get("opening_date") ?? "") || null,
      is_active: false,
    };
    try {
      const { data, error: insertError } = await createClient()
        .from("locations")
        .insert(payload)
        .select("id,code,name,city,timezone,is_active,opening_date")
        .single();
      if (insertError) {
        setError(
          insertError.code === "23505"
            ? "Kode cart sudah digunakan."
            : "Lokasi belum dapat disimpan. Periksa data lalu coba lagi.",
        );
        return;
      }
      setCreated(data);
      setStep(1);
      await load();
    } catch {
      setError("Koneksi terlalu lama. Periksa jaringan lalu coba lagi.");
    } finally {
      setPending(false);
    }
  }
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!created) return;
    setPending(true);
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const { response, body } = await fetchJson<{ error?: string; connectionId?: string; stores?: External[]; items?: External[]; suggestedStoreId?: string; suggestedMappings?: Record<string, string> }>("/api/admin/pos-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locationId: created.id,
          accessToken: form.get("accessToken"),
        }),
      }, 45000);
      if (!response.ok) {
        setError(errorText[body.error ?? ""] ?? "Koneksi belum dapat disimpan.");
        return;
      }
      setConnectionId(body.connectionId ?? "");
      const availableStores = body.stores ?? [];
      const availableItems = body.items ?? [];
      setStores(availableStores);
      setItems(availableItems);
      const suggestedMappings = body.suggestedMappings ?? {};
      const suggestedStoreId = body.suggestedStoreId ?? "";
      setMappings(suggestedMappings);
      setStoreId(suggestedStoreId);
      formElement.reset();
      const canReuseConfiguration =
        replacingConnection &&
        Boolean(suggestedStoreId) &&
        availableStores.some((store) => store.id === suggestedStoreId) &&
        recipes.length > 0 &&
        recipes.every((recipe) =>
          availableItems.some(
            (item) => item.id === suggestedMappings[recipe.id],
          ),
        );
      setStep(canReuseConfiguration ? 4 : 2);
    } catch {
      setError("Loyverse belum merespons. Coba lagi beberapa saat.");
    } finally {
      setPending(false);
    }
  }
  async function testAndActivate() {
    if (!created || !connectionId || !storeId) return;
    setPending(true);
    setError("");
    const productMappings = recipes
      .map((recipe) => ({ recipeId: recipe.id, itemId: mappings[recipe.id] }))
      .filter((mapping) => mapping.itemId);
    try {
      const { response, body } = await fetchJson<{ error?: string }>("/api/admin/pos-connections", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, storeId, mappings: productMappings }),
      });
      if (!response.ok) {
        setError(
          errorText[body.error ?? ""] ??
            "Pengujian belum lulus. Periksa gerai dan pemetaan produk.",
        );
        return;
      }
      setStep(5);
      await load();
    } catch {
      setError("Pengujian terlalu lama. Coba lagi beberapa saat.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 14 }}>
      {selectedLocation ? (
        <LocationDetail
          location={selectedLocation}
          onBack={() => setSelectedLocation(null)}
          onArchived={() => {
            setSelectedLocation(null);
            void load();
          }}
          onConfigurePos={() => configurePos(selectedLocation)}
        />
      ) : (
        <>
      <div className="eyebrow">LOKASI</div>
      <h3>Lokasi dan cart</h3>
      <p>Pilih cart untuk melihat penjualan, stok, koneksi, dan rekonsiliasi.</p>
      <button className="primary" type="button" onClick={resetWizard}>
        + Tambah Lokasi
      </button>
      <ul className="list">
        {locations.length ? (
          locations.map((location) => (
            <li className="locationListItem" key={location.id}>
              <button
                className="locationOpenButton"
                type="button"
                onClick={() => setSelectedLocation(location)}
              >
              <span className="locationIdentity">
                <span className="locationCopy">
                  <strong>{location.code}</strong>
                  <small>{location.name} · {location.city}</small>
                </span>
                <span className="pill">
                  {location.is_active ? "AKTIF" : "BELUM TERHUBUNG"}
                </span>
              </span>
              <span className="locationChevron" aria-hidden="true">→</span>
              </button>
              {!location.is_active ? (
                <button className="locationSetupButton" type="button" onClick={() => configurePos(location)}>
                  Lanjutkan setup
                </button>
              ) : null}
            </li>
          ))
        ) : (
          <li>Belum ada lokasi. Tambahkan lokasi pertama.</li>
        )}
      </ul>
      {open ? (
        <div
          className="wizardBackdrop"
          onMouseDown={() => {
            if (!pending) closeWizard();
          }}
        >
          <div
            className="wizardDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="location-wizard-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="wizardHead">
              <div>
                <div className="eyebrow">
                  {replacingConnection
                    ? "KONEKSI LOYVERSE"
                    : `PENGATURAN LOKASI · ${step + 1}/6`}
                </div>
                <h3 id="location-wizard-title">
                  {replacingConnection && step === 1 ? "Ganti access token" : steps[step]}
                </h3>
              </div>
              <button
                className="wizardClose"
                type="button"
                disabled={pending}
                onClick={closeWizard}
                aria-label="Tutup pengaturan lokasi"
              >
                ×
              </button>
            </div>
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
          {step === 0 ? (
            <form className="form" onSubmit={createLocation}>
              <label>
                Nama lokasi
                <input name="name" required placeholder="Kawansela Jakarta" />
              </label>
              <label>
                Kode cart
                <input
                  name="code"
                  required
                  placeholder="JKT-001"
                  pattern="[A-Za-z0-9-]+"
                />
              </label>
              <label>
                Kota
                <input name="city" required placeholder="Jakarta" />
              </label>
              <label>
                Zona waktu
                <select name="timezone" defaultValue="Asia/Jakarta">
                  <option>Asia/Jakarta</option>
                  <option>Asia/Makassar</option>
                  <option>Asia/Jayapura</option>
                </select>
              </label>
              <label>
                Tanggal mulai
                <input name="opening_date" type="date" />
              </label>
              <button className="primary" disabled={pending}>
                {pending ? "Menyimpan…" : "Simpan dan lanjutkan"}
              </button>
            </form>
          ) : null}
          {step === 1 ? (
            <form className="form" onSubmit={connect}>
              <p>
                Masukkan access token Loyverse untuk {created?.code}. Token lama
                tidak ditampilkan. Koneksi lama tetap aktif sampai token baru
                lulus pengujian.
              </p>
              <label>
                Token akses Loyverse
                <input
                  name="accessToken"
                  type="password"
                  autoComplete="off"
                  required
                />
              </label>
              <button className="primary" disabled={pending}>
                {pending ? "Menghubungkan…" : "Sambungkan Loyverse"}
              </button>
            </form>
          ) : null}
          {step === 2 ? (
            <div className="form">
              <p>Pilih gerai Loyverse untuk {created?.code}.</p>
              {stores.map((store) => (
                <label key={store.id}>
                  <input
                    type="radio"
                    name="store"
                    value={store.id}
                    checked={storeId === store.id}
                    onChange={() => setStoreId(store.id)}
                  />{" "}
                  {store.name}
                </label>
              ))}
              {!stores.length ? (
                <div className="notice">Akun ini tidak memiliki gerai.</div>
              ) : null}
              <button
                className="primary"
                type="button"
                disabled={!storeId}
                onClick={() => setStep(3)}
              >
                Lanjut ke Pemetaan Produk
              </button>
            </div>
          ) : null}
          {step === 3 ? (
            <div className="form">
              <p>
                Petakan setiap produk Kawansela ke item Loyverse menggunakan ID
                tetap.
              </p>
              {recipes.map((recipe) => (
                <label key={recipe.id}>
                  {recipe.name}
                  <select
                    value={mappings[recipe.id] ?? ""}
                    onChange={(event) =>
                      setMappings((current) => ({
                        ...current,
                        [recipe.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Belum dipetakan</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {!recipes.length ? (
                <div className="notice">
                  Terbitkan Resep Master sebelum mengaktifkan lokasi.
                </div>
              ) : null}
              <button
                className="primary"
                type="button"
                disabled={
                  !recipes.length ||
                  recipes.some((recipe) => !mappings[recipe.id])
                }
                onClick={() => setStep(4)}
              >
                Lanjut ke Uji Koneksi
              </button>
            </div>
          ) : null}
          {step === 4 ? (
            <div className="form">
              <p>
                Uji koneksi memeriksa autentikasi, gerai, pemetaan produk, dan
                akses penjualan.
              </p>
              <button
                className="primary"
                type="button"
                disabled={pending}
                onClick={() => void testAndActivate()}
              >
                {pending ? "Menguji…" : "Jalankan uji koneksi"}
              </button>
            </div>
          ) : null}
          {step === 5 ? (
            <div className="form">
              <div className="notice">
                <strong>
                  {replacingConnection
                    ? `Access token ${created?.code} berhasil diganti.`
                    : `${created?.code} siap digunakan.`}
                </strong>
                <br />
                Loyverse: Terhubung ✓<br />
                Gerai: {stores.find((store) => store.id === storeId)?.name}
                <br />
                Produk: {Object.keys(mappings).filter((recipeId) => mappings[recipeId]).length}/{recipes.length} dipetakan
                <br />
                Sinkronisasi: Aktif
              </div>
              <button
                className="primary"
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (created) setSelectedLocation({ ...created, is_active: true });
                }}
              >
                Buka lokasi
              </button>
            </div>
          ) : null}
          {step > 0 && step < 5 ? (
            <button
              className="wizardBack"
              type="button"
              onClick={() => {
                if (step === 1) closeWizard();
                else setStep((value) => Math.max(1, value - 1));
              }}
            >
              {step === 1 ? "Batal" : "Kembali"}
            </button>
          ) : null}
          </div>
        </div>
      ) : null}
      <PaymentProfiles locations={locations} />
        </>
      )}
    </section>
  );
}

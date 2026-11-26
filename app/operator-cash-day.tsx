"use client";

import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./operator-cash-day.module.css";

type MovementKind = "income" | "expense";
type CashMovement = { id: string; kind: MovementKind; amount: number; reason: string; occurred_at: string; request_id: string };
type CashDay = {
  business_date: string;
  timezone: string;
  day_id: string | null;
  opening_cash: number | null;
  opened_at: string | null;
  is_open: boolean;
  is_closed: boolean;
  income_total: number;
  expense_total: number;
  movements: CashMovement[];
};
export type CashDayState = CashDay;
type Intent = { locationId: string; date: string; kind: "begin" | MovementKind; amount: number; reason: string; requestId: string };
type RpcFailure = { code?: string; message?: string };
const maxCashAmount = 999_999_999_999;
const money = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });

function featureMissing(error: RpcFailure) {
  return ["PGRST202", "42883", "42P01"].includes(error.code ?? "");
}
function readDay(value: unknown): CashDay {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cash day");
  const row = value as Record<string, unknown>;
  const numeric = (v: unknown) => typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (typeof row.business_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.business_date) || typeof row.timezone !== "string" || typeof row.is_open !== "boolean" || typeof row.is_closed !== "boolean" || !Array.isArray(row.movements)) throw new Error("Invalid cash day");
  new Intl.DateTimeFormat("id-ID", { timeZone: row.timezone }).format();
  const opening = row.opening_cash === null ? null : numeric(row.opening_cash);
  const income = numeric(row.income_total), expense = numeric(row.expense_total);
  if ((opening !== null && (!Number.isFinite(opening) || opening < 0)) || !Number.isFinite(income) || income < 0 || !Number.isFinite(expense) || expense < 0 || (row.is_open && opening === null)) throw new Error("Invalid cash totals");
  const movements = row.movements.map((value): CashMovement => {
    if (!value || typeof value !== "object") throw new Error("Invalid cash movement");
    const m = value as Record<string, unknown>, amount = numeric(m.amount);
    if (typeof m.id !== "string" || !["income", "expense"].includes(String(m.kind)) || !Number.isFinite(amount) || amount <= 0 || typeof m.reason !== "string" || typeof m.occurred_at !== "string" || !Number.isFinite(new Date(m.occurred_at).getTime()) || typeof m.request_id !== "string") throw new Error("Invalid cash movement");
    return { id: m.id, kind: m.kind as MovementKind, amount, reason: m.reason, occurred_at: m.occurred_at, request_id: m.request_id };
  });
  return { business_date: row.business_date, timezone: row.timezone, day_id: typeof row.day_id === "string" ? row.day_id : null, opening_cash: opening, opened_at: typeof row.opened_at === "string" ? row.opened_at : null, is_open: row.is_open, is_closed: row.is_closed, income_total: income, expense_total: expense, movements };
}
function dateLabel(day: CashDay) {
  return new Date(`${day.business_date}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}
function localTime(value: string, zone: string) {
  return new Date(value).toLocaleTimeString("id-ID", { timeZone: zone, hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

export function OperatorCashDay({ locationId, onCommitted, compact = false }: { locationId: string; onCommitted?: () => void; compact?: boolean }) {
  const uid = useId();
  const [day, setDay] = useState<CashDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [readError, setReadError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [formKind, setFormKind] = useState<MovementKind | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  const [status, setStatus] = useState("");
  const [retryLocked, setRetryLocked] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const busy = useRef(false);
  const readVersion = useRef(0);
  const scope = useRef(locationId);
  const mounted = useRef(true);
  const intent = useRef<Intent | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const committed = useRef(onCommitted);
  committed.current = onCommitted;
  scope.current = locationId;

  const refresh = useCallback(async () => {
    if (busy.current) return;
    const version = ++readVersion.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    try {
      const result = await createClient().rpc("get_operator_cash_day", { p_location_id: locationId, p_business_date: null }).abortSignal(controller.signal);
      if (!mounted.current || scope.current !== locationId || version !== readVersion.current) return;
      if (result.error) {
        setUnavailable(featureMissing(result.error));
        setReadError(featureMissing(result.error) ? "Pencatatan kas belum tersedia. Minta admin mengaktifkan fitur ini." : "Data kas belum dapat diperbarui. Periksa koneksi lalu muat ulang.");
        return;
      }
      const next = readDay(result.data);
      setDay(next); setReadError(""); setUnavailable(false);
      // A confirmed read can resolve a write whose response was lost.
      const previous = intent.current;
      if (previous && previous.locationId === locationId && previous.date === next.business_date && (previous.kind === "begin" ? next.opening_cash === previous.amount && next.day_id !== null : next.movements.some((m) => m.request_id === previous.requestId))) {
        intent.current = null; setRetryLocked(false); setFormKind(null); setAmount(""); setReason(""); setFormError(""); setStatus("Catatan sudah tersimpan dan telah dikonfirmasi dari server."); committed.current?.();
      }
    } catch {
      if (mounted.current && scope.current === locationId && version === readVersion.current) setReadError("Data kas belum dapat dimuat. Periksa koneksi lalu coba lagi.");
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current && scope.current === locationId && version === readVersion.current) setLoading(false);
    }
  }, [locationId]);

  useEffect(() => {
    mounted.current = true;
    busy.current = false; setPending(false); setDay(null); setFormKind(null); setAmount(""); setReason(""); setFormError(""); setStatus(""); setReadError(""); setUnavailable(false); setRetryLocked(false); intent.current = null;
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 45000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; readVersion.current += 1; window.clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  useEffect(() => { if (formKind || (compact && expanded && !day?.day_id)) input.current?.focus(); }, [formKind, compact, expanded, day?.day_id]);

  function chooseForm(kind: MovementKind) {
    intent.current = null; setRetryLocked(false); setFormKind(kind); setAmount(""); setReason(""); setFormError(""); setStatus("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || loading || !day || day.is_closed || readError || unavailable) return;
    const value = Number(amount), kind = day.day_id ? formKind : "begin";
    if (!kind || amount.trim() === "" || !Number.isSafeInteger(value) || value < 0 || value > maxCashAmount || (kind !== "begin" && value === 0)) { setFormError(kind === "begin" ? "Isi modal awal dalam rupiah penuh, maksimal Rp999.999.999.999. Masukkan 0 hanya jika memang tanpa modal." : "Isi rupiah penuh lebih dari 0, maksimal Rp999.999.999.999."); input.current?.focus(); return; }
    if (kind !== "begin" && !reason.trim()) { setFormError("Isi keperluan uang masuk atau pengeluaran ini."); return; }
    const operation = intent.current ?? { locationId, date: day.business_date, kind, amount: value, reason: reason.trim(), requestId: crypto.randomUUID() };
    intent.current = operation;
    busy.current = true; setPending(true); setFormError(""); setStatus(""); readVersion.current += 1;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    let refreshAfterRejection = false;
    try {
      const db = createClient();
      const result = operation.kind === "begin"
        ? await db.rpc("begin_operator_day", { p_location_id: operation.locationId, p_business_date: operation.date, p_opening_cash: operation.amount }).abortSignal(controller.signal)
        : await db.rpc("record_cash_movement", { p_location_id: operation.locationId, p_business_date: operation.date, p_kind: operation.kind, p_amount: operation.amount, p_reason: operation.reason, p_request_id: operation.requestId }).abortSignal(controller.signal);
      if (!mounted.current || scope.current !== operation.locationId) return;
      if (result.error) {
        if (["P0001", "22003", "42501"].includes(result.error.code ?? "")) {
          // PostgreSQL has rejected and rolled back this transaction; the operator can correct the form.
          intent.current = null; setRetryLocked(false);
          const message = (result.error.message ?? "").toLowerCase();
          if (message.includes("already closed")) { setFormError("Hari sudah ditutup. Catatan ini tidak disimpan. Memuat ulang kas…"); refreshAfterRejection = true; }
          else if (message.includes("opening cash is already recorded")) { setFormError("Modal awal sudah tersimpan dan tidak dapat diubah. Memuat ulang nilai yang tersimpan…"); refreshAfterRejection = true; }
          else if (message.includes("current local business date")) { setFormError("Tanggal operasional sudah berubah. Memuat ulang kas sebelum melanjutkan…"); refreshAfterRejection = true; }
          else if (result.error.code === "42501" || message.includes("not authorized")) { setFormError("Akun ini tidak memiliki akses mencatat kas lokasi ini. Hubungi admin."); refreshAfterRejection = true; }
          else if (result.error.code === "22003" || message.includes("amount") || message.includes("invalid opening cash")) setFormError("Jumlah ditolak. Gunakan rupiah penuh hingga Rp999.999.999.999.");
          else if (message.includes("record opening cash")) { setFormError("Modal awal belum tercatat. Memuat ulang kas agar hari dapat dimulai…"); refreshAfterRejection = true; }
          else setFormError("Catatan tidak disimpan. Periksa jumlah dan keperluan, lalu coba lagi.");
          return;
        }
        if (featureMissing(result.error)) { setUnavailable(true); setFormError("Pencatatan kas belum tersedia. Tidak ada keberhasilan yang dapat dikonfirmasi; hubungi admin."); }
        else { setFormError("Hasil simpan belum dapat dikonfirmasi. Muat ulang catatan atau coba lagi dengan rincian yang sama agar tidak tercatat ganda."); }
        setRetryLocked(true);
        return;
      }
      const next = readDay(result.data);
      if (next.business_date !== operation.date || (operation.kind === "begin" ? next.opening_cash !== operation.amount || !next.day_id : !next.movements.some((m) => m.request_id === operation.requestId))) throw new Error("Unconfirmed cash write");
      setDay(next); setReadError(""); setUnavailable(false); intent.current = null; setRetryLocked(false); setFormKind(null); setAmount(""); setReason("");
      setStatus(operation.kind === "begin" ? `Hari dimulai. Modal awal ${money.format(operation.amount)} tersimpan.` : `${operation.kind === "income" ? "Uang masuk" : "Pengeluaran"} ${money.format(operation.amount)} tersimpan: ${operation.reason}.`);
      committed.current?.();
    } catch {
      if (mounted.current && scope.current === operation.locationId) { setRetryLocked(true); setFormError("Koneksi terputus; hasil simpan belum terkonfirmasi. Muat ulang catatan atau coba lagi. Rincian dan identitas permintaan tetap sama."); }
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current && scope.current === operation.locationId) { busy.current = false; setPending(false); if (refreshAfterRejection) void refresh(); }
    }
  }

  const disabled = pending || loading || Boolean(readError) || unavailable || Boolean(day?.is_closed);
  const canMove = Boolean(day?.is_open && day.day_id && !day.is_closed);
  const movements = [...(day?.movements ?? [])].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  const shown = showAll ? movements : movements.slice(0, 4);
  const showingForm = Boolean(day && !day.is_closed && (!day.day_id || formKind));
  return (
    <section className={`${styles.card} ${compact ? styles.compact : ""}`} aria-labelledby={`${uid}-title`} aria-busy={pending}>
      <header className={styles.heading}>
        <div><h2 id={`${uid}-title`}>{compact ? "Kas gerobak" : day?.day_id ? "Kas hari ini" : "Mulai hari"}</h2>{day && <p className={styles.date}>{dateLabel(day)} · {day.timezone}</p>}</div>
        <button type="button" className={styles.refresh} disabled={loading || pending} onClick={() => void refresh()} aria-label="Muat ulang catatan kas">{loading ? "Memuat…" : "Muat ulang"}</button>
      </header>
      {status && <p className={styles.success} role="status">{status}</p>}
      {readError && <p className={styles.error} role="alert">{readError}</p>}
      {loading && !day && <p className={styles.note}>Memeriksa hari operasional dan catatan kas…</p>}
      {day?.is_closed && <p className={styles.closed}>Hari sudah ditutup. Modal awal dan catatan kas tidak dapat diubah.</p>}
      {compact && day && <div className={styles.compactSummary}>{day.day_id ? <><p>Modal awal <strong>{money.format(day.opening_cash ?? 0)}</strong></p>{!day.is_closed && <button type="button" className={styles.compactToggle} aria-expanded={expanded} aria-controls={`${uid}-details`} disabled={pending} onClick={() => setExpanded((value) => !value)}>{expanded ? "Tutup rincian kas" : "Kas & pengeluaran"}</button>}</> : <><p>Catat modal tunai sebelum mulai berjualan.</p>{!expanded && <button type="button" className={styles.primary} disabled={disabled} aria-expanded={expanded} aria-controls={`${uid}-details`} onClick={() => setExpanded(true)}>Mulai hari</button>}</>}</div>}
      <div id={`${uid}-details`} hidden={compact && !expanded}>
      {day?.day_id && <>
        <dl className={styles.totals}><div><dt>Modal awal</dt><dd>{money.format(day.opening_cash ?? 0)}</dd></div><div><dt>Uang masuk lain</dt><dd>{money.format(day.income_total)}</dd></div><div><dt>Pengeluaran</dt><dd>{money.format(day.expense_total)}</dd></div></dl>
        <p className={styles.note}>Modal awal dicatat sekali. Uang masuk di sini di luar penjualan Loyverse; pengeluaran dibayar dari kas gerobak. Refund tunai dicatat saat Tutup Hari, jangan catat lagi sebagai pengeluaran.</p>
        {canMove && !formKind && <div className={styles.actions}><button type="button" disabled={disabled} onClick={() => chooseForm("income")}>Uang masuk</button><button type="button" disabled={disabled} onClick={() => chooseForm("expense")}>Pengeluaran</button></div>}
      </>}
      {showingForm && !unavailable && <form className={styles.form} onSubmit={save} aria-label={!day?.day_id ? "Catat modal awal hari" : formKind === "income" ? "Catat uang masuk" : "Catat pengeluaran"}>
        {!day?.day_id && <p className={styles.note}>Hitung uang tunai yang tersedia sebelum mulai. Ini bukan penjualan dan tidak dapat diedit setelah tersimpan.</p>}
        {day?.day_id && <h3>{formKind === "income" ? "Uang masuk" : "Pengeluaran tunai"}</h3>}
        <label htmlFor={`${uid}-amount`}>{!day?.day_id ? "Modal awal (Rp)" : "Jumlah (Rp)"}</label>
        <input ref={input} id={`${uid}-amount`} type="number" inputMode="numeric" min={!day?.day_id ? 0 : 1} max={maxCashAmount} step="1" required value={amount} onChange={(event) => { setAmount(event.target.value); setFormError(""); }} disabled={disabled || retryLocked} placeholder={!day?.day_id ? "Masukkan hasil hitung" : "Masukkan jumlah rupiah"} aria-describedby={`${uid}-amount-help${formError ? ` ${uid}-error` : ""}`} />
        <small id={`${uid}-amount-help`}>Rupiah penuh, tanpa titik atau koma.{!day?.day_id && " Isi 0 jika memang tanpa modal tunai."}</small>
        {day?.day_id && <><label htmlFor={`${uid}-reason`}>Keperluan</label><input id={`${uid}-reason`} type="text" required maxLength={200} value={reason} onChange={(event) => { setReason(event.target.value); setFormError(""); }} disabled={disabled || retryLocked} placeholder={formKind === "income" ? "Contoh: tambahan modal dari penanggung jawab" : "Contoh: beli es batu"} /></>}
        {formError && <p id={`${uid}-error`} className={styles.error} role="alert">{formError}</p>}
        <div className={styles.formActions}>{day?.day_id && !retryLocked && <button type="button" className={styles.cancel} disabled={pending} onClick={() => { setFormKind(null); setAmount(""); setReason(""); setFormError(""); }}>Batal</button>}<button type="submit" className={styles.primary} disabled={disabled}>{pending ? "Menyimpan…" : retryLocked ? "Coba simpan lagi" : !day?.day_id ? "Mulai hari" : "Simpan catatan"}</button></div>
        {retryLocked && <p className={styles.note}>Rincian dikunci sampai hasil terkonfirmasi. Gunakan “Muat ulang” untuk memeriksa server atau “Coba simpan lagi” dengan permintaan yang sama.</p>}
      </form>}
      {unavailable && !readError && <p className={styles.error} role="alert">Fitur kas belum tersedia untuk lokasi ini. Hubungi admin sebelum melanjutkan.</p>}
      {day?.day_id && <details className={styles.history} open={movements.length > 0 || undefined}><summary>Catatan kas ({movements.length})</summary>{shown.length ? <ul>{shown.map((movement) => <li key={movement.id}><div><strong>{movement.reason}</strong><small>{movement.kind === "income" ? "Uang masuk" : "Pengeluaran"} · {localTime(movement.occurred_at, day.timezone)}</small></div><b className={movement.kind === "income" ? styles.income : styles.expense}>{movement.kind === "income" ? "+" : "−"}{money.format(movement.amount)}</b></li>)}</ul> : <p className={styles.note}>Belum ada uang masuk lain atau pengeluaran pada hari ini.</p>}{movements.length > 4 && <button type="button" className={styles.more} onClick={() => setShowAll((value) => !value)}>{showAll ? "Tampilkan 4 terbaru" : `Lihat semua ${movements.length} catatan`}</button>}</details>}
      </div>
    </section>
  );
}

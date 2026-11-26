import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "private, no-store" };
type Connection = {
  id: string; location_id: string; status: string; is_active: boolean;
  last_error: string | null; last_successful_sync_at: string | null;
  locations: { code: string; name: string } | { code: string; name: string }[] | null;
};

/** Only known, actionable categories leave the server. Raw provider responses
 * and database error strings may contain credentials or request details. */
function safeIssueMessage(error: string | null, kind: string) {
  if (kind === "refund" || kind === "void") return "Refund atau pembatalan perlu ditinjau admin sebelum ringkasan dinyatakan lengkap.";
  const message = error?.toLowerCase() ?? "";
  if (/mapping|pemetaan|not mapped/.test(message)) return "Pemetaan menu belum lengkap. Minta admin mencocokkan produk Loyverse.";
  if (/stock|stok|batch|inventory|insufficient/.test(message)) return "Stok atau batch belum sesuai. Periksa produksi dan jumlah tersedia bersama admin.";
  if (/total|price|harga|money/.test(message)) return "Harga atau total struk belum valid. Periksa struk asli di Loyverse.";
  if (/payment|pembayaran/.test(message)) return "Metode pembayaran perlu diperiksa admin.";
  return "Transaksi perlu diperiksa admin. Cocokkan nomor struk dengan Loyverse; jangan membuat struk ulang.";
}

function connectionMessage(connection: Connection) {
  const error = connection.last_error?.toLowerCase() ?? "";
  if (error.includes("402") || error.includes("payment_required") || error.includes("subscription")) return "Loyverse membatasi akses riwayat atau langganan API. Admin perlu memeriksa paket dan rentang riwayat Loyverse.";
  if (error.includes("401") || error.includes("403") || /token|credential|kredensial/.test(error)) return "Akses Loyverse perlu diperbarui oleh admin.";
  if (error.includes("429")) return "Loyverse membatasi permintaan sementara. Coba perbarui beberapa saat lagi.";
  if (!connection.last_successful_sync_at) return "Loyverse belum berhasil disinkronkan. Minta admin memeriksa koneksi.";
  return "Sinkronisasi Loyverse perlu diperiksa. Penjualan terbaru mungkin belum masuk.";
}

/** A session-scoped projection avoids exposing pos_connections (and its secret
 * references) merely to make the operator's receipt inbox readable. */
export async function GET(request: NextRequest) {
  const locationId = request.nextUrl.searchParams.get("locationId");
  if (locationId !== null && !uuid.test(locationId)) return NextResponse.json({ error: "invalid_location" }, { status: 400, headers: noStore });
  const session = await createClient();
  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const { data: memberships, error: membershipError } = await session.from("memberships").select("role,location_id").eq("user_id", user.id);
  if (membershipError) return NextResponse.json({ error: "access_unavailable" }, { status: 503, headers: noStore });
  const master = (memberships ?? []).some((membership) => membership.role === "master");
  if (!master && (!locationId || !(memberships ?? []).some((membership) => membership.location_id === locationId))) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  try {
    const db = createAdminClient();
    let connectionsQuery = db.from("pos_connections").select("id,location_id,status,is_active,last_error,last_successful_sync_at,locations(code,name)").eq("provider", "loyverse");
    if (locationId) connectionsQuery = connectionsQuery.eq("location_id", locationId);
    const { data, error } = await connectionsQuery;
    if (error) throw error;
    const connections = (data ?? []) as unknown as Connection[];
    if (!connections.length) return NextResponse.json({ pendingCount: 0, issueCount: 0, issues: [], connectionIssues: [] }, { headers: noStore });
    const ids = connections.map((connection) => connection.id);
    const fields = "id,pos_connection_id,external_receipt_id,event_kind,received_at,processed_at,processing_error";
    const [pending, warnings, pendingCount, warningCount] = await Promise.all([
      db.from("pos_receipt_events").select(fields).in("pos_connection_id", ids).is("processed_at", null).order("received_at", { ascending: false }).limit(50),
      db.from("pos_receipt_events").select(fields).in("pos_connection_id", ids).not("processed_at", "is", null).not("processing_error", "is", null).order("received_at", { ascending: false }).limit(50),
      db.from("pos_receipt_events").select("id", { count: "exact", head: true }).in("pos_connection_id", ids).is("processed_at", null),
      db.from("pos_receipt_events").select("id", { count: "exact", head: true }).in("pos_connection_id", ids).not("processed_at", "is", null).not("processing_error", "is", null),
    ]);
    if (pending.error || warnings.error || pendingCount.error || warningCount.error) throw new Error("issues_unavailable");
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const issues = [...(pending.data ?? []), ...(warnings.data ?? [])].sort((a,b) => Date.parse(b.received_at) - Date.parse(a.received_at)).slice(0,50).map((issue) => {
      const connection = connectionsById.get(issue.pos_connection_id);
      const location = Array.isArray(connection?.locations) ? connection.locations[0] : connection?.locations;
      return { id: issue.id, external_receipt_id: issue.external_receipt_id, event_kind: issue.event_kind, received_at: issue.received_at, processed_at: issue.processed_at, processing_error: safeIssueMessage(issue.processing_error, issue.event_kind), pos_connections: { location_id: connection?.location_id, locations: location ?? null } };
    });
    const connectionIssues = connections.filter((connection) => connection.is_active && (connection.status !== "healthy" || !connection.last_successful_sync_at || Date.now()-Date.parse(connection.last_successful_sync_at)>300_000)).map((connection) => {
      const location = Array.isArray(connection.locations) ? connection.locations[0] : connection.locations;
      return { location_id: connection.location_id, code: location?.code ?? "", status: connection.status, message: connectionMessage(connection), lastSuccessfulSyncAt: connection.last_successful_sync_at };
    });
    return NextResponse.json({ pendingCount: pendingCount.count ?? 0, issueCount: (pendingCount.count ?? 0)+(warningCount.count ?? 0), issues, connectionIssues }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "issues_unavailable" }, { status: 503, headers: noStore });
  }
}

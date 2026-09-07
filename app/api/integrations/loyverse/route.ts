import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { processLoyverseReceipts } from "@/lib/loyverse/sync";

// Deliberately server-only: provider credentials never reach the browser.
// Configure LOYVERSE_WEBHOOK_SECRET before enabling this endpoint in Loyverse.
export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-kawansela-webhook-secret");
  const configuredSecret = process.env.LOYVERSE_WEBHOOK_SECRET;
  if (
    !configuredSecret ||
    !secret ||
    secret.length !== configuredSecret.length ||
    !timingSafeEqual(Buffer.from(secret), Buffer.from(configuredSecret))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON payload" },
      { status: 400 },
    );
  }
  const connectionId = request.nextUrl.searchParams.get("connection_id");
  if (
    !connectionId ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(connectionId)
  )
    return NextResponse.json(
      { error: "valid connection_id is required" },
      { status: 400 },
    );
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { receipts?: unknown }).receipts)
  )
    return NextResponse.json(
      { error: "connection_id and receipts are required" },
      { status: 400 },
    );
  const receipts = (payload as { receipts: unknown[] }).receipts;
  if (receipts.length > 500)
    return NextResponse.json(
      { error: "maximum 500 receipts per request" },
      { status: 413 },
    );

  try {
    const result = await processLoyverseReceipts(
      connectionId,
      receipts as Parameters<typeof processLoyverseReceipts>[1],
    );
    return NextResponse.json(
      { accepted: true, provider: "loyverse", ...result },
      { status: result.pending ? 202 : 200 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Loyverse sync gagal.";
    return NextResponse.json(
      { accepted: false, provider: "loyverse", error: message },
      { status: 500 },
    );
  }
}

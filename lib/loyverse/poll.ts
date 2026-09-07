import "server-only";

import type { LoyverseReceipt } from "./types";

/** Fetch receipt pages on the server. Provider credentials never leave Vercel. */
export async function fetchLoyverseReceipts(
  token: string,
  storeId: string,
  since: string | null,
) {
  const from = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const receipts: LoyverseReceipt[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page += 1) {
    const url = new URL("https://api.loyverse.com/v1.0/receipts");
    url.searchParams.set("store_ids", storeId);
    url.searchParams.set("created_at_min", from);
    url.searchParams.set("limit", "250");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Loyverse HTTP ${response.status}`);
    const body = await response.json();
    if (Array.isArray(body.receipts)) receipts.push(...(body.receipts as LoyverseReceipt[]));
    cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    if (!cursor) return receipts;
  }
  throw new Error("Sinkronisasi Loyverse melebihi batas aman 10.000 receipt.");
}

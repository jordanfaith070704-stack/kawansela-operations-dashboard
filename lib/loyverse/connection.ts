import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Provider credentials are deliberately resolved by reference, never read from
 * browser input or returned from an API response. The resolver can later be
 * backed by Vercel/Supabase secret infrastructure without changing sync logic.
 */
export type PosConnectionSecret = {
  provider: "loyverse";
  accessToken: string;
};

export interface PosConnectionSecretResolver {
  resolve(secretReference: string): Promise<PosConnectionSecret>;
}

export type ConnectionSyncState = {
  connectionId: string;
  provider: "loyverse";
  externalAccountId: string | null;
  externalStoreId: string | null;
  cursor: Record<string, unknown>;
  lastSuccessfulSyncAt: string | null;
};

/** Read-only state for one connection; safe to use from server jobs only. */
export async function getConnectionSyncState(
  connectionId: string,
): Promise<ConnectionSyncState | null> {
  const { data, error } = await createAdminClient()
    .from("pos_connections")
    .select(
      "id, provider, external_account_id, external_store_id, sync_cursor, last_successful_sync_at",
    )
    .eq("id", connectionId)
    .eq("provider", "loyverse")
    .maybeSingle();
  if (error)
    throw new Error(`Tidak dapat membaca status koneksi POS: ${error.message}`);
  if (!data) return null;
  return {
    connectionId: data.id,
    provider: "loyverse",
    externalAccountId: data.external_account_id,
    externalStoreId: data.external_store_id,
    cursor: data.sync_cursor ?? {},
    lastSuccessfulSyncAt: data.last_successful_sync_at,
  };
}

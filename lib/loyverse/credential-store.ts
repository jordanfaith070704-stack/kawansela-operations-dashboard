import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

function encryptionKey() {
  const encoded = process.env.POS_CREDENTIAL_ENCRYPTION_KEY;
  if (!encoded) throw new Error("credential_storage_not_configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("credential_storage_not_configured");
  return key;
}

export function encryptProviderToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptProviderToken(secret: {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(secret.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(secret.auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function resolveProviderToken(connectionId: string) {
  const { data, error } = await createAdminClient()
    .from("pos_connection_secrets")
    .select("ciphertext,iv,auth_tag")
    .eq("pos_connection_id", connectionId)
    .single();
  if (error || !data) throw new Error("credential_not_found");
  return decryptProviderToken(data);
}

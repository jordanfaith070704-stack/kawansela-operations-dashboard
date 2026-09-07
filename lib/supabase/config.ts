/**
 * The Supabase URL and publishable key are intentionally safe for browser use.
 * Vercel environment variables override these defaults in every environment.
 * Never put a service-role key or provider credential in this module.
 */
export const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://zsixksbjoailhueicjcy.supabase.co";
export const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_k9QWSHxyOPVBaMddpkTLqw_ZP22PsRM";

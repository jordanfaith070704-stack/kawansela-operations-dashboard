import { createBrowserClient } from "@supabase/ssr";
import { supabasePublishableKey, supabaseUrl } from "./config";

export function createClient() {
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}

import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/config";

/** Completes the email-link flow and writes the session cookies server-side. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const requestedNext = url.searchParams.get("next");
  const safeNext = requestedNext?.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/";
  const redirect = new URL(safeNext, url.origin);
  const response = NextResponse.redirect(redirect);
  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items) =>
        items.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        ),
    },
  });

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("Missing confirmation token") };

  if (result.error)
    return NextResponse.redirect(
      new URL(
        "/login?error=Link%20masuk%20tidak%20valid%20atau%20sudah%20kedaluwarsa.",
        url.origin,
      ),
    );
  return response;
}

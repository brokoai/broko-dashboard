import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Optimistic gate + session refresh for the Supabase backend (runs in the proxy). */
export async function supabaseSessionProxy(request: NextRequest, url: string, key: string) {
  const toLogin = () => NextResponse.redirect(new URL("/login", request.url));
  let response = NextResponse.next({ request });
  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    return data.user ? response : toLogin();
  } catch {
    // Auth service unreachable: fail closed.
    return toLogin();
  }
}

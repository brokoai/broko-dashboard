import { NextResponse, type NextRequest } from "next/server";
import { DEMO_COOKIE } from "@/lib/backend/constants";
import { supabaseSessionProxy } from "@/lib/backend/supabase/proxy";

// Optimistic gate only. Real authorization happens in requireUser()/server actions
// and in the backend itself, never only here.
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/login") return NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && key) return supabaseSessionProxy(request, url, key);

  // No real backend configured: only the (dev-only) demo cookie can pass this gate,
  // and pages still re-validate it, so a forged cookie reaches nothing.
  return request.cookies.get(DEMO_COOKIE) ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|brand/|icon.jpeg).*)"],
};

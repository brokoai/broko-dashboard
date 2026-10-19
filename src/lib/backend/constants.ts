// Shared with src/proxy.ts, so this file must not import server-only code.
/** Signed demo session cookie (HttpOnly). */
export const DEMO_COOKIE = "broko_demo_session";
/** Signed, bounded per-visitor demo data cookie (HttpOnly). */
export const DEMO_STATE_COOKIE = "broko_demo_state";

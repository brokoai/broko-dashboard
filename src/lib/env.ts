import "server-only";

export const supabaseConfigured = (): boolean =>
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** True if the process looks like a production deployment, whatever NODE_ENV says. */
const looksLikeProduction = (): boolean =>
  process.env.NODE_ENV === "production" ||
  process.env.BROKO_ENV === "production" ||
  process.env.VERCEL_ENV === "production" ||
  Boolean(process.env.AWS_EXECUTION_ENV) ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Demo mode: in-memory fake data with fake sign-in. Only when no real backend is
 * configured, explicitly enabled, and never in anything that looks like production.
 */
export const demoMode = (): boolean =>
  !supabaseConfigured() && process.env.BROKO_DEMO_MODE === "true" && !looksLikeProduction();

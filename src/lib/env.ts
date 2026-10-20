import "server-only";

type Env = Record<string, string | undefined>;

const SUPABASE_NAME = /^(NEXT_PUBLIC_)?SUPABASE_/i;
// Supabase's Vercel integration also injects these Postgres connection variables.
const SUPABASE_POSTGRES_NAME = /^POSTGRES_(URL|PRISMA_URL|URL_NON_POOLING)$/i;

/**
 * True if ANY Supabase configuration is present (any SUPABASE_* / NEXT_PUBLIC_SUPABASE_* variable,
 * or the integration's Postgres URLs) with a non-empty value. Demo mode must then be impossible.
 * Deliberately broad and conservative: a whitespace-only value still counts as present.
 */
export const supabasePresent = (env: Env): boolean =>
  Object.entries(env).some(([name, value]) => (SUPABASE_NAME.test(name) || SUPABASE_POSTGRES_NAME.test(name)) && !!value);

/** True if the real Supabase backend can be used (both public values set). */
export const supabaseUsable = (env: Env): boolean =>
  Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** True if the process looks like a production deployment, whatever NODE_ENV says. */
export const looksLikeProduction = (env: Env): boolean =>
  env.NODE_ENV === "production" ||
  env.BROKO_ENV === "production" ||
  env.VERCEL_ENV === "production" ||
  Boolean(env.AWS_EXECUTION_ENV) ||
  Boolean(env.AWS_LAMBDA_FUNCTION_NAME);

export const MIN_SESSION_SECRET_LENGTH = 32;

/** Cheap guard against obviously weak secrets (generate a real one with a CSPRNG; see docs/DEMO_MODE.md). */
export const strongEnoughSecret = (s: string | undefined): s is string =>
  !!s && s.length >= MIN_SESSION_SECRET_LENGTH && new Set(s).size >= 12;

export interface DemoConfig {
  enabled: boolean;
  /** Random server-only secret that keys the demo cookie signatures. Never sent to the browser. */
  sessionSecret?: string;
  /** Why demo is off (for logs/tests; never shown to users). */
  reason?: string;
}

/**
 * Demo mode = synthetic data, no real backend, no password. Rules:
 *  - Impossible whenever any Supabase configuration is present.
 *  - Needs BROKO_DEMO_MODE=true.
 *  - Production-like environments additionally need BROKO_ALLOW_PRODUCTION_DEMO=true AND a strong
 *    BROKO_DEMO_SESSION_SECRET (>= 32 chars, random) so demo cookies cannot be forged. Otherwise
 *    demo stays off.
 * Local development needs only BROKO_DEMO_MODE=true (a fixed, non-secret development key is used).
 * BROKO_DEMO_ACCESS_CODE is no longer used; if it is still set, it is ignored.
 */
export function resolveDemoConfig(env: Env): DemoConfig {
  if (supabasePresent(env)) return { enabled: false, reason: "supabase-present" };
  if (env.BROKO_DEMO_MODE !== "true") return { enabled: false, reason: "flag-off" };
  const sessionSecret = env.BROKO_DEMO_SESSION_SECRET?.trim() || undefined;
  if (looksLikeProduction(env)) {
    if (env.BROKO_ALLOW_PRODUCTION_DEMO !== "true") return { enabled: false, reason: "production-not-allowed" };
    if (!strongEnoughSecret(sessionSecret)) return { enabled: false, reason: "production-needs-session-secret" };
  }
  return { enabled: true, sessionSecret };
}

export const supabaseConfigured = (): boolean => supabaseUsable(process.env);
export const demoConfig = (): DemoConfig => resolveDemoConfig(process.env);
export const demoMode = (): boolean => demoConfig().enabled;

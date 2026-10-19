type Env = Record<string, string | undefined>;

const SHARED_BUCKET = "untrusted";

/**
 * Key used to rate-limit failed sign-ins per client. Forwarded-IP headers are client-controlled
 * unless a trusted proxy sets them, so they are used ONLY when we know who sets them:
 *  - On Vercel (VERCEL is set): `x-vercel-forwarded-for` / `x-real-ip`, which the platform sets itself.
 *  - Behind your own proxy, only if BROKO_TRUST_PROXY=true: `x-real-ip`, else the RIGHTMOST
 *    x-forwarded-for entry (the one appended by the trusted proxy, not the client).
 * Otherwise every request shares ONE bucket, so spoofing headers gains an attacker nothing.
 */
export function clientKey(get: (name: string) => string | null, env: Env): string {
  const onVercel = Boolean(env.VERCEL);
  if (!onVercel && env.BROKO_TRUST_PROXY !== "true") return SHARED_BUCKET;

  const xff = get("x-forwarded-for");
  const raw = onVercel
    ? get("x-vercel-forwarded-for") || get("x-real-ip")
    : get("x-real-ip") || (xff ? xff.split(",").at(-1) : null);

  const ip = raw?.split(",")[0]?.trim().toLowerCase().slice(0, 64);
  return ip && /^[0-9a-f:.]{2,64}$/.test(ip) ? ip : SHARED_BUCKET;
}

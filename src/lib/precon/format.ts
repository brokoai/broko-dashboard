import type { InventoryUnit } from "./types";

/** An inventory record not updated for this long is called out as possibly outdated (never silently trusted). */
export const STALE_DAYS = 90;

export const isStale = (updatedAt: string, now: number = Date.now()) => now - new Date(updatedAt).getTime() > STALE_DAYS * 86_400_000;

export function money(price: number | null, currency: string): string {
  if (price === null) return "Price not set";
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: 0 }).format(price);
  } catch {
    return `${price.toLocaleString("en-CA")} ${currency}`;
  }
}

export function bedsLabel(u: Pick<InventoryUnit, "bedrooms" | "den">): string {
  if (u.bedrooms === null) return "—";
  const base = u.bedrooms === 0 ? "Studio" : `${u.bedrooms} bed`;
  return u.den ? `${base} + den` : base;
}

export const areaLabel = (a: number | null) => (a === null ? "—" : `${a.toLocaleString("en-CA")} sq ft`);
export const bathsLabel = (b: number | null) => (b === null ? "—" : `${b} bath`);

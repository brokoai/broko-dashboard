import { cellText } from "./extract";
import { DEFAULT_CURRENCY, IMPORT_FIELDS, type ImportField } from "./import-fields";
import { AVAILABILITIES, type Availability, type InventoryInput, type InventoryUnit } from "./types";

// Controlled inventory import. A spreadsheet is parsed into typed rows, validated, compared with what is already stored, and
// SHOWN as a preview. Nothing is written by this module. Rules that keep the data honest:
//   - a blank cell is "not provided", never a guess (availability stays "unknown", a blank price stays empty);
//   - a value that cannot be read is an error on that row, never silently coerced;
//   - existing records are never overwritten unless the caller explicitly asks to update conflicts.

export { IMPORT_FIELDS, FIELD_LABEL, DEFAULT_CURRENCY, type ImportField } from "./import-fields";
export type ColumnMapping = Partial<Record<ImportField, number>>;
export const MAX_IMPORT_ROWS = 2000;

const HEADER_SYNONYMS: Record<ImportField, RegExp> = {
  unit_number: /^(unit|suite|unit ?(no|number|#)|suite ?(no|number|#)|apt|apartment|lot)$/i,
  unit_type: /^(unit ?type|type|layout|plan|model|floor ?plan|suite ?type)$/i,
  bedrooms: /^(bed|beds|bedrooms?|br|bdrm|bedroom count)$/i,
  bathrooms: /^(bath|baths|bathrooms?|ba|washrooms?)$/i,
  area_sqft: /^(area|size|sq ?ft|sqft|square ?(feet|footage)|interior ?(area|size)|area \(?sq ?ft\)?)$/i,
  price: /^(price|asking( price)?|list ?price|cost|price \(?(cad|usd|\$)\)?)$/i,
  currency: /^(currency|ccy)$/i,
  availability: /^(availability|available|status|sale ?status|unit ?status)$/i,
  expected_occupancy: /^(occupancy|expected ?occupancy|occupancy ?date|closing|closing ?date|completion|move ?in)$/i,
};

/** Suggests a column for each field from the header names. Each column is used at most once. The user can change every choice. */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  for (const f of IMPORT_FIELDS) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && HEADER_SYNONYMS[f].test(h.trim()));
    if (i >= 0) { mapping[f] = i; used.add(i); }
  }
  return mapping;
}

// ---- cell parsers: each returns a value, null for "blank", or an error message ----------------------------------------

type Parsed<T> = { v: T | null } | { err: string };
const blank = (s: string) => s === "";

function num(raw: unknown, label: string, opts: { min: number; max: number; int?: boolean }): Parsed<number> {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < opts.min || raw > opts.max || (opts.int && !Number.isInteger(raw))) return { err: `${label} is out of range` };
    return { v: raw };
  }
  const s = cellText(raw);
  if (blank(s)) return { v: null };
  const cleaned = s.replace(/[$,\s]/g, "").replace(/(sq\.?\s?ft\.?|sqft|sf|ft2|bath(room)?s?|bed(room)?s?|br|ba|cad|usd)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { err: `${label} "${s.slice(0, 30)}" is not a number` };
  const n = Number(cleaned);
  if (n < opts.min || n > opts.max || (opts.int && !Number.isInteger(n))) return { err: `${label} is out of range` };
  return { v: n };
}

function bedrooms(raw: unknown): Parsed<{ bedrooms: number; den: boolean }> {
  const s = cellText(raw);
  if (blank(s)) return { v: null };
  const lower = s.toLowerCase();
  const den = /\bden\b/.test(lower);
  if (/^(studio|bachelor|bach)\b/.test(lower)) return { v: { bedrooms: 0, den } };
  const m = /^(\d{1,2})(?:\.0+)?\s*(?:\+|bed|br|bdrm|bedroom|-|$)/i.exec(lower.replace(/\s+/g, " ").trim());
  if (!m || Number(m[1]) > 10) return { err: `Bedrooms "${s.slice(0, 30)}" could not be read` };
  return { v: { bedrooms: Number(m[1]), den } };
}

const AVAIL: [RegExp, Availability][] = [
  [/^(available|avail|for sale|open|unsold|on the market)$/i, "available"],
  [/^(reserved|hold|on hold|pending|held|conditional)$/i, "reserved"],
  [/^(sold|sold out|closed|firm)$/i, "sold"],
  [/^(unknown|tbd|n\/a|na|-)$/i, "unknown"],
];
function availability(raw: unknown): Parsed<Availability> {
  const s = cellText(raw);
  if (blank(s)) return { v: null };
  const hit = AVAIL.find(([re]) => re.test(s));
  return hit ? { v: hit[1] } : { err: `Availability "${s.slice(0, 30)}" is not recognised (use Available, Reserved or Sold)` };
}

function isoDate(raw: unknown): Parsed<string> {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? { err: "Date could not be read" } : { v: raw.toISOString().slice(0, 10) };
  const s = cellText(raw);
  if (blank(s)) return { v: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 && +m[1] <= 2100) return { v: s };
  }
  return { err: `Date "${s.slice(0, 20)}" must be a full date like 2027-09-30` };
}

function currency(raw: unknown): Parsed<string> {
  const s = cellText(raw);
  if (blank(s)) return { v: null };
  return /^[A-Za-z]{3}$/.test(s) ? { v: s.toUpperCase() } : { err: `Currency "${s.slice(0, 10)}" must be a 3-letter code like CAD` };
}

// ---- preview ---------------------------------------------------------------------------------------------------------

export type RowStatus = "new" | "duplicate" | "conflict" | "error";
export interface FieldChange { field: string; from: string | number | boolean | null; to: string | number | boolean | null }

export interface ParsedRow {
  /** 1-based row number in the spreadsheet, as the user sees it. */
  line: number;
  status: RowStatus;
  errors: string[];
  data: InventoryInput | null;
  /** For conflicts: what would change. */
  changes: FieldChange[];
  existing_id: string | null;
}

export interface ImportPreview {
  headers: string[];
  mapping: ColumnMapping;
  rows: ParsedRow[];
  counts: Record<RowStatus, number>;
  total: number;
  /** Fields the user has not mapped that the file may have meant to supply. Informational. */
  unmapped: ImportField[];
  /** Set when no usable identity column is mapped: the import cannot run. */
  blocking: string | null;
  notes: string[];
}

const normUnit = (s: string | null) => (s ? s.trim().toLowerCase() : "");
const tupleKey = (d: InventoryInput) => [d.unit_type ?? "", d.bedrooms ?? "", d.den, d.bathrooms ?? "", d.area_sqft ?? "", d.price ?? "", d.availability].join("|");

const COMPARED: (keyof InventoryInput)[] = ["unit_type", "bedrooms", "den", "bathrooms", "area_sqft", "price", "currency", "availability", "expected_occupancy"];

function diff(existing: InventoryUnit, next: InventoryInput): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of COMPARED) {
    const to = next[f];
    // A blank cell means "not provided": it never erases a stored value. availability "unknown" is the same kind of blank.
    if (to === null || (f === "availability" && to === "unknown") || (f === "den" && to === false)) continue;
    const from = existing[f as keyof InventoryUnit] as string | number | boolean | null;
    if (from !== to) out.push({ field: f, from, to });
  }
  return out;
}

export function previewImport(input: { table: unknown[][]; mapping?: ColumnMapping; existing: InventoryUnit[] }): ImportPreview {
  const headerAt = input.table.findIndex((r) => r.some((c) => cellText(c) !== ""));
  const headers = headerAt < 0 ? [] : input.table[headerAt].map((h, i) => cellText(h) || `Column ${i + 1}`);
  const mapping = input.mapping ?? autoMapColumns(headers);
  const counts: Record<RowStatus, number> = { new: 0, duplicate: 0, conflict: 0, error: 0 };
  const empty = (blocking: string | null): ImportPreview => ({ headers, mapping, rows: [], counts, total: 0, unmapped: IMPORT_FIELDS.filter((f) => mapping[f] === undefined), blocking, notes: [] });
  if (headerAt < 0) return empty("The file has no rows.");
  if (mapping.unit_number === undefined && mapping.unit_type === undefined) return empty("Map at least a unit number or a unit type column so each row can be identified.");

  const byUnit = new Map(input.existing.filter((u) => u.unit_number).map((u) => [normUnit(u.unit_number), u]));
  const noUnitKeys = new Set(input.existing.filter((u) => !u.unit_number).map((u) => tupleKey(u as unknown as InventoryInput)));
  const seenUnits = new Map<string, number>();
  const seenTuples = new Set<string>();
  const rows: ParsedRow[] = [];
  const dataRows = input.table.slice(headerAt + 1);

  const cell = (r: unknown[], f: ImportField) => (mapping[f] === undefined ? null : r[mapping[f]!] ?? null);

  dataRows.slice(0, MAX_IMPORT_ROWS).forEach((r, k) => {
    const line = headerAt + 2 + k;
    const errors: string[] = [];
    const take = <T,>(p: Parsed<T>): T | null => { if ("err" in p) { errors.push(p.err); return null; } return p.v; };

    const unitRaw = cellText(cell(r, "unit_number"));
    const typeRaw = cellText(cell(r, "unit_type"));
    const bed = take(bedrooms(cell(r, "bedrooms")));
    const typeBed = !bed && typeRaw ? bedrooms(typeRaw) : null;
    const data: InventoryInput = {
      unit_number: unitRaw ? unitRaw.slice(0, 40) : null,
      unit_type: typeRaw ? typeRaw.slice(0, 80) : null,
      bedrooms: bed ? bed.bedrooms : typeBed && "v" in typeBed && typeBed.v ? typeBed.v.bedrooms : null,
      den: !!(bed?.den || /\bden\b/i.test(typeRaw)),
      bathrooms: take(num(cell(r, "bathrooms"), "Bathrooms", { min: 0, max: 10 })),
      area_sqft: take(num(cell(r, "area_sqft"), "Area", { min: 1, max: 100000 })),
      price: take(num(cell(r, "price"), "Price", { min: 0, max: 1e9 })),
      currency: take(currency(cell(r, "currency"))) ?? DEFAULT_CURRENCY,
      availability: take(availability(cell(r, "availability"))) ?? "unknown",
      expected_occupancy: take(isoDate(cell(r, "expected_occupancy"))),
    };
    if (data.bathrooms !== null && Math.round(data.bathrooms * 2) !== data.bathrooms * 2) errors.push("Bathrooms must be in half steps (1, 1.5, 2)");
    if (!data.unit_number && !data.unit_type) errors.push("Row has neither a unit number nor a unit type");

    let status: RowStatus = "new";
    let changes: FieldChange[] = [];
    let existingId: string | null = null;
    if (errors.length === 0) {
      const un = normUnit(data.unit_number);
      if (un) {
        const first = seenUnits.get(un);
        if (first !== undefined) errors.push(`Unit number appears more than once in this file (first on row ${first})`);
        else seenUnits.set(un, line);
        const ex = byUnit.get(un);
        if (!errors.length && ex) {
          existingId = ex.id;
          changes = diff(ex, data);
          status = changes.length ? "conflict" : "duplicate";
        }
      } else {
        const key = tupleKey(data);
        if (noUnitKeys.has(key) || seenTuples.has(key)) status = "duplicate";
        seenTuples.add(key);
      }
    }
    if (errors.length) status = "error";
    counts[status]++;
    rows.push({ line, status, errors, data: errors.length ? null : data, changes, existing_id: existingId });
  });

  const notes: string[] = [];
  if (mapping.currency === undefined) notes.push(`No currency column is mapped, so every row is recorded as ${DEFAULT_CURRENCY}.`);
  if (mapping.availability === undefined) notes.push('No availability column is mapped, so every row is recorded as "Unknown", not "Available".');
  if (dataRows.length > MAX_IMPORT_ROWS) notes.push(`Only the first ${MAX_IMPORT_ROWS} rows are read; split the file to import the rest.`);
  return { headers, mapping, rows, counts, total: rows.length, unmapped: IMPORT_FIELDS.filter((f) => mapping[f] === undefined), blocking: null, notes };
}

export const isAvailability = (s: string): s is Availability => (AVAILABILITIES as string[]).includes(s);

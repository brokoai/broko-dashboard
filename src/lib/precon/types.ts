// Pre-Construction Advisor: domain types shared by the repositories, the ingestion pipeline, the pages and the AI Brain.
// Nothing here knows about Supabase, Next.js or the demo; those are adapters behind `PreconRepo`.

export type ProjectStatus = "pre_construction" | "selling" | "under_construction" | "completed" | "on_hold";
export type DocKind = "brochure" | "floor_plan" | "rendering" | "pricing_sheet" | "inventory_sheet" | "document" | "other";
export type DocStatus = "pending" | "processing" | "processed" | "failed" | "needs_reprocessing";
export type Availability = "available" | "reserved" | "sold" | "unknown";

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  pre_construction: "Pre-construction", selling: "Selling", under_construction: "Under construction", completed: "Completed", on_hold: "On hold",
};
export const PROJECT_STATUSES = Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[];
/** "Active development" is a defined term on the overview: not archived, and not completed or on hold. */
export const ACTIVE_STATUSES: ProjectStatus[] = ["pre_construction", "selling", "under_construction"];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  brochure: "Brochure", floor_plan: "Floor plan", rendering: "Rendering", pricing_sheet: "Pricing sheet",
  inventory_sheet: "Inventory sheet", document: "Document", other: "Other",
};
export const DOC_KINDS = Object.keys(DOC_KIND_LABEL) as DocKind[];
export const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  pending: "Pending", processing: "Processing", processed: "Processed", failed: "Failed", needs_reprocessing: "Needs reprocessing",
};
export const AVAILABILITY_LABEL: Record<Availability, string> = { available: "Available", reserved: "Reserved", sold: "Sold", unknown: "Unknown" };
export const AVAILABILITIES = Object.keys(AVAILABILITY_LABEL) as Availability[];

export interface PreconProject {
  id: string;
  name: string;
  developer: string | null;
  city: string | null;
  address: string | null;
  status: ProjectStatus;
  description: string | null;
  /** YYYY-MM-DD */
  expected_completion: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  name: string;
  developer: string | null;
  city: string | null;
  address: string | null;
  status: ProjectStatus;
  description: string | null;
  expected_completion: string | null;
}

export interface PreconDocument {
  id: string;
  project_id: string;
  title: string;
  filename: string;
  kind: DocKind;
  mime_type: string;
  size_bytes: number;
  status: DocStatus;
  /** Fixed vocabulary (see DETAIL_TEXT), never raw error text. */
  status_detail: string | null;
  page_count: number | null;
  chunk_count: number;
  extractor_version: number | null;
  attempts: number;
  uploaded_by: string | null;
  uploader_name: string | null;
  created_at: string;
  processed_at: string | null;
  /** False in the demo and for sample records: there is no stored file to open. */
  has_file: boolean;
}

/** Bump when extraction or chunking improves: processed documents with an older version are shown as "needs reprocessing". */
export const EXTRACTOR_VERSION = 1;

/** The status to show: a processed document indexed by an older extractor is stale, whatever the stored status says. */
export function deriveStatus(d: { status: DocStatus; extractor_version: number | null }): DocStatus {
  return d.status === "processed" && (d.extractor_version ?? 0) < EXTRACTOR_VERSION ? "needs_reprocessing" : d.status;
}

export interface NewDocument {
  id: string;
  project_id: string;
  title: string;
  filename: string;
  kind: DocKind;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
}

export interface TextChunk { page: number | null; text: string }

export interface DocumentPage { page: number | null; text: string }

export interface SearchHit {
  chunk_id: string;
  document_id: string;
  project_id: string;
  page: number | null;
  content: string;
  rank: number;
}

export interface InventoryUnit {
  id: string;
  project_id: string;
  /** Administrators only. null for everyone else (the database refuses members this column). */
  unit_number: string | null;
  unit_type: string | null;
  bedrooms: number | null;
  den: boolean;
  bathrooms: number | null;
  area_sqft: number | null;
  price: number | null;
  currency: string;
  availability: Availability;
  /** YYYY-MM-DD */
  expected_occupancy: string | null;
  source: string;
  source_document_id: string | null;
  verified_at: string | null;
  updated_at: string;
}

export interface InventoryInput {
  unit_number: string | null;
  unit_type: string | null;
  bedrooms: number | null;
  den: boolean;
  bathrooms: number | null;
  area_sqft: number | null;
  price: number | null;
  currency: string;
  availability: Availability;
  expected_occupancy: string | null;
}

/** An inventory record with the project fields every list needs, so a list never needs a second query per row. */
export interface InventoryListItem extends InventoryUnit {
  project_name: string;
  project_city: string | null;
  project_developer: string | null;
}

export type InventorySort = "price_asc" | "price_desc" | "updated_desc" | "area_desc";

export interface InventoryFilter {
  project_id?: string;
  city?: string;
  unit_type?: string;
  bedrooms?: number;
  min_price?: number;
  max_price?: number;
  availability?: Availability;
  sort?: InventorySort;
  limit?: number;
}

export interface PreconOverview {
  projects: number;
  active_developments: number;
  inventory_records: number;
  available_units: number;
  documents: number;
  renderings: number;
  recent: PreconProject[];
}

export interface AuditEntry {
  project_id: string | null;
  action: string;
  entity: "project" | "document" | "inventory";
  entity_id: string | null;
  /** Content-free: counts, filenames, ids. Never prices or document text. */
  detail: Record<string, string | number | boolean | null>;
}

export const DETAIL_TEXT: Record<string, string> = {
  unsupported_type: "This file type is not supported.",
  too_large: "The file is larger than the 25 MB limit.",
  empty: "The file is empty.",
  content_mismatch: "The file's content does not match its type.",
  duplicate_content: "An identical file is already uploaded to this project.",
  extract_failed: "The text could not be extracted from this file.",
  no_text: "No readable text was found (for example a scanned PDF).",
  too_complex: "The file is too large or complex to process safely.",
  storage_missing: "The uploaded file could not be found in storage.",
  storage_error: "The file could not be read from storage.",
  not_indexable: "Images are stored and shown, but their content is not text-searchable.",
  truncated: "Only the first part of this very long file was indexed.",
};

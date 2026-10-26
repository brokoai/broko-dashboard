import type {
  AuditEntry, DocKind, DocStatus, DocumentPage, InventoryFilter, InventoryInput, InventoryListItem, InventoryUnit, NewDocument,
  PreconDocument, PreconOverview, PreconProject, ProjectInput, SearchHit, TextChunk,
} from "./types";

/** What the service needs to know about a stored file. Never sent to the browser. */
export interface DocumentStorageInfo {
  storage_path: string;
  project_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface DocumentPatch {
  title?: string;
  kind?: DocKind;
  sha256?: string | null;
  status?: DocStatus;
  status_detail?: string | null;
  page_count?: number | null;
  chunk_count?: number;
  extractor_version?: number | null;
  attempts?: number;
  processed_at?: string | null;
}

/**
 * Data access for the Pre-Construction Advisor, scoped to the signed-in user. Mirrors the shape of `Repo`: the Supabase
 * implementation relies on row level security (supabase/proposed/0007), and every implementation must independently refuse
 * what the user may not do (members never write; archived projects and unit numbers are not visible to members).
 * Absent on `Repo` = not connected.
 */
export interface PreconRepo {
  /** False for the demo: it shows synthetic records and refuses every write with a clear message. */
  readonly writable: boolean;

  overview(): Promise<PreconOverview>;
  listProjects(opts?: { includeArchived?: boolean }): Promise<PreconProject[]>;
  getProject(id: string): Promise<PreconProject | null>;
  createProject(input: ProjectInput): Promise<PreconProject>;
  updateProject(id: string, patch: Partial<ProjectInput>): Promise<PreconProject>;
  setProjectArchived(id: string, archived: boolean): Promise<PreconProject>;

  listDocuments(projectId?: string): Promise<PreconDocument[]>;
  getDocument(id: string): Promise<PreconDocument | null>;
  getDocumentStorage(id: string): Promise<DocumentStorageInfo | null>;
  /** Extracted text grouped by page, for the in-app viewer. */
  documentPages(id: string): Promise<DocumentPage[]>;
  /** Creates the row in status "pending" BEFORE any file exists in storage. */
  createDocument(doc: NewDocument): Promise<PreconDocument>;
  findDocumentByHash(projectId: string, sha256: string): Promise<{ id: string } | null>;
  updateDocument(id: string, patch: DocumentPatch): Promise<void>;
  /** Replaces all chunks of a document (reprocessing is idempotent). */
  replaceChunks(documentId: string, projectId: string, chunks: TextChunk[]): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  /** Full-text search over the chunks this user may see. `query` uses websearch syntax: words are AND-ed, `or` separates alternatives. */
  searchChunks(query: string, opts?: { projectId?: string; limit?: number }): Promise<SearchHit[]>;

  listInventory(filter?: InventoryFilter): Promise<InventoryListItem[]>;
  /** Every record of one project, unit numbers included (administrators): used to detect duplicates before an import. */
  inventoryForImport(projectId: string): Promise<InventoryUnit[]>;
  insertInventory(projectId: string, rows: InventoryInput[], meta: { source: string; source_document_id: string | null }): Promise<number>;
  updateInventory(id: string, patch: Partial<InventoryInput>, meta: { source: string; source_document_id: string | null }): Promise<void>;
  /** A person confirms (or withdraws confirmation of) a record. Only this sets `verified_at`. */
  verifyInventory(id: string, verified: boolean): Promise<void>;

  recordAudit(entry: AuditEntry): Promise<void>;
}

/** Private file storage. The browser never receives a storage path or a service credential, only a short-lived URL. */
export interface FileStore {
  /** Signed upload target for a path whose pending document row already exists. */
  createUpload(path: string): Promise<{ url: string; token: string }>;
  /** null when the object does not exist. */
  download(path: string): Promise<Uint8Array | null>;
  remove(path: string): Promise<void>;
  signedUrl(path: string, expiresInSeconds: number, opts?: { downloadAs?: string }): Promise<string>;
}

import { z } from "zod";
import type { Coverage, SourceSegment } from "../assistant/meetings/types";

/**
 * Persistent organizational memory (Phase 2A).
 *
 *   L0  source documents, kept exactly as read from an authorized source, with numbered evidence segments and a content hash
 *   L1  extracted organizational entities (people, decisions, tasks ...), each pointing at the segments that support it; PROPOSED intelligence
 *   L2  approved knowledge: the EXISTING Knowledge Base and its approval workflow (src/lib/knowledge). Nothing here approves anything.
 *
 * Access: the Notion integration sees whatever was shared with Broko as a whole, not what each employee could open, so employee-level
 * authorization cannot be established. Memory derived from it is therefore ADMINISTRATOR-only (`access_scope: "admin"`), exactly like the
 * meeting tools. Everything fails closed for anyone else.
 */

export const ENTITY_TYPES = ["person", "team", "project", "meeting", "decision", "task", "action_item", "commitment", "deadline", "risk", "blocker", "client_requirement"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** How the source supports a record: stated outright, pulled out of the text, inferred from it, or the source does not say. */
export const BASES = ["explicit", "extracted", "inferred", "unknown"] as const;
export type Basis = (typeof BASES)[number];
export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];
/** Fields a record may declare the source does NOT state. They stay empty: nothing is guessed. */
export const UNKNOWN_FIELDS = ["owner", "team", "due", "decision_maker"] as const;
export type UnknownField = (typeof UNKNOWN_FIELDS)[number];

export type SyncStatus = "synced" | "failed" | "archived";
/** L1 review: proposed -> reviewed | rejected; reviewed -> promotion_proposed (a Knowledge Base proposal exists; approval stays with the Knowledge workflow). */
export type ReviewStatus = "proposed" | "reviewed" | "rejected" | "promotion_proposed";
export type ReviewAction = "approve" | "reject" | "accept_revision" | "dismiss_revision";

/**
 * Phase 2B: relationships between L1 entities. A relationship is a typed, directed, evidence-backed link between two EXISTING entities of the SAME stored
 * document ("<task> ASSIGNED_TO <person>"). It is PROPOSED intelligence exactly like an entity: it cites the segments that support it, carries basis and
 * confidence, waits for a human, is never overwritten once reviewed, and is never silently treated as verified when it is only an inference.
 */
export const RELATION_TYPES = ["OWNS", "BELONGS_TO", "PART_OF", "RESULTED_IN", "DISCUSSED_IN", "BLOCKS", "DEPENDS_ON", "COMMITTED_TO", "HAS_DEADLINE", "ASSIGNED_TO", "RELATES_TO", "RAISED_IN"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
/** A relationship is never "unknown": the source either supports it (explicit / extracted) or the reading is an inference. */
export const REL_BASES = ["explicit", "extracted", "inferred"] as const;
export type RelBasis = (typeof REL_BASES)[number];
/** proposed -> reviewed | rejected. (No Knowledge promotion for relationships: they inform retrieval, they are not approved knowledge.) */
export type RelReviewStatus = "proposed" | "reviewed" | "rejected";

/** What went wrong with a source, in a fixed vocabulary. Raw errors, tokens and source text never reach this field. */
export type FailureCode = "not_connected" | "permission_denied" | "rate_limited" | "timeout" | "error";

export interface SourceDoc {
  id: string;
  provider: "notion";
  workspace_id: string;
  source_id: string;
  url: string | null;
  title: string;
  doc_type: string;
  /** The segments' text, normalized and joined. */
  content: string;
  segments: SourceSegment[];
  coverage: Coverage;
  content_hash: string;
  last_edited: string | null;
  ingested_at: string;
  /** Only when the source says whose it is; never inferred. */
  owner: string | null;
  access_scope: "admin";
  sync_status: SyncStatus;
  attempts: number;
  last_error: FailureCode | null;
  /** The content hash the stored entities were extracted from. Differs from content_hash while extraction is pending or failed. */
  extracted_hash: string | null;
  extraction_error: string | null;
  archived: boolean;
}

export interface DocInput {
  provider: "notion";
  workspace_id: string;
  source_id: string;
  url: string | null;
  title: string;
  doc_type: string;
  segments: SourceSegment[];
  coverage: Coverage;
  last_edited: string | null;
  owner: string | null;
  ingested_at: string;
}
export type DocChange = "created" | "unchanged" | "changed";

export interface EntityFields {
  entity_type: EntityType;
  name: string;
  description: string;
  /** Segment ids of the SOURCE document ("S4"). At least one; each must exist in it. */
  evidence: string[];
  basis: Basis;
  confidence: Confidence;
  owner: string | null;
  team: string | null;
  due: string | null;
  unknowns: UnknownField[];
}

export interface ReviewEvent { at: string; by: string; action: ReviewAction; note: string | null }

export interface OrgEntity extends EntityFields {
  id: string;
  /** Same entity found again in a later extraction of the same document keeps this id. */
  stable_id: string;
  source_doc_id: string;
  extracted_at: string;
  review_status: ReviewStatus;
  /** The source changed after this record was reviewed: the new extraction waits here and the reviewed record is NOT overwritten. */
  stale: boolean;
  pending_revision: (EntityFields & { extracted_at: string }) | null;
  knowledge_item_id: string | null;
  history: ReviewEvent[];
}

/** Filled in by a search that had to stop at its work limit: `budget_reached` means the result may be incomplete, which is NOT the same as 'nothing matched'. */
export interface SearchOutcome { budget_reached: boolean }

export interface EntityQuery { entity_type?: EntityType; query?: string; source_doc_id?: string; include_rejected?: boolean; limit: number; outcome?: SearchOutcome }

export interface UpsertEntitiesResult { created: number; updated: number; staled: number; unchanged: number }

/**
 * `reconcile: false` stores what was found but does NOT mark the document's other records stale. The ingestion passes it when the model saw only part of
 * the document (input truncated): an incomplete extraction proves nothing about what the document no longer states. Default true.
 */
export interface UpsertOptions { reconcile?: boolean }

export interface RelationshipFields {
  relation_type: RelationType;
  /** Stable ids of two existing entities (they keep their id across re-extractions of the same document). */
  from_entity_id: string;
  to_entity_id: string;
  /** Segment ids of the SOURCE document ("S4") that support the link. At least one; each must exist in it and not be flagged. */
  evidence: string[];
  basis: RelBasis;
  confidence: Confidence;
}
export interface OrgRelationship extends RelationshipFields {
  id: string;
  /** hash of (from, type, to): the same link found again in a later extraction keeps this id. */
  stable_id: string;
  source_doc_id: string;
  extracted_at: string;
  review_status: RelReviewStatus;
  stale: boolean;
  /** The source changed after this link was reviewed: the new extraction waits here and the reviewed link is NOT overwritten. */
  pending_revision: (Pick<RelationshipFields, "evidence" | "basis" | "confidence"> & { extracted_at: string }) | null;
  history: ReviewEvent[];
}
export interface EntityRef { id: string; entity_type: EntityType; name: string }
/** A relationship with both of its endpoints spelled out, as retrieval returns it. */
export interface OrgRelationshipView extends OrgRelationship { from: EntityRef; to: EntityRef }
export interface RelationshipQuery {
  /** See SearchOutcome. */
  outcome?: SearchOutcome;
  /** Relationships where this entity is either endpoint. */
  entity_id?: string;
  /** Relationships where either endpoint's name contains this text. */
  query?: string;
  relation_type?: RelationType;
  source_doc_id?: string;
  include_rejected?: boolean;
  limit: number;
}
export interface UpsertRelationshipsResult { created: number; updated: number; staled: number; unchanged: number; skipped: number }

export interface IngestRunReport {
  discovered: number;
  created: number; changed: number; unchanged: number; skipped: number; failed: number; archived: number; retried: number;
  extracted_docs: number; extraction_failed: number;
  entities_created: number; entities_updated: number; entities_staled: number; entities_rejected: number; owners_dropped: number; dates_dropped: number;
  relationships_created: number; relationships_updated: number; relationships_staled: number; relationships_rejected: number; relationships_downgraded: number; relationship_extraction_failed: number;
  /** Documents whose extraction saw only part of the text: stored what was found, marked nothing stale. */
  reconcile_skipped_truncated: number;
  discovery_failure: FailureCode | null;
}

/** Server-side writes (ingestion). Never reachable from chat. */
export interface OrgMemoryWriter {
  getDoc(provider: "notion", workspaceId: string, sourceId: string): Promise<SourceDoc | null>;
  upsertDoc(input: DocInput): Promise<{ doc: SourceDoc; change: DocChange }>;
  recordFailure(provider: "notion", workspaceId: string, sourceId: string, meta: { title: string; url: string | null }, code: FailureCode, at: string): Promise<SourceDoc>;
  listActiveSourceIds(provider: "notion", workspaceId: string): Promise<string[]>;
  archiveDoc(provider: "notion", workspaceId: string, sourceId: string): Promise<void>;
  listRetryable(provider: "notion", workspaceId: string, maxAttempts: number): Promise<SourceDoc[]>;
  /** Documents whose entities are not extracted from their current content (new, changed, or a failed extraction). */
  listUnextracted(provider: "notion", workspaceId: string): Promise<SourceDoc[]>;
  upsertEntities(docId: string, entities: EntityFields[], at: string, opts?: UpsertOptions): Promise<UpsertEntitiesResult>;
  markExtracted(docId: string, hash: string, error: string | null): Promise<void>;
  /** The entities stored for one document (any review status), so relationships can point at their ids. */
  listDocEntities(docId: string): Promise<OrgEntity[]>;
  /**
   * Phase 2B. Stores the relationships extracted from one document. Reviewed links are never overwritten (a different extraction parks as a pending revision),
   * rejected links never come back, links whose endpoint is missing or ineligible are skipped, and links the document no longer states are marked stale.
   */
  upsertRelationships(docId: string, relationships: RelationshipFields[], at: string, opts?: UpsertOptions): Promise<UpsertRelationshipsResult>;
}

/** Reads and reviews, scoped to the signed-in user. Every method refuses a non-administrator (empty / null / error). */
export interface OrgMemoryReader {
  findEntities(q: EntityQuery): Promise<OrgEntity[]>;
  getEntity(id: string): Promise<OrgEntity | null>;
  getDocument(id: string): Promise<SourceDoc | null>;
  listReviewQueue(limit: number): Promise<OrgEntity[]>;
  review(id: string, action: ReviewAction, note: string | null): Promise<OrgEntity>;
  /** Records that a Knowledge Base proposal was made for this reviewed entity. */
  markPromotionProposed(id: string, knowledgeItemId: string): Promise<OrgEntity>;
  /** Phase 2B (administrators only, like everything here). Rejected links, links of an archived source and links with an ineligible endpoint are not returned unless asked for. */
  findRelationships(q: RelationshipQuery): Promise<OrgRelationshipView[]>;
  getRelationship(id: string): Promise<OrgRelationshipView | null>;
  listRelationshipQueue(limit: number): Promise<OrgRelationshipView[]>;
  /** Approving an INFERRED relationship needs a written reason. */
  reviewRelationship(id: string, action: ReviewAction, note: string | null): Promise<OrgRelationshipView>;
}

export type RunStatus = "ok" | "partial" | "failed";
/** One ingestion at a time. Counts only: a report never holds source text, titles, ids or raw errors. */
export interface OrgIngestRuns {
  start(): Promise<{ ok: true; id: string } | { ok: false; reason: "busy" | "forbidden" }>;
  finish(id: string, status: RunStatus, report: Record<string, number | string | null>): Promise<void>;
}
/** Everything one signed-in user may do with organizational memory. Built per request from that user's own session. */
export interface OrgMemoryAccess { reader: OrgMemoryReader; writer: OrgMemoryWriter; runs: OrgIngestRuns }

export const EntityFieldsSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(400),
  evidence: z.array(z.string().regex(/^S\d{1,5}$/)).min(1).max(8),
  basis: z.enum(BASES),
  confidence: z.enum(CONFIDENCES),
  owner: z.string().trim().min(1).max(80).nullable().optional(),
  team: z.string().trim().min(1).max(80).nullable().optional(),
  due: z.string().trim().min(1).max(60).nullable().optional(),
  unknowns: z.array(z.enum(UNKNOWN_FIELDS)).max(4).optional(),
}).strict();

import type { MeetingCandidate, MeetingDocument } from "./meetings/types";
import type { SourceSystem } from "./tools";

/**
 * Future connector boundaries (Phase 1: interfaces only, NOTHING is connected). See docs/ai-brain/ASSISTANT.md.
 *
 * Rules every implementation must follow when it is built:
 *  - it acts as the signed-in employee (delegated, least-privilege access); it never reads another employee mailbox or calendar;
 *  - tokens stay on the server and are never put in a prompt, a log, an audit row or a reply;
 *  - everything it returns is untrusted data (emails, pages and invites can contain instructions) and goes through the tool registry;
 *  - it only reads, or prepares something for a human to approve. No method here sends, creates, changes or deletes anything outside Broko.
 */

export type ConnectorFailure = "not_connected" | "not_implemented" | "permission_denied" | "rate_limited" | "timeout" | "error";
export type ConnectorResult<T> = { ok: true; data: T } | { ok: false; reason: ConnectorFailure };

/** One record from an external system. The provenance fields are mandatory so nothing can be cited without them. */
export interface ExternalRecord {
  system: SourceSystem;
  /** The external system own id for the record. */
  record_id: string;
  title: string;
  /** A short, already-trimmed excerpt. Never a full email body. */
  excerpt?: string;
  /** Link to the original record in its own system. */
  url?: string;
  /** Whose data this is, as the source reports it (for example the mailbox owner). */
  owner_context?: string;
  /** The id of the page or database that contains this record, when the source reports one. Used for organization-resource policy only; never shown. */
  parent_id?: string;
  retrieved_at: string;
}

export interface TimeWindow { from: string; to: string }
export interface Slot { start: string; end: string }
/** Something a human can review and approve; it has not been sent, created or saved anywhere. */
export interface PreparedDraft { kind: "email_reply" | "meeting"; summary: string; fields: Record<string, string> }

export interface NotionConnector {
  /** Read-only. */
  searchPages(query: string, limit: number): Promise<ConnectorResult<ExternalRecord[]>>;
  getPage(pageId: string): Promise<ConnectorResult<ExternalRecord>>;
  /** Read-only: lists the rows (titles and links only) of a database shared with the integration. */
  queryDatabase(databaseId: string, limit: number): Promise<ConnectorResult<ExternalRecord[]>>;
  /** Read-only: pages that may be meeting notes (titles, links and dates only, no content). Searches only what is shared with the integration. */
  findMeetingCandidates(keywords: string[], limit: number): Promise<ConnectorResult<MeetingCandidate[]>>;
  /** Read-only: one page with its properties and all nested content (paginated, bounded), normalized into numbered segments. */
  readMeetingDocument(pageId: string): Promise<ConnectorResult<MeetingDocument>>;
}

export interface OutlookMailConnector {
  /** Read and prepare. There is deliberately no send method. */
  searchMessages(query: string, limit: number): Promise<ConnectorResult<ExternalRecord[]>>;
  getThread(threadId: string): Promise<ConnectorResult<ExternalRecord[]>>;
  findUnanswered(window: TimeWindow, limit: number): Promise<ConnectorResult<ExternalRecord[]>>;
  prepareReplyDraft(threadId: string, instruction: string): Promise<ConnectorResult<PreparedDraft>>;
}

export interface OutlookCalendarConnector {
  /** Read and prepare. There is deliberately no create, update or delete method. */
  listEvents(window: TimeWindow, limit: number): Promise<ConnectorResult<ExternalRecord[]>>;
  checkAvailability(window: TimeWindow, durationMinutes: number): Promise<ConnectorResult<Slot[]>>;
  findConflicts(window: TimeWindow): Promise<ConnectorResult<ExternalRecord[]>>;
  prepareEventProposal(title: string, window: TimeWindow): Promise<ConnectorResult<PreparedDraft>>;
}

export interface Connectors { notion: NotionConnector; mail: OutlookMailConnector; calendar: OutlookCalendarConnector }

const off = async <T>(): Promise<ConnectorResult<T>> => ({ ok: false, reason: "not_connected" });

/** The only connectors that exist in Phase 1. Every call fails safely and touches nothing. */
export function unavailableConnectors(): Connectors {
  return {
    notion: { searchPages: off, getPage: off, queryDatabase: off, findMeetingCandidates: off, readMeetingDocument: off },
    mail: { searchMessages: off, getThread: off, findUnanswered: off, prepareReplyDraft: off },
    calendar: { listEvents: off, checkAvailability: off, findConflicts: off, prepareEventProposal: off },
  };
}

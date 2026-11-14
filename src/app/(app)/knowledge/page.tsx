import Link from "next/link";
import { BookOpen } from "lucide-react";
import { ItemCard } from "@/components/knowledge/item-card";
import { ReviewControls } from "@/components/knowledge/review-controls";
import { SubmissionForm } from "@/components/knowledge/submission-form";
import { Card, EmptyState, btn } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { canReview, describeReplacement } from "@/lib/knowledge/policy";
import type { KnowledgeItem } from "@/lib/knowledge/types";
import { knowledgeContext } from "./_lib";

type Search = Promise<{ [key: string]: string | string[] | undefined }>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Runs a read and degrades to an inline notice instead of failing the whole page. */
async function safely<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<{ data: T; failed: boolean }> {
  try { return { data: await fn(), failed: false }; } catch (e) { console.error(`[knowledge] ${label}`, e); return { data: fallback, failed: true }; }
}

const Unavailable = () => <p role="alert" className="text-sm text-red-700">This list could not be loaded right now. Please try again later.</p>;

export default async function KnowledgePage({ searchParams }: { searchParams: Search }) {
  const ctx = await knowledgeContext();
  const repo = ctx.repo;
  if (!repo) return null; // the layout already shows the "not connected" state
  const sp = await searchParams;
  const admin = canReview(ctx.user);
  const now = new Date();
  const writable = repo.writable;

  const [projectsRes, current, mine, queue, recent, summary] = await Promise.all([
    safely("projects", async () => (ctx.precon ? (await ctx.precon.listProjects()).map((p) => ({ id: p.id, name: p.name })) : []), [] as { id: string; name: string }[]),
    safely("current", () => repo.listCurrent(), [] as KnowledgeItem[]),
    safely("mine", () => repo.listMine(), [] as KnowledgeItem[]),
    admin ? safely("queue", () => repo.listQueue(), [] as KnowledgeItem[]) : Promise.resolve({ data: [] as KnowledgeItem[], failed: false }),
    admin ? safely("recent", async () => (await repo.listAll({ limit: 30 })).filter((i) => i.status !== "proposed"), [] as KnowledgeItem[]) : Promise.resolve({ data: [] as KnowledgeItem[], failed: false }),
    admin ? safely("feedback", () => repo.feedbackSummary(), { useful: 0, not_useful: 0 }) : Promise.resolve({ data: { useful: 0, not_useful: 0 }, failed: false }),
  ]);
  const projects = projectsRes.data;
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const replaceId = first(sp.replace);
  const replaces = replaceId ? current.data.find((i) => i.id === replaceId) : undefined;
  // Titles of the older items that proposals name as the one they replace, so a reviewer sees WHAT approving would retire.
  const known = new Map<string, KnowledgeItem>([...current.data, ...mine.data, ...queue.data, ...recent.data].map((i) => [i.id, i]));
  const missing = [...new Set([...known.values()].map((i) => i.supersedes_id).filter((id): id is string => !!id && !known.has(id)))].slice(0, 50);
  for (const [id, item] of await Promise.all(missing.map(async (id) => [id, (await safely("replaced item", () => repo.getItem(id), null)).data] as const))) if (item) known.set(id, item);
  const replacementOf = (i: KnowledgeItem) => describeReplacement(i, i.supersedes_id ? known.get(i.supersedes_id) : null);
  const history = admin ? await Promise.all(recent.data.slice(0, 8).map(async (i) => [i.id, (await safely("events", () => repo.events(i.id), [])).data] as const)) : [];
  const events = new Map(history);

  return (
    <div className="space-y-6">
      {writable && (
        <Card title={replaces ? "Suggest a replacement" : first(sp.correct) ? "Suggest a correction" : "Add knowledge"}>
          <p className="mb-4 max-w-2xl text-sm text-muted">
            Write down a decision, a correction, a procedure or a project note. It is sent for review as a proposal. Broko AI only uses knowledge after an administrator approves it, and it never learns from chat on its own.
          </p>
          <SubmissionForm projects={projects} startAsCorrection={!!first(sp.correct)} replaces={replaces ? { id: replaces.id, title: replaces.title } : undefined} />
        </Card>
      )}

      {admin && (
        <Card title={`Awaiting review (${queue.data.length})`}>
          {queue.failed ? <Unavailable /> : queue.data.length === 0 ? (
            <EmptyState icon={<BookOpen size={20} aria-hidden />} title="Nothing is waiting for review">New submissions from your team appear here.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {queue.data.map((i) => (
                <li key={i.id}><ItemCard item={i} projectName={i.project_id ? names.get(i.project_id) ?? null : null} now={now} replacement={replacementOf(i)}>{writable ? <ReviewControls id={i.id} status={i.status} /> : null}</ItemCard></li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title={`Approved knowledge (${current.data.length})`}>
        {current.failed ? <Unavailable /> : current.data.length === 0 ? (
          <EmptyState icon={<BookOpen size={20} aria-hidden />} title="No approved knowledge yet">Nothing has been approved, so Broko AI has nothing to use. Submitted items appear here after an administrator approves them.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {current.data.map((i) => (
              <li key={i.id}>
                <ItemCard item={i} projectName={i.project_id ? names.get(i.project_id) ?? null : null} now={now} replacement={replacementOf(i)}>
                  {writable && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <Link href={`/knowledge?replace=${i.id}`} className={`${btn.base} ${btn.secondary}`}>Suggest a correction</Link>
                  </div>}
                  {writable && admin && <ReviewControls id={i.id} status={i.status} />}
                </ItemCard>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Your submissions (${mine.data.length})`}>
        {mine.failed ? <Unavailable /> : mine.data.length === 0 ? (
          <EmptyState icon={<BookOpen size={20} aria-hidden />} title="You have not submitted anything">{writable ? "Use the form above to add knowledge." : "Submitting is turned off in the demo."}</EmptyState>
        ) : (
          <ul className="space-y-3">{mine.data.map((i) => <li key={i.id}><ItemCard item={i} projectName={i.project_id ? names.get(i.project_id) ?? null : null} now={now} replacement={replacementOf(i)} /></li>)}</ul>
        )}
      </Card>

      {admin && (
        <Card title="Review history and answer feedback">
          <p className="mb-3 text-sm text-muted" role="status">
            Answer feedback so far: {summary.data.useful} useful, {summary.data.not_useful} not useful. Feedback contains no questions or answers, only a rating, a reason and the kind of answer.
            {summary.failed ? " (The totals could not be loaded.)" : ""}
          </p>
          {recent.failed ? <Unavailable /> : recent.data.length === 0 ? (
            <p className="text-sm text-muted">No items have been reviewed yet.</p>
          ) : (
            <ul className="space-y-3">
              {recent.data.map((i) => (
                <li key={i.id}>
                  <ItemCard item={i} projectName={i.project_id ? names.get(i.project_id) ?? null : null} now={now} replacement={replacementOf(i)}>
                    {(events.get(i.id) ?? []).length > 0 && (
                      <ol className="mt-2 space-y-0.5 border-t border-line pt-2 text-xs text-muted" aria-label="Status history">
                        {(events.get(i.id) ?? []).map((e) => (
                          <li key={e.id} className="break-words">{formatDate(e.created_at)} · {e.action}{e.actor_name ? ` by ${e.actor_name}` : ""}{e.note ? ` — ${e.note}` : ""}</li>
                        ))}
                      </ol>
                    )}
                  </ItemCard>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

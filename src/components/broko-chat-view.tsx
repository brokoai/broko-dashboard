import Link from "next/link";
import type { Ref } from "react";
import { AlertTriangle, MessageCircle } from "lucide-react";
import type { ChatReply, ChatTurn, SourceReport } from "@/lib/ai-brain/chat/types";
import { safeHref } from "@/lib/chat-state";
import { cx } from "@/components/ui";

/** Presentational pieces of the floating chat. No server imports, so they can be rendered in tests. */
const STATE_LABEL: Record<SourceReport["state"], string> = { live: "Live", demo: "Demo data", stale: "Possibly out of date", unavailable: "Unavailable" };
const STATE_STYLE: Record<SourceReport["state"], string> = {
  live: "bg-green-50 text-green-800 border-green-200",
  demo: "bg-amber-50 text-amber-900 border-amber-200",
  stale: "bg-orange-50 text-orange-900 border-orange-200",
  unavailable: "bg-gray-100 text-gray-700 border-gray-200",
};

export function SourceChips({ sources }: { sources: SourceReport[] }) {
  if (sources.length === 0) return null;
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="min-h-6 cursor-pointer select-none">Sources ({sources.length})</summary>
      <ul className="mt-1 space-y-1">
        {sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
            <span className={cx("shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium", STATE_STYLE[s.state])}>{STATE_LABEL[s.state]}</span>
            <span className="min-w-0 flex-1 break-words"><strong className="font-medium text-ink">{s.label}</strong>{s.count !== undefined ? ` · ${s.count}` : ""}. {s.detail}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Replies are rendered as plain text only. Record text is never interpreted as HTML or markdown. */
export function ReplyView({ reply, onAsk }: { reply: ChatReply; onAsk?: (question: string) => void }) {
  return (
    <div>
      <p className="whitespace-pre-wrap break-words">{reply.text}</p>
      {reply.sections.map((sec, i) => (
        <div key={i} className="mt-2">
          {sec.heading && <p className={cx("text-xs font-semibold uppercase tracking-wider", sec.kind === "missing" ? "text-orange-800" : "text-muted")}>{sec.heading}</p>}
          {sec.text && <p className="text-xs text-muted">{sec.text}</p>}
          {sec.items && (
            <ul className="mt-1 space-y-1">
              {sec.items.map((it, j) => {
                const href = safeHref(it.href);
                return (
                  <li key={j} className="break-words text-sm">
                    {href ? <Link href={href} className="text-brand underline-offset-2 hover:underline">{it.text}</Link> : it.text}
                    {it.as_of && <span className="ml-1 text-[10px] text-muted">{it.as_of.slice(0, 10)}</span>}
                    {it.flagged && <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] text-orange-900">Contains instruction-like text; treated as data</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      {reply.clarification && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Did you mean">
          {reply.clarification.options.map((o) => (
            <li key={o}>{onAsk
              ? <button type="button" onClick={() => onAsk(o)} className="min-h-11 rounded-full border border-line bg-surface px-3 py-1.5 text-left text-sm hover:bg-brand-soft sm:min-h-0">{o}</button>
              : <span className="rounded-full border border-line px-3 py-1.5 text-sm">{o}</span>}</li>
          ))}
        </ul>
      )}
      {reply.approval && (
        <div className="mt-2 rounded-md border border-line bg-page p-2 text-xs">
          <p className="font-medium text-ink">Approval required. Not executed.</p>
          <p className="mt-0.5">{reply.approval.label}: {reply.approval.permitted === true ? "you are permitted to do this yourself." : reply.approval.permitted === false ? "you are not permitted." : "permission depends on the record."}</p>
          <p className="mt-0.5 text-muted">{reply.approval.reason}</p>
          {safeHref(reply.approval.where.href) && <Link href={safeHref(reply.approval.where.href)!} className="mt-1 inline-block font-medium text-brand underline-offset-2 hover:underline">{reply.approval.where.label}</Link>}
        </div>
      )}
      {reply.notice && <p className="mt-2 text-xs text-amber-900">{reply.notice}</p>}
      {reply.grounding && (reply.grounding.sources_used.length > 0 || reply.grounding.facts > 0) && (
        <p className="mt-2 text-[11px] text-muted">
          {reply.mode === "demo" ? "Demo data. " : ""}Based on {reply.grounding.facts} record{reply.grounding.facts === 1 ? "" : "s"}
          {reply.grounding.sources_used.length ? ` from ${reply.grounding.sources_used.join(", ").replace(/_/g, " ")}` : ""}.
        </p>
      )}
      <SourceChips sources={reply.sources} />
    </div>
  );
}

export function TurnView({ turn, onAsk, onRetry }: { turn: ChatTurn; onAsk?: (question: string) => void; onRetry?: () => void }) {
  if (turn.role === "user") {
    return <div className="ml-8 min-w-0 max-w-full self-end rounded-2xl rounded-br-sm bg-brand px-3 py-2 text-sm text-white"><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.content}</p></div>;
  }
  if (turn.role === "error") {
    return <div role="alert" className="mr-8 flex items-start gap-2 rounded-2xl rounded-bl-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"><AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" /><div className="min-w-0"><p className="break-words">{turn.content}</p>{onRetry && <button type="button" onClick={onRetry} className="mt-1 min-h-11 rounded border border-red-300 px-2 text-xs font-medium hover:bg-red-100 sm:min-h-0">Try again</button>}</div></div>;
  }
  return (
    <div className="mr-4 rounded-2xl rounded-bl-sm border border-line bg-surface px-3 py-2 text-sm text-ink">
      <ReplyView reply={turn.reply} onAsk={onAsk} />
    </div>
  );
}

export function ChatLauncher({ onOpen, buttonRef }: { onOpen: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef} type="button" onClick={onOpen} aria-label="Open Broko AI assistant" aria-haspopup="dialog" aria-expanded={false}
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    ><MessageCircle size={26} aria-hidden /></button>
  );
}

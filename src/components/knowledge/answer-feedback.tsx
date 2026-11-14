"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { sendFeedbackAction } from "@/app/(app)/knowledge/actions";
import type { ChatReply } from "@/lib/ai-brain/chat/types";
import { FEEDBACK_REASONS, REASON_LABEL, type FeedbackReason } from "@/lib/knowledge/types";

const small = "min-h-11 rounded border border-line px-2 text-xs font-medium text-fg hover:bg-page disabled:opacity-50 sm:min-h-0 sm:py-0.5";

/**
 * Small "useful / not useful" control under an answer. It sends a rating, a fixed reason, the kind of answer and the source ids, and
 * NOTHING else: no question, no answer text. It never changes knowledge by itself; a correction is a separate, reviewed submission.
 * In the demo nothing is saved, and it says so.
 */
export function AnswerFeedback({ reply }: { reply: ChatReply }) {
  const [pending, start] = useTransition();
  const [phase, setPhase] = useState<"idle" | "reason" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  if (reply.mode === "demo") return <p className="mt-2 text-[11px] text-muted">Feedback is not saved in the demo.</p>;

  const send = (rating: "useful" | "not_useful", reason: FeedbackReason | null) => {
    setError(null);
    start(async () => {
      const r = await sendFeedbackAction({ rating, reason, intent: reply.intent, source_ids: reply.grounding.sources_used });
      if (!r.ok) { setError(r.error); return; }
      setPhase("sent");
    });
  };

  if (phase === "sent") return <p role="status" className="mt-2 text-[11px] text-muted">Thanks. Only your rating was recorded, not the conversation.</p>;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted" role="group" aria-label="Was this answer useful?">
      <span>Was this useful?</span>
      <button type="button" disabled={pending} onClick={() => send("useful", null)} className={small} aria-label="This answer was useful">Useful</button>
      <button type="button" disabled={pending} onClick={() => setPhase("reason")} aria-expanded={phase === "reason"} className={small} aria-label="This answer was not useful">Not useful</button>
      <Link href="/knowledge?correct=1" className={`${small} inline-flex items-center`}>Suggest a correction</Link>
      {phase === "reason" && (
        <span className="flex w-full flex-wrap items-center gap-2">
          <span id="fb-reason-label">What was wrong?</span>
          {FEEDBACK_REASONS.map((r) => <button key={r} type="button" disabled={pending} onClick={() => send("not_useful", r)} className={small}>{REASON_LABEL[r]}</button>)}
        </span>
      )}
      {error && <span role="alert" className="w-full break-words text-red-700">{error}</span>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useReducer, useRef, useState, useTransition, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, MessageCircle, SendHorizontal, Trash2, X } from "lucide-react";
import { aiChatStatus, askBroko, unlockAiChat } from "@/app/(app)/chat/actions";
import { MAX_MESSAGE_CHARS, SUGGESTED_PROMPTS } from "@/lib/ai-brain/chat/prompts";
import { ChatLauncher, TurnView } from "@/components/broko-chat-view";
import { chatReducer, initialChatState, retryText } from "@/lib/chat-state";

/** Floating assistant. Mounted once in AppShell, so it survives navigation between dashboard pages. */
export function BrokoChat({ demo }: { demo: boolean }) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [, startTransition] = useTransition();
  const panel = useRef<HTMLDivElement>(null);
  const fab = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const close = useCallback(() => dispatch({ type: "close" }), []);

  // AI mode (paid model) is offered only when the server says it exists, and is switched on by a server-checked demo code.
  const [ai, setAi] = useState<{ available: boolean; unlocked: boolean }>({ available: false, unlocked: false });
  const [code, setCode] = useState("");
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  useEffect(() => {
    if (!state.open) return;
    let live = true;
    aiChatStatus().then((s) => { if (live) setAi(s); }).catch(() => { if (live) setAi({ available: false, unlocked: false }); });
    return () => { live = false; };
  }, [state.open]);
  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || unlocking) return;
    setUnlocking(true);
    try {
      const r = await unlockAiChat(code);
      if (r.ok) { setAi({ available: true, unlocked: true }); setUnlockMsg(null); } else setUnlockMsg(r.error);
    } catch {
      setUnlockMsg("Could not check the code. Please try again.");
    } finally {
      setCode("");
      setUnlocking(false);
    }
  };

  // The launcher is only mounted while the panel is closed, so focus goes back to it after the close has rendered.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !state.open) fab.current?.focus();
    wasOpen.current = state.open;
  }, [state.open]);

  // Only the single question is sent: no history, no user id, no role. The server derives all of that from the session.
  const call = useCallback((text: string, asked: number) => {
    startTransition(async () => {
      try {
        const r = await askBroko(text);
        if (r.ok) dispatch({ type: "reply", reply: r.reply, epoch: asked });
        else dispatch({ type: "error", message: r.error, epoch: asked });
      } catch {
        dispatch({ type: "error", message: "The assistant could not be reached. Check your connection and try again.", epoch: asked });
      }
    });
  }, []);

  const ask = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS || state.pending) return;
    dispatch({ type: "send", text });
    setDraft("");
    call(text, state.epoch);
  }, [state.pending, state.epoch, call]);

  const retryable = retryText(state);
  const retry = useCallback(() => {
    if (!retryable) return;
    dispatch({ type: "retry" });
    call(retryable, state.epoch);
  }, [retryable, state.epoch, call]);

  // Focus the input on open; trap Tab inside the panel; Escape closes; lock page scroll while the panel is a full-screen sheet.
  useEffect(() => {
    if (!state.open) return;
    input.current?.focus();
    const sheet = window.matchMedia("(max-width: 639px)");
    const prev = document.body.style.overflow;
    if (sheet.matches) document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),summary')].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [state.open, close]);

  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }); }, [state.turns.length, state.pending]);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); ask(draft); };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(draft); }
  };

  return (
    <>
      {!state.open && <ChatLauncher buttonRef={fab} onOpen={() => dispatch({ type: "open" })} />}
      {state.open && (
        <div
          ref={panel} role="dialog" aria-label="Broko AI assistant" aria-modal="false"
          className="fixed inset-0 z-50 flex flex-col bg-page pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[min(36rem,calc(100dvh-2rem))] sm:w-96 sm:rounded-xl sm:border sm:border-line sm:pb-0 sm:pt-0 sm:shadow-2xl"
        >
          <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 sm:rounded-t-xl">
            <MessageCircle size={18} aria-hidden className="shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-ink">Broko AI</h2>
              <p className="truncate text-[11px] text-muted">{demo ? "Demo: synthetic sample data" : "Reads your dashboard data. Never changes it."}</p>
            </div>
            <button type="button" onClick={() => dispatch({ type: "clear" })} disabled={state.turns.length === 0 && !state.pending} aria-label="Clear conversation" className="flex h-11 w-11 items-center justify-center rounded-md text-muted hover:bg-page disabled:opacity-40 sm:h-9 sm:w-9"><Trash2 size={16} aria-hidden /></button>
            <button type="button" onClick={close} aria-label="Close assistant" className="flex h-11 w-11 items-center justify-center rounded-md text-fg hover:bg-page sm:h-9 sm:w-9"><X size={18} aria-hidden /></button>
          </header>

          <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3">
            {state.turns.length === 0 && (
              <div className="text-sm text-muted">
                <p className="text-ink">Ask about your tasks, activity and follow-ups.</p>
                <p className="mt-1 text-xs">This conversation is not saved. It disappears when you close or reload the page.</p>
                <ul className="mt-3 flex flex-wrap gap-2" aria-label="Suggested questions">
                  {SUGGESTED_PROMPTS.map((p) => (
                    <li key={p}><button type="button" onClick={() => ask(p)} disabled={state.pending} className="min-h-11 rounded-full border border-line bg-surface px-3 py-1.5 text-left text-sm text-ink hover:bg-brand-soft disabled:opacity-50 sm:min-h-0">{p}</button></li>
                  ))}
                </ul>
              </div>
            )}
            {state.turns.map((t, i) => <TurnView key={t.id} turn={t} onAsk={ask} onRetry={retryable && i === state.turns.length - 1 ? retry : undefined} />)}
            {state.pending && (
              <div role="status" className="mr-8 flex items-center gap-2 text-sm text-muted"><Loader2 size={16} className="animate-spin" aria-hidden /> Looking through your data…</div>
            )}
          </div>

          {ai.available && (
            <div className="border-t border-line bg-surface px-3 py-2 text-xs text-muted" data-testid="ai-mode">
              {ai.unlocked ? (
                <p>AI mode on: a language model helps understand your question. It still only reads the data shown above.</p>
              ) : (
                <form onSubmit={unlock} className="flex flex-wrap items-center gap-2">
                  <label htmlFor="broko-ai-code" className="shrink-0">AI mode (demo code)</label>
                  <input id="broko-ai-code" type="password" autoComplete="off" value={code} maxLength={200} onChange={(e) => setCode(e.target.value)} className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-page px-2 text-base sm:text-sm" />
                  <button type="submit" disabled={unlocking || code.trim().length === 0} className="min-h-9 rounded-md border border-line px-3 text-ink hover:bg-brand-soft disabled:opacity-50">Unlock</button>
                  {unlockMsg && <p role="alert" className="w-full text-red-700">{unlockMsg}</p>}
                </form>
              )}
            </div>
          )}

          <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-line bg-surface p-2 sm:rounded-b-xl">
            <label htmlFor="broko-chat-input" className="sr-only">Ask Broko AI</label>
            <textarea
              id="broko-chat-input" ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
              rows={1} maxLength={MAX_MESSAGE_CHARS} enterKeyHint="send" placeholder="Ask a question…"
              className="max-h-28 min-h-11 min-w-0 flex-1 resize-none rounded-md border border-line bg-page px-3 py-2.5 text-base sm:text-sm"
            />
            <button type="submit" disabled={state.pending || draft.trim().length === 0} aria-label="Send" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-brand text-white disabled:opacity-40"><SendHorizontal size={18} aria-hidden /></button>
          </form>
        </div>
      )}
    </>
  );
}

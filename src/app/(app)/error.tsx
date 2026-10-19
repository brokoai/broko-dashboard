"use client";

import { btn, cx } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-card">
      <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">{error.message || "The page could not be loaded."}</p>
      <button type="button" onClick={reset} className={cx(btn.base, btn.primary, "mt-4")}>Try again</button>
    </div>
  );
}

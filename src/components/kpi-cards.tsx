import { AlertCircle, CalendarClock, CheckCircle2, ListTodo } from "lucide-react";
import type { TaskCounts } from "@/lib/types";

/**
 * Counts come from the backend, over the tasks the signed-in user may see.
 * Layout: one column below 360px, two columns on phones, four from `lg`.
 */
export function KpiCards({ counts }: { counts: TaskCounts }) {
  const cards = [
    { label: "Open Tasks", value: counts.open, icon: ListTodo, tint: "bg-brand-soft text-brand" },
    { label: "Due Today", value: counts.due_today, icon: CalendarClock, tint: "bg-brand-soft text-brand" },
    { label: "Overdue Tasks", value: counts.overdue, icon: AlertCircle, tint: "bg-brand-soft text-brand" },
    { label: "Completed Tasks", value: counts.completed, icon: CheckCircle2, tint: "bg-gray-100 text-gray-700" },
  ];
  return (
    <ul className="mb-4 grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:mb-5 lg:grid-cols-4" aria-label="Task summary">
      {cards.map(({ label, value, icon: Icon, tint }) => (
        <li key={label} className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface p-4 shadow-card sm:gap-4 sm:p-5">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg sm:h-11 sm:w-11 ${tint}`}><Icon size={22} aria-hidden /></span>
          <div className="min-w-0">
            <p className="text-2xl font-semibold leading-none text-ink sm:text-3xl">{value}</p>
            <p className="mt-1 break-words text-sm leading-tight text-muted">{label}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

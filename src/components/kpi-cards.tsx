import { AlertCircle, CalendarClock, CheckCircle2, ListTodo } from "lucide-react";
import type { TaskCounts } from "@/lib/types";

/** Counts come from the backend, over the tasks the signed-in user may see. */
export function KpiCards({ counts }: { counts: TaskCounts }) {
  const cards = [
    { label: "Open Tasks", value: counts.open, icon: ListTodo, tint: "bg-brand-soft text-brand" },
    { label: "Due Today", value: counts.due_today, icon: CalendarClock, tint: "bg-brand-soft text-brand" },
    { label: "Overdue Tasks", value: counts.overdue, icon: AlertCircle, tint: "bg-brand-soft text-brand" },
    { label: "Completed Tasks", value: counts.completed, icon: CheckCircle2, tint: "bg-gray-100 text-gray-700" },
  ];
  return (
    <ul className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Task summary">
      {cards.map(({ label, value, icon: Icon, tint }) => (
        <li key={label} className="flex items-center gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${tint}`}><Icon size={22} aria-hidden /></span>
          <div>
            <p className="text-3xl font-semibold leading-none text-ink">{value}</p>
            <p className="mt-1 text-sm text-muted">{label}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

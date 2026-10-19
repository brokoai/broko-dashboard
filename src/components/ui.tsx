import type { ReactNode } from "react";
import type { IntegrationStatus, TaskPriority, TaskStatus } from "@/lib/types";
import { PRIORITY_LABEL, STATUS_LABEL } from "@/lib/types";
import { initials } from "@/lib/dates";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const btn = {
  base: "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
  primary: "bg-brand text-white hover:bg-brand-dark px-3.5 py-2",
  secondary: "border border-line bg-surface text-fg hover:bg-page px-3.5 py-2",
  ghost: "text-muted hover:bg-page hover:text-fg p-2",
};

export function Card({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface shadow-card", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const tone = {
  neutral: "bg-gray-100 text-gray-700",
  red: "bg-brand-soft text-brand-dark",
  amber: "bg-amber-50 text-amber-800",
  blue: "bg-blue-50 text-blue-800",
  green: "bg-emerald-50 text-emerald-800",
  dark: "bg-ink text-white",
};
export function Badge({ tone: t = "neutral", children }: { tone?: keyof typeof tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap", tone[t])}>{children}</span>;
}

export const StatusBadge = ({ status }: { status: TaskStatus }) => (
  <Badge tone={{ open: "red", in_progress: "blue", completed: "green", cancelled: "neutral" }[status] as keyof typeof tone}>
    {STATUS_LABEL[status]}
  </Badge>
);
export const PriorityBadge = ({ priority }: { priority: TaskPriority }) => (
  <Badge tone={{ low: "green", medium: "amber", high: "red", urgent: "dark" }[priority] as keyof typeof tone}>
    {PRIORITY_LABEL[priority]}
  </Badge>
);

export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: "Connected", disconnected: "Disconnected", pending_setup: "Pending Setup", error: "Error",
};
export const IntegrationBadge = ({ status }: { status: IntegrationStatus }) => (
  <Badge tone={{ connected: "green", disconnected: "neutral", pending_setup: "amber", error: "red" }[status] as keyof typeof tone}>
    {INTEGRATION_STATUS_LABEL[status]}
  </Badge>
);

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-gray-100 font-semibold text-gray-700"
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-soft text-brand">{icon}</div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  );
}

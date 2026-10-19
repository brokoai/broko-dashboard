"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Bell, Building2, CheckSquare, ChevronDown, FileText, Home, Inbox, LayoutDashboard,
  LogOut, Megaphone, Menu, PieChart, Plug, Search, Settings, ShieldCheck, Users, Wallet, X,
  type LucideIcon,
} from "lucide-react";
import { resetDemo, signOut } from "@/app/login/actions";
import { Avatar, cx } from "@/components/ui";
import { ROLE_LABEL, type AppNotification, type Profile } from "@/lib/types";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/tasks", label: "My Tasks", icon: CheckSquare },
  { href: "/inbox", label: "AI Inbox", icon: Inbox },
  { href: "/team", label: "Team Activity", icon: Users },
  { href: "/integrations", label: "Integrations", icon: Plug },
];
const SOON: { label: string; icon: LucideIcon }[] = [
  { label: "CRM & Leads", icon: Users },
  { label: "Properties", icon: Home },
  { label: "Marketing", icon: Megaphone },
  { label: "Documents", icon: FileText },
  { label: "Compliance", icon: ShieldCheck },
  { label: "Finance", icon: Wallet },
  { label: "Reports", icon: PieChart },
];

function Sidebar({ user, onNavigate }: { user: Profile; onNavigate: () => void }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="px-5 py-5">
        <Image src="/brand/broko-wordmark.jpeg" alt="Broko Realty Ltd" width={1600} height={639} priority className="h-auto w-36 mix-blend-multiply" />
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3">
        <ul className="space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active(href) ? "page" : undefined}
                className={cx(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium",
                  active(href) ? "bg-brand-soft text-brand border-l-[3px] border-brand" : "text-fg hover:bg-page",
                )}
              >
                <Icon size={18} aria-hidden /> {label}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-6 mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted">Coming later</p>
        <ul className="space-y-1">
          {SOON.map(({ label, icon: Icon }) => (
            <li key={label} className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-400">
              <Icon size={18} aria-hidden /> <span className="flex-1">{label}</span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">Coming Soon</span>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-line p-3">
        <details className="group relative">
          <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md p-2 hover:bg-page">
            <Avatar name={user.full_name} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">{user.full_name}</span>
              <span className="block truncate text-xs text-muted">{user.title ?? ROLE_LABEL[user.role]}</span>
            </span>
            <ChevronDown size={16} className="text-muted" aria-hidden />
          </summary>
          <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border border-line bg-surface p-1 shadow-lg">
            <p className="px-3 py-2 text-xs text-muted">Role: {ROLE_LABEL[user.role]}</p>
            <Link href="/settings" onClick={onNavigate} className="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-page"><Settings size={16} aria-hidden /> Profile &amp; settings</Link>
            <form action={signOut}>
              <button type="submit" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-brand hover:bg-brand-soft"><LogOut size={16} aria-hidden /> Sign out</button>
            </form>
          </div>
        </details>
      </div>
    </div>
  );
}

function Header({ user, notifications, onMenu }: { user: Profile; notifications: AppNotification[]; onMenu: () => void }) {
  const unread = notifications.filter((n) => !n.read_at).length;
  return (
    <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 lg:px-6">
      <button type="button" onClick={onMenu} aria-label="Open navigation" className="rounded-md p-2 text-fg hover:bg-page lg:hidden"><Menu size={20} /></button>
      <form action="/tasks" role="search" className="relative max-w-xl flex-1">
        <label htmlFor="global-search" className="sr-only">Search tasks</label>
        <Search size={16} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input id="global-search" name="q" type="search" placeholder="Search tasks…" className="w-full rounded-md border border-line bg-page py-2 pl-9 pr-3 text-sm placeholder:text-muted" />
      </form>
      <div className="ml-auto flex items-center gap-1">
        <details className="relative">
          <summary aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="relative flex cursor-pointer list-none rounded-md p-2 text-fg hover:bg-page">
            <Bell size={20} aria-hidden />
            {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{unread}</span>}
          </summary>
          <div className="absolute right-0 mt-2 w-72 rounded-md border border-line bg-surface p-2 shadow-lg">
            <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted">Notifications</p>
            {notifications.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted">You&apos;re all caught up. Task assignments will appear here.</p>
            ) : (
              <ul>{notifications.slice(0, 8).map((n) => <li key={n.id} className="rounded px-2 py-2 text-sm hover:bg-page">{n.title}</li>)}</ul>
            )}
          </div>
        </details>
        <Link href="/settings" aria-label="Settings" className="rounded-md p-2 text-fg hover:bg-page"><Settings size={20} aria-hidden /></Link>
        <div className="ml-2 hidden items-center gap-2 sm:flex">
          <Avatar name={user.full_name} />
          <div className="leading-tight">
            <p className="text-sm font-semibold text-ink">{user.full_name}</p>
            <p className="text-xs text-muted">{user.title ?? ROLE_LABEL[user.role]}</p>
          </div>
        </div>
      </div>
    </header>
  );
}

export function AppShell({ user, notifications, demo, children }: { user: Profile; notifications: AppNotification[]; demo: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line lg:block"><Sidebar user={user} onNavigate={() => {}} /></aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">
            <button type="button" onClick={() => setOpen(false)} aria-label="Close navigation" className="absolute right-2 top-2 z-10 rounded-md p-2 hover:bg-page"><X size={18} /></button>
            <Sidebar user={user} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <Header user={user} notifications={notifications} onMenu={() => setOpen(true)} />
      {demo && (
        <div role="status" className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 lg:px-6">
          <Building2 size={14} aria-hidden /> <strong>Demo mode</strong> — synthetic sample data only; nothing here is real Broko data. Your changes are temporary: kept only in this browser for up to 24 hours, then discarded.
          <form action={resetDemo} className="ml-auto"><button type="submit" className="rounded border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100">Reset demo</button></form>
        </div>
      )}
      <main className="px-4 py-5 lg:px-6">{children}</main>
    </div>
  );
}

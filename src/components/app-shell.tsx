"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
      <nav aria-label="Primary" className="flex-1 overflow-y-auto overscroll-contain px-3">
        <ul className="space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active(href) ? "page" : undefined}
                className={cx(
                  "flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium lg:min-h-0",
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
              <Icon size={18} aria-hidden /> <span className="min-w-0 flex-1">{label}</span>
              <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">Coming Soon</span>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-line p-3">
        <details data-dismissable className="group relative">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-md p-2 hover:bg-page">
            <Avatar name={user.full_name} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-semibold text-ink lg:truncate">{user.full_name}</span>
              <span className="block break-words text-xs text-muted lg:truncate">{user.title ?? ROLE_LABEL[user.role]}</span>
            </span>
            <ChevronDown size={16} className="shrink-0 text-muted" aria-hidden />
          </summary>
          <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border border-line bg-surface p-1 shadow-lg">
            <p className="px-3 py-2 text-xs text-muted">Role: {ROLE_LABEL[user.role]}</p>
            <Link href="/settings" onClick={onNavigate} className="flex min-h-11 items-center gap-2 rounded px-3 py-2 text-sm hover:bg-page lg:min-h-0"><Settings size={16} aria-hidden /> Profile &amp; settings</Link>
            <form action={signOut}>
              <button type="submit" className="flex min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-sm text-brand hover:bg-brand-soft lg:min-h-0"><LogOut size={16} aria-hidden /> Sign out</button>
            </form>
          </div>
        </details>
      </div>
    </div>
  );
}

function Header({ user, notifications, menuOpen, onMenu }: { user: Profile; notifications: AppNotification[]; menuOpen: boolean; onMenu: () => void }) {
  const unread = notifications.filter((n) => !n.read_at).length;
  const icon = "flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg hover:bg-page";
  return (
    <header className="safe-px sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-surface pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] sm:gap-3">
      <button
        type="button" onClick={onMenu} aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="mobile-nav" aria-haspopup="dialog"
        className={cx(icon, "lg:hidden")}
      ><Menu size={22} aria-hidden /></button>
      <form action="/tasks" role="search" className="relative min-w-0 max-w-xl flex-1">
        <label htmlFor="global-search" className="sr-only">Search tasks</label>
        <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input id="global-search" name="q" type="search" enterKeyHint="search" placeholder="Search tasks…" className="min-h-11 w-full min-w-0 rounded-md border border-line bg-page py-2 pl-9 pr-3 text-base placeholder:text-muted sm:min-h-0 sm:text-sm" />
      </form>
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        <details data-dismissable className="relative">
          <summary aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className={cx(icon, "relative cursor-pointer list-none")}>
            <Bell size={20} aria-hidden />
            {unread > 0 && <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{unread}</span>}
          </summary>
          {/* Full-width under the header on phones (so it can never run off-screen); a 288px popover from sm up. */}
          <div className="fixed inset-x-3 top-[calc(3.75rem+env(safe-area-inset-top))] z-30 max-h-[70dvh] overflow-y-auto overscroll-contain rounded-md border border-line bg-surface p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-72">
            <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted">Notifications</p>
            {notifications.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted">You&apos;re all caught up. Task assignments will appear here.</p>
            ) : (
              <ul>{notifications.slice(0, 8).map((n) => <li key={n.id} className="break-words rounded px-2 py-3 text-sm hover:bg-page sm:py-2">{n.title}</li>)}</ul>
            )}
          </div>
        </details>
        <Link href="/settings" aria-label="Settings" className={icon}><Settings size={20} aria-hidden /></Link>
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

/** Slide-out navigation for screens below `lg`. Modal: traps focus, Escape / outside tap closes, locks page scroll. */
function MobileDrawer({ user, onClose }: { user: Profile; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Contents of a closed <details> are not focusable even though they still have a layout box.
    const inClosedDetails = (n: HTMLElement) => {
      const d = n.closest("details");
      return !!d && !d.open && !(n.tagName === "SUMMARY" && n.parentElement === d);
    };
    const focusable = () =>
      [...el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null && !inClosedDetails(n));
    focusable()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => { if (desktop.matches) onClose(); };
    document.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onResize);
      // Safari doesn't focus a button when it is clicked, so activeElement may have been <body>:
      // return focus to the hamburger explicitly (falling back to whatever had focus).
      (document.querySelector<HTMLElement>('button[aria-controls="mobile-nav"]') ?? previouslyFocused)?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="drawer-backdrop absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        id="mobile-nav" ref={panel} role="dialog" aria-modal="true" aria-label="Main navigation"
        className="drawer-panel absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-hidden bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] shadow-xl"
      >
        <button type="button" onClick={onClose} aria-label="Close navigation" className="absolute right-1 top-[calc(0.25rem+env(safe-area-inset-top))] z-10 flex h-11 w-11 items-center justify-center rounded-md hover:bg-page"><X size={20} aria-hidden /></button>
        <Sidebar user={user} onNavigate={onClose} />
      </aside>
    </div>
  );
}

export function AppShell({ user, notifications, demo, children }: { user: Profile; notifications: AppNotification[]; demo: boolean; children: ReactNode }) {
  // The drawer is "open for this path": navigating anywhere closes it with no effect needed.
  const path = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;
  const close = useCallback(() => setOpenAt(null), []);

  // Dropdown menus (<details data-dismissable>) close on outside tap/click and on Escape.
  useEffect(() => {
    const openMenus = () => [...document.querySelectorAll<HTMLDetailsElement>("details[data-dismissable][open]")];
    const onPointer = (e: PointerEvent) => {
      const inside = (e.target as Element | null)?.closest("details[data-dismissable]");
      openMenus().forEach((d) => { if (d !== inside) d.open = false; });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const menus = openMenus();
      if (!menus.length) return;
      menus.forEach((d) => { d.open = false; });
      menus[0].querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, []);

  return (
    <div className="min-h-dvh min-w-0 lg:pl-64">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line lg:block"><Sidebar user={user} onNavigate={() => {}} /></aside>
      {open && <MobileDrawer user={user} onClose={close} />}
      <Header user={user} notifications={notifications} menuOpen={open} onMenu={() => setOpenAt(path)} />
      {demo && (
        <div role="status" className="safe-px flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-200 bg-amber-50 py-2 text-xs text-amber-900">
          <p className="flex min-w-0 flex-1 basis-60 items-start gap-2">
            <Building2 size={14} aria-hidden className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words"><strong>Demo mode</strong> — synthetic sample data only; nothing here is real Broko data. Your changes are temporary: kept only in this browser for up to 24 hours, then discarded.</span>
          </p>
          <form action={resetDemo} className="ml-auto"><button type="submit" className="min-h-11 rounded border border-amber-300 px-3 font-medium hover:bg-amber-100 sm:min-h-0 sm:px-2 sm:py-0.5">Reset demo</button></form>
        </div>
      )}
      <main className="safe-px min-w-0 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:pt-5">{children}</main>
    </div>
  );
}

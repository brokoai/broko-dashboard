"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

const TABS = [
  { href: "/precon", label: "Overview", exact: true },
  { href: "/precon/projects", label: "Projects" },
  { href: "/precon/documents", label: "Documents" },
  { href: "/precon/inventory", label: "Inventory" },
];

/** Section tabs. On a phone they scroll sideways inside their own row, so the page itself never overflows. */
export function PreconTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Pre-Construction sections" className="mb-5 -mx-4 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1">
        {TABS.map((t) => {
          const active = t.exact ? path === t.href : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium sm:min-h-10",
                  active ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

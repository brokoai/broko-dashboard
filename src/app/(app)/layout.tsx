import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { getRepo, requireUser } from "@/lib/auth";
import { getBackend } from "@/lib/backend";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [repo, backend] = await Promise.all([getRepo(user), getBackend()]);
  const notifications = await repo.listNotifications().catch(() => []);
  return <AppShell user={user} notifications={notifications} demo={backend.kind === "demo"}>{children}</AppShell>;
}

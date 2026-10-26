import "server-only";
import { getRepo, requireUser } from "@/lib/auth";
import { canManagePrecon } from "@/lib/precon/permissions";
import type { FileStore, PreconRepo } from "@/lib/precon/repo";
import type { PreconContext } from "@/lib/precon/service";
import type { Profile } from "@/lib/types";

/** Authenticates first; user, role and repository all come from the server session. Never from the request. */
export async function preconContext(): Promise<PreconContext & { user: Profile }> {
  const user = await requireUser();
  const repo = await getRepo(user);
  return { user, repo: repo.precon, files: repo.preconFiles ?? null };
}

export async function preconPage(): Promise<{ user: Profile; precon: PreconRepo; files: FileStore | null; canManage: boolean; readOnly: boolean; now: number }> {
  const ctx = await preconContext();
  // The layout already refuses to render children without a repository; this keeps the pages type-safe.
  if (!ctx.repo) throw new Error("Pre-Construction is not connected");
  return { user: ctx.user, precon: ctx.repo, files: ctx.files, canManage: canManagePrecon(ctx.user) && ctx.repo.writable, readOnly: !ctx.repo.writable, now: Date.now() };
}

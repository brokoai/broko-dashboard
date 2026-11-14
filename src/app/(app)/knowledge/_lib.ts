import "server-only";
import { getRepo, requireUser } from "@/lib/auth";
import type { KnowledgeContext } from "@/lib/knowledge/service";

/** Authenticates first; the user, role and repositories all come from the server session. Never from the request. */
export async function knowledgeContext(): Promise<KnowledgeContext> {
  const user = await requireUser();
  const repo = await getRepo(user);
  return { user, repo: repo.knowledge, precon: repo.precon };
}

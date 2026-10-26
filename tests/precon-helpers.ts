import type { FileStore, PreconRepo } from "../src/lib/precon/repo";
import { createMemoryPreconRepo, emptyStore, type MemoryStore } from "../src/lib/precon/memory-repo";
import type { PreconContext } from "../src/lib/precon/service";
import type { Profile } from "../src/lib/types";

export const ADMIN: Profile = { id: "00000000-0000-4000-8000-00000000000a", full_name: "Ada Admin", email: null, role: "admin", title: null };
export const MEMBER: Profile = { id: "00000000-0000-4000-8000-0000000000b1", full_name: "Mo Member", email: null, role: "member", title: null };
export const MEMBER2: Profile = { id: "00000000-0000-4000-8000-0000000000b2", full_name: "Mia Member", email: null, role: "member", title: null };

/** In-memory object storage. `put` plays the part of the browser's PUT to the signed upload URL. */
export function memoryFiles() {
  const objects = new Map<string, Uint8Array>();
  const issued: string[] = [];
  let failRemove = false;
  const store: FileStore & { objects: Map<string, Uint8Array>; issued: string[]; put(url: string, bytes: Uint8Array): void; failRemove(on: boolean): void } = {
    objects, issued,
    async createUpload(path) { issued.push(path); return { url: `https://files.test/upload/${path}?token=t`, token: "t" }; },
    async download(path) { return objects.get(path) ?? null; },
    async remove(path) { if (failRemove) throw new Error("storage down"); objects.delete(path); },
    async signedUrl(path, ttl, o) { return `https://files.test/sign/${path}?ttl=${ttl}${o?.downloadAs ? `&dl=${encodeURIComponent(o.downloadAs)}` : ""}`; },
    put(url, bytes) { objects.set(decodeURIComponent(new URL(url).pathname.replace("/upload/", "")), bytes); },
    failRemove(on) { failRemove = on; },
  };
  return store;
}

export interface World {
  store: MemoryStore;
  files: ReturnType<typeof memoryFiles>;
  repoFor(user: Profile, writable?: boolean): PreconRepo;
  ctx(user: Profile, over?: Partial<PreconContext>): PreconContext;
  clock: { now: Date };
}

export function world(): World {
  const store = emptyStore();
  const files = memoryFiles();
  const clock = { now: new Date("2026-10-26T12:00:00Z") };
  const repoFor = (user: Profile, writable = true) => createMemoryPreconRepo({ user, store, writable, now: () => clock.now });
  return {
    store, files, clock, repoFor,
    ctx: (user, over = {}) => ({ user, repo: repoFor(user), files, log: () => undefined, ...over }),
  };
}

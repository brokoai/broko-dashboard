import "server-only";
import { cookies } from "next/headers";
import { DEMO_COOKIE } from "../constants";
import type { Backend } from "../types";
import { createDemoRepo, DEMO_USERS } from "./repo";

/** Loaded only via dynamic import when demo mode is explicitly enabled (never in production). */
export const demoBackend: Backend = {
  kind: "demo",
  async getCurrentUser() {
    const id = (await cookies()).get(DEMO_COOKIE)?.value;
    return DEMO_USERS.find((u) => u.id === id) ?? null;
  },
  async signInWithPassword() {
    return { error: "Demo mode uses the placeholder accounts on the sign-in page." };
  },
  async signOut() {
    (await cookies()).delete(DEMO_COOKIE);
  },
  async repoFor(user) {
    return createDemoRepo(user);
  },
  demo: {
    accounts: DEMO_USERS,
    async signInAs(id) {
      if (!DEMO_USERS.some((u) => u.id === id)) return false;
      (await cookies()).set(DEMO_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/" });
      return true;
    },
  },
};

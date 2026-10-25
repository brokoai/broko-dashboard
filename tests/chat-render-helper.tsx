// Run as a child process WITHOUT the react-server condition (react-dom/server is unavailable under it).
// Reads [{ kind, props }] on stdin, prints the static HTML of each as a JSON array.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Module from "node:module";

// Server actions import `server-only`, which throws outside a Server Component. Rendering a client component here never
// calls an action, so the marker module is replaced by an empty one for this process only.
type Loader = (request: string, ...rest: unknown[]) => unknown;
const internals = Module as unknown as { _load: Loader };
const realLoad = internals._load;
internals._load = function (this: unknown, request, ...rest) {
  return request === "server-only" ? {} : realLoad.call(this, request, ...rest);
};

async function main() {
  const [{ ChatLauncher, ReplyView, TurnView }, { AiInboxList }, { AiQueuePanel }] = await Promise.all([
    import("../src/components/broko-chat-view"), import("../src/components/ai-inbox-list"), import("../src/components/ai-queue-panel"),
  ]);
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  // A stub router: components call useRouter() while rendering, and nothing here navigates.
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  const parts = { reply: ReplyView, turn: TurnView, launcher: ChatLauncher, inbox_list: AiInboxList, queue_panel: AiQueuePanel } as const;
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer) => chunks.push(c));
  process.stdin.on("end", () => {
    const cases = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { kind: keyof typeof parts; props: Record<string, unknown> }[];
    const out = cases.map((c) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, createElement(parts[c.kind] as never, c.props as never))));
    process.stdout.write(JSON.stringify(out));
  });
}
void main();

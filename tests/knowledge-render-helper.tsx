// Run as a child process WITHOUT the react-server condition (react-dom/server is unavailable under it).
// Reads [{ item, replacement }] on stdin, prints the static HTML of an ItemCard for each as a JSON array.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemCard } from "../src/components/knowledge/item-card";
import type { ReplacementView } from "../src/lib/knowledge/policy";
import type { KnowledgeItem } from "../src/lib/knowledge/types";

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const cases = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { item: KnowledgeItem; replacement?: ReplacementView }[];
  const now = new Date("2026-10-26T12:00:00Z");
  process.stdout.write(JSON.stringify(cases.map((c) => renderToStaticMarkup(createElement(ItemCard, { item: c.item, now, replacement: c.replacement })))));
});

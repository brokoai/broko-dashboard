import { emptyStore, type MemoryStore, type StoredChunk, type StoredDocument, type StoredUnit } from "./memory-repo";
import type { DocKind, PreconProject, ProjectStatus } from "./types";
import { EXTRACTOR_VERSION } from "./types";

// SYNTHETIC SAMPLE DATA for the public demo. Every project is named "[Demo] ..." and every record says so. Nothing here is a real
// development, developer, price or document. Dates are relative to "now" so the demo never looks abandoned. The demo has no stored
// files: documents carry extracted text only (has_file = false), which is what the AI Brain and the viewer read.

const id = (n: number) => `d3300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (now: Date, offsetDays: number) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString();

export const DEMO_PROJECT_IDS = { harbour: id(1), maple: id(2), ridge: id(3), empty: id(4) } as const;

interface Seed {
  project: Omit<PreconProject, "created_at" | "updated_at" | "archived_at"> & { updated: number };
  docs: { n: number; title: string; kind: DocKind; pages: string[] }[];
  units: { type: string; beds: number | null; den?: boolean; baths: number; area: number; price: number | null; availability: StoredUnit["availability"]; occupancyYears?: number; verified?: boolean; unit?: string }[];
}

export function demoPreconStore(now: Date = new Date()): MemoryStore {
  const store = emptyStore();
  const year = now.getUTCFullYear();
  const seeds: Seed[] = [
    {
      project: {
        id: DEMO_PROJECT_IDS.harbour, name: "[Demo] Harbourfront Residences", developer: "[Demo] Example Developments Inc.", city: "Toronto",
        address: "100 Example Quay (sample)", status: "selling" as ProjectStatus,
        description: "SAMPLE DATA. A fictional waterfront condominium used to demonstrate the Pre-Construction Advisor.",
        expected_completion: `${year + 2}-09-30`, updated: -2,
      },
      docs: [
        {
          n: 11, title: "[Demo] Harbourfront brochure", kind: "brochure",
          pages: [
            "SAMPLE BROCHURE. Harbourfront Residences is a fictional 38-storey condominium on the Toronto waterfront. Suites range from studios to three bedrooms.",
            `Key selling points: rooftop pool and terrace, 24-hour concierge, a fitness studio, and direct access to the waterfront trail. Occupancy is expected in ${year + 2}.`,
            "Two bedroom suites feature floor-to-ceiling windows, an integrated kitchen and a balcony. Parking and lockers are available for purchase.",
          ],
        },
        {
          n: 12, title: "[Demo] Harbourfront floor plans", kind: "floor_plan",
          pages: [
            "Floor plan A: one bedroom, 1 bathroom, 560 square feet. Open living and kitchen area with a 90 square foot balcony.",
            "Floor plan B: two bedrooms, 2 bathrooms, 820 square feet. Primary bedroom with ensuite and walk-in closet.",
            "Floor plan C: two bedrooms plus den, 2 bathrooms, 960 square feet. The den can be used as a home office.",
          ],
        },
        {
          n: 13, title: "[Demo] Harbourfront sales update (older)", kind: "document",
          // Deliberately conflicts with the project record: the Brain must say so instead of picking one.
          pages: [`SAMPLE UPDATE. The sales team currently anticipates occupancy in ${year + 3}, subject to construction progress.`],
        },
      ],
      units: [
        { type: "One bedroom", beds: 1, baths: 1, area: 560, price: 589_000, availability: "available", occupancyYears: 2, verified: true, unit: "H-0805" },
        { type: "One bedroom plus den", beds: 1, den: true, baths: 1, area: 640, price: 649_000, availability: "available", occupancyYears: 2, unit: "H-1011" },
        { type: "Two bedroom", beds: 2, baths: 2, area: 820, price: 779_000, availability: "available", occupancyYears: 2, verified: true, unit: "H-1204" },
        { type: "Two bedroom", beds: 2, baths: 2, area: 835, price: 829_000, availability: "reserved", occupancyYears: 2, unit: "H-1506" },
        { type: "Two bedroom plus den", beds: 2, den: true, baths: 2, area: 960, price: 949_000, availability: "available", occupancyYears: 2, unit: "H-1802" },
        { type: "Three bedroom", beds: 3, baths: 3, area: 1280, price: 1_390_000, availability: "sold", occupancyYears: 2, unit: "H-3001" },
        { type: "Studio", beds: 0, baths: 1, area: 410, price: null, availability: "unknown", unit: "H-0501" },
      ],
    },
    {
      project: {
        id: DEMO_PROJECT_IDS.maple, name: "[Demo] Maple Grove Towns", developer: "[Demo] Sample Homes Ltd.", city: "Mississauga",
        address: "20 Sample Lane (sample)", status: "under_construction" as ProjectStatus,
        description: "SAMPLE DATA. Fictional townhomes used to demonstrate project, document and inventory views.",
        expected_completion: `${year + 1}-03-31`, updated: -9,
      },
      docs: [
        {
          n: 21, title: "[Demo] Maple Grove price list", kind: "pricing_sheet",
          pages: ["SAMPLE PRICE LIST. Three bedroom townhomes from 899,000 CAD. Parking is included. Closing is expected in the spring."],
        },
      ],
      units: [
        { type: "Three bedroom townhome", beds: 3, baths: 3, area: 1650, price: 899_000, availability: "available", occupancyYears: 1, verified: true, unit: "M-12" },
        { type: "Three bedroom townhome", beds: 3, baths: 3, area: 1700, price: 925_000, availability: "available", occupancyYears: 1, unit: "M-14" },
        { type: "Two bedroom stacked townhome", beds: 2, baths: 2, area: 1180, price: 719_000, availability: "sold", occupancyYears: 1, unit: "M-03" },
      ],
    },
    {
      project: {
        id: DEMO_PROJECT_IDS.ridge, name: "[Demo] Ridgeview Lofts", developer: "[Demo] Example Developments Inc.", city: "Markham",
        address: "5 Placeholder Road (sample)", status: "pre_construction" as ProjectStatus,
        description: "SAMPLE DATA. A fictional project whose inventory was last updated a long time ago, to show how stale records are flagged.",
        expected_completion: `${year + 3}-12-31`, updated: -200,
      },
      docs: [],
      units: [
        { type: "One bedroom loft", beds: 1, baths: 1, area: 600, price: 519_000, availability: "available", occupancyYears: 3, unit: "R-210" },
      ],
    },
    {
      project: {
        id: DEMO_PROJECT_IDS.empty, name: "[Demo] Lakeside Phase Two", developer: null, city: "Oakville", address: null, status: "pre_construction" as ProjectStatus,
        description: "SAMPLE DATA. A fictional project with no documents and no inventory yet, to show empty states.",
        expected_completion: null, updated: -20,
      },
      docs: [],
      units: [],
    },
  ];

  let unitSeq = 0;
  for (const s of seeds) {
    const updated = day(now, s.project.updated);
    const { updated: _u, ...p } = s.project;
    void _u;
    store.projects.push({ ...p, archived_at: null, created_at: day(now, s.project.updated - 30), updated_at: updated });
    for (const d of s.docs) {
      const doc: StoredDocument = {
        id: id(d.n), project_id: p.id, title: d.title, filename: `${d.title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.pdf`, kind: d.kind, mime_type: "application/pdf",
        size_bytes: 120_000, status: "processed", status_detail: null, page_count: d.pages.length, chunk_count: d.pages.length, extractor_version: EXTRACTOR_VERSION,
        attempts: 1, uploaded_by: null, uploader_name: "Sample data", created_at: day(now, s.project.updated - 1), processed_at: day(now, s.project.updated - 1),
        has_file: false, storage_path: null, sha256: null,
      };
      store.documents.push(doc);
      d.pages.forEach((text, i) => {
        const c: StoredChunk = { id: id(d.n * 100 + i), document_id: doc.id, project_id: p.id, chunk_index: i, page: i + 1, content: text };
        store.chunks.push(c);
      });
    }
    s.units.forEach((u) => {
      store.inventory.push({
        id: id(5000 + unitSeq++), project_id: p.id, unit_number: u.unit ?? null, unit_type: u.type, bedrooms: u.beds,
        den: u.den ?? false, bathrooms: u.baths, area_sqft: u.area, price: u.price, currency: "CAD", availability: u.availability,
        expected_occupancy: u.occupancyYears ? `${year + u.occupancyYears}-09-30` : null, source: "Sample data", source_document_id: null,
        verified_at: u.verified ? day(now, s.project.updated) : null, updated_at: updated,
      });
    });
  }
  return store;
}

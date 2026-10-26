// Light module (no parsers) so the import screen can use the field list without pulling PDF/XLSX libraries into the browser bundle.
export const IMPORT_FIELDS = ["unit_number", "unit_type", "bedrooms", "bathrooms", "area_sqft", "price", "currency", "availability", "expected_occupancy"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABEL: Record<ImportField, string> = {
  unit_number: "Unit number", unit_type: "Unit type", bedrooms: "Bedrooms", bathrooms: "Bathrooms", area_sqft: "Area (sq ft)",
  price: "Price", currency: "Currency", availability: "Availability", expected_occupancy: "Expected occupancy",
};
export const DEFAULT_CURRENCY = "CAD";

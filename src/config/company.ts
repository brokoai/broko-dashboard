// Company-level facts. Leadership is company data, NOT the signed-in user:
// the signed-in user's name and role always come from their profile.
export const company = {
  name: "BROKO REALTY LTD",
  product: "BROKO AI OPERATIONS",
  tagline: "Building Spaces. Creating Value.",
  leadership: [{ name: "Pankaj Arora", title: "Founder & CEO" }],
} as const;

import { company } from "@/config/company";

export function BrandHeader() {
  const [first, ...rest] = company.product.split(" ");
  return (
    <div className="relative mb-4 overflow-hidden rounded-lg border border-line bg-surface px-4 py-4 shadow-card sm:mb-5 sm:px-6 sm:py-5">
      <div aria-hidden className="absolute -right-10 -top-10 hidden h-40 w-56 rotate-12 bg-brand sm:block" style={{ clipPath: "polygon(30% 0, 100% 0, 100% 100%, 0 100%)" }} />
      <div aria-hidden className="absolute right-24 top-0 hidden h-full w-1 rotate-12 bg-ink/10 sm:block" />
      <div aria-hidden className="absolute inset-y-0 right-0 w-1.5 bg-brand sm:hidden" />
      <h1 className="break-words pr-3 text-xl font-extrabold tracking-tight text-ink min-[360px]:text-2xl sm:pr-0 sm:text-3xl">
        <span className="text-brand">{first}</span> {rest.join(" ")}
      </h1>
      <p className="mt-1 break-words pr-3 text-sm text-muted sm:pr-0">{company.tagline}</p>
      <div aria-hidden className="mt-3 h-0.5 w-20 bg-brand" />
    </div>
  );
}

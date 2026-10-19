export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <div className="h-24 animate-pulse rounded-lg bg-gray-200/70" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-200/70" />)}
      </div>
      <div className="h-72 animate-pulse rounded-lg bg-gray-200/70" />
    </div>
  );
}

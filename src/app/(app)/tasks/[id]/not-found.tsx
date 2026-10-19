import Link from "next/link";

export default function TaskNotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-card">
      <h1 className="text-lg font-semibold text-ink">Task not found</h1>
      <p className="mt-2 text-sm text-muted">It may have been removed, or you may not have access to it.</p>
      <Link href="/tasks" className="mt-4 inline-block text-sm font-medium text-brand hover:underline">Back to tasks</Link>
    </div>
  );
}

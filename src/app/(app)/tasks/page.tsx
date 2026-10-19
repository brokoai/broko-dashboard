import { PageTitle } from "@/components/ui";
import { TaskPanel } from "@/components/task-panel";
import { getRepo, requireUser } from "@/lib/auth";

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, user] = await Promise.all([searchParams, requireUser()]);
  const repo = await getRepo(user);
  const [tasks, people] = await Promise.all([repo.listTasks(), repo.listPeople()]);
  return (
    <>
      <PageTitle title="My Tasks">Tasks assigned to you by default. Change the owner filter to see other tasks you have access to.</PageTitle>
      <TaskPanel key={q ?? ""} tasks={tasks} people={people} user={user} initialQuery={q ?? ""} />
    </>
  );
}

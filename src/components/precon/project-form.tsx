"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { saveProject, type ProjectFormState } from "@/app/(app)/precon/actions";
import { btn, field } from "@/components/ui";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, type PreconProject } from "@/lib/precon/types";

export function ProjectForm({ project }: { project?: PreconProject }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ProjectFormState, FormData>(saveProject, {});
  useEffect(() => {
    if (state.ok && state.id) router.push(`/precon/projects/${state.id}`);
  }, [state, router]);
  const label = "mb-1 block text-sm font-medium text-ink";
  return (
    <form action={action} className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
      {project && <input type="hidden" name="id" value={project.id} />}
      <div className="sm:col-span-2">
        <label htmlFor="pf-name" className={label}>Project name</label>
        <input id="pf-name" name="name" required maxLength={200} defaultValue={project?.name ?? ""} className={field} />
      </div>
      <div>
        <label htmlFor="pf-dev" className={label}>Developer</label>
        <input id="pf-dev" name="developer" maxLength={200} defaultValue={project?.developer ?? ""} className={field} />
      </div>
      <div>
        <label htmlFor="pf-city" className={label}>City</label>
        <input id="pf-city" name="city" maxLength={100} defaultValue={project?.city ?? ""} className={field} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="pf-addr" className={label}>Address</label>
        <input id="pf-addr" name="address" maxLength={300} defaultValue={project?.address ?? ""} className={field} />
      </div>
      <div>
        <label htmlFor="pf-status" className={label}>Status</label>
        <select id="pf-status" name="status" defaultValue={project?.status ?? "pre_construction"} className={field}>
          {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="pf-date" className={label}>Expected completion</label>
        <input id="pf-date" name="expected_completion" type="date" defaultValue={project?.expected_completion ?? ""} className={field} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="pf-desc" className={label}>Description</label>
        <textarea id="pf-desc" name="description" rows={4} maxLength={4000} defaultValue={project?.description ?? ""} className={field} />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={`${btn.base} ${btn.primary}`}>{pending ? "Saving…" : project ? "Save changes" : "Create project"}</button>
        {state.error && <p role="alert" className="min-w-0 break-words text-sm text-red-700">{state.error}</p>}
      </div>
    </form>
  );
}

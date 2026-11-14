# Architecture decision record: Brain v1 security decisions D1–D6

Last corrected 2026-11-02 at the owner's instruction. **Only D1 is a decision. D2–D6 are unresolved: each is a proposal or recommendation awaiting the owner's approval.** Nothing in this file is implemented, applied or deployed, and none of the proposals below may be treated as policy.

| ID | Subject | Status |
| --- | --- | --- |
| D1 | Independent Brain per company | **Decided as a future architecture principle** (Broko is the only company being implemented) |
| D2 | Repository visibility | **Unresolved.** Recommendation only. No GitHub setting changed. |
| D3 | Project access | **Unresolved.** Model A is a *proposal*. |
| D4 | `team_workload()` | **Unresolved.** Admin-only restriction is a *proposal*. |
| D5 | Retention periods | **Unresolved.** Periods are *recommendations only*, not approved and not enforced. |
| D6 | Second reviewer for Knowledge | **Unresolved.** The definition and the exception procedure are *proposals*. |

---

## D1: Independent Brain per company (decided, future principle)

- **Decision.** Broko is the only company being implemented. This is Broko's own independent AI Brain. As a future architecture principle, every future company receives its own completely independent Brain (application deployment, Supabase project and database, knowledge base, credentials, Redis namespace, Anthropic credentials and configuration). Nothing is shared between companies. Broko is not building a multi-tenant system.
- **Applies now.** Only as a design constraint on Broko's own Brain. **No additional company, deployment, database or infrastructure is to be provisioned**, and no existing Broko environment or deployment changes.
- **Consequences.** The `organization_id` columns reserved in `chat_audit`, `knowledge_items` and `answer_feedback` stay unused. No tenant-isolation code is built.
- **Assumptions.** (a) "Redis namespace" is read as at least a distinct key prefix and token. (b) The same repository and migration set would serve every future company.
- **Details.** `docs/CLIENT_DEPLOYMENT.md`.

## D2: Repository visibility (unresolved; recommendation only)

No GitHub setting was changed and none will be without the owner's decision.

**Recommendation:** make `brokoai/broko-dashboard` private. Visibility is changed by someone with admin rights on that repository; I have not verified who that is.

What visibility exposes today (from files in the repository and the earlier public GitHub check):
- The security architecture, the audit findings and the open-risk lists, which are an attacker's reading list.
- The identity of development infrastructure (the `broko-dev` project reference appears in docs).
- Commit author names and email addresses.
- Test fixtures containing credential-shaped strings. A limited, pattern-based history scan found no real keys: the `sk-ant-` strings are obvious fixtures. It was not exhaustive.

Implications of going private:
- Vercel's GitHub integration keeps working but must be checked against the plan in use. GitHub Actions minutes are limited for private repositories on free plans (check the plan before relying on CI).
- Collaborators and outside reviewers need explicit access.
- It does not retract what already exists: forks, clones and caches of the public history persist. Anything sensitive in history would still need rotation. Run a full-history secret scan with or before the change.

## D3: Project access (unresolved; Model A is a proposal)

- **Proposal (Model A).** All authenticated employees of the company can see its **active** projects. Archived projects stay inaccessible to non-administrators under the existing rules.
- **What the code does today, regardless of approval.** `precon_projects_read` is `archived_at is null or is_admin()` (`0007`); child tables and project knowledge inherit through a subquery. So the *current behaviour* equals Model A. Approving Model A would record that this is intended; rejecting it would mean building project-level access control.
- **Consequence of Model A.** There is no per-project confidentiality inside one company; customer-facing descriptions would have to say so.
- **Residual.** An author keeps read access to their own knowledge items after the project is archived (`author_id = auth.uid()` in `knowledge_items_read`).
- **Alternative if not approved.** A project-membership table and policy changes across the `precon_*` tables and knowledge. This is a larger change; nothing is planned or drafted for it.
- **Needs from the owner:** approve Model A, or choose the alternative.

## D4: `team_workload()` (unresolved; admin-only is a proposal)

- **Proposal.** Restrict `team_workload()` to administrators.
- **Today.** Any signed-in user receives every person's name, title, role and task counts (`0001_init.sql:220`). The Team page uses it (`src/app/(app)/team/page.tsx:9`). This is open finding M-5.
- **Illustrative SQL (text only; not a migration file; not reviewed or tested; not to be applied).** Shown so the owner can see the shape of the change:

  ```sql
  create or replace function public.team_workload()
  returns table (member_id uuid, full_name text, title text, role text,
                 assigned_count bigint, open_count bigint, completed_count bigint)
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if auth.uid() is null or not public.is_admin() then
      raise exception 'only administrators can view team workload' using errcode = '42501';
    end if;
    return query
      select p.id, p.full_name, p.title, p.role,
             count(t.id),
             count(t.id) filter (where t.status in ('open', 'in_progress')),
             count(t.id) filter (where t.status = 'completed')
      from public.profiles p
      left join public.tasks t on t.assigned_to = p.id
      group by p.id
      order by p.full_name;
  end $$;
  ```
- **Application changes that would go with it (not done):** admin-only Team page, hide the nav item for members, matching demo behaviour, tests.
- **Status of work.** No migration file has been created for this. If the owner approves, a migration would be drafted in a later, separately approved step.

## D5: Retention (unresolved; periods are recommendations only)

Recommended starting periods, **not approved, not policy, not enforced**:

| Data | Recommended starting period |
| --- | --- |
| `chat_audit` | 180 days |
| `answer_feedback` | 180 days |
| `knowledge_events` | life of the item |

They would be subject to client and legal review in any case. Nobody has DELETE on these tables and no purge function exists, so nothing is removed automatically. See `docs/RETENTION.md`. No purge migration has been created.

## D6: Second reviewer for Knowledge (unresolved; all of it is a proposal)

- **Proposal.** Approving knowledge that influences answers should be done by a reviewer other than its author.
- **Today's behaviour (fact).** An administrator can approve their own submission (`docs/KNOWLEDGE_MEMORY.md`, decision 2; `knowledge_review()` does not compare reviewer and author). D6 is not implemented and not policy.
- **Proposed definition of "production-sensitive" (proposal):** every item approved in a deployment that serves real employees; a development or demo database exempt.
- **Proposed small-team exception (proposal):** where only one administrator exists, that administrator may approve their own item with a review note starting `SOLE-ADMIN EXCEPTION:` and a reason; a named business owner reviews each exception within seven days; the exception ends once a second administrator exists.
- **Possible enforcement (proposal, not drafted):** `knowledge_review()` refuses a reviewer who is the author when two or more administrators exist. It would be its own migration and its own approval.
- **Needs from the owner:** approve, change or reject the definition, the seven-day review and the enforcement idea.

---

## Outstanding decisions and risks

### Decisions requiring the owner's approval

| # | Decision | Recommendation |
| --- | --- | --- |
| O1 | D2 repository visibility | Make it private; see D2 |
| O2 | D3 project access | Approve Model A (matches current behaviour) |
| O3 | D4 `team_workload()` admin-only | Approve, then draft the migration in a later step |
| O4 | D5 retention periods | Approve as a starting point for client and legal review |
| O5 | D6 second reviewer: definition, seven-day exception review, enforcement | Decide each part |
| O6 | CI proposal (`docs/CI_PROPOSAL.md`) | Pull the skeleton forward |
| O7 | Read-only byte comparison on `broko-dev` (stored SQL of 0001, 0002, 0006, 0007) | Yes, in Phase 3, read-only first |
| O8 | Phase 2 design choices, see the Phase 2 report | |

### Risks

| # | Risk | Effect | Mitigation |
| --- | --- | --- | --- |
| K1 | The stored SQL of 0001, 0002, 0006, 0007 on `broko-dev` is unverified | The task guard, email column grant and last-admin guard may differ from the files | Phase 3 byte comparison |
| K2 | Admin self-approval is possible | One account can publish unreviewed knowledge | Decide D6 |
| K3 | Retention is not enforced | Data is kept until someone removes it | State plainly; build only after D5 |
| K4 | Production behaviour is unverified | The live site is a synthetic demo | Phase 6 |
| K5 | The repository is public | See D2 | Owner decision |
| K6 | No CI workflow exists | Regressions are caught only if someone runs the suite | Decide O6 |
| K7 | 0011 and the secret check are not on any database | Mismatched replacements and secret bypass remain possible on dev | Phases 2–3 |

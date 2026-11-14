# Changes to migration 0014 — items 1 and 2 APPROVED and EDITED INTO THE FILE (2026-11-12); APPLIED to broko-dev ONLY on 2026-11-12 (18/18 catalog audit); item 3 not made

Items 1 and 2 were approved by the owner and are now in `supabase/proposed/0014_org_relationships.proposed.sql` (exactly the two insertions shown below, nothing else). Item 3 (optional) was not made. 0014 is still not applied to any database. The two defects below are now refused by the database itself as well as by the application layer (which stays as defence in depth). Nothing here is a new migration (no 0015).

## 1. A stale relationship must not be approved (`org_relationship_review`)
Confirmed on local PGlite: a PROPOSED link the document no longer states (`stale = true`, no revision) was approved into `reviewed` while still stale.

In the `approve` branch, after the existing `only a proposed relationship can be approved` check, add:

```sql
    if r.stale then raise exception 'a stale relationship cannot be approved while its source has changed' using errcode = '55000'; end if;
```
Reject, accept_revision and dismiss_revision are unchanged (a stale link can still be rejected, and a waiting revision can still be accepted).

## 2. An empty key list must not stale anything (`org_relationship_stale_missing`)
Confirmed on local PGlite: `p_keep = '{}'` marked every non-rejected link of the document stale, including REVIEWED ones, hiding them from citation after an empty or
failed-validation extraction.

At the top of the body, after `perform public.org_memory_guard();`, add:

```sql
  if p_keep is null or cardinality(p_keep) = 0 then return 0; end if; -- an extraction that kept nothing proves nothing about what the document states
```

## 3. (Optional, low) evidence comparison should ignore order and duplicates
`same := r.evidence = p_evidence ...` is order- and duplicate-sensitive; the application always sends a de-duplicated, numerically ordered list so this does not
occur through the app. If you want the database to be independent of that, replace the comparison with a set comparison against the already-computed `ids`:

```sql
  same := r.evidence @> ids and r.evidence <@ ids and r.basis = p_basis and r.confidence = p_confidence and r.source_doc_id = p_doc;
```
(Storage order stays as supplied.) Not required for any current behaviour.

## What the approval changed
* Edit those fragments into 0014, re-run `supabase/proposed/tests/0014_org_relationships.pglite.mjs` (add: stale approve refused; empty keep returns 0 and stales nothing; non-empty keep still stales missing links) and the 0013 test, and update the catalog audit only if function bodies were audited (they are not).
* The application-layer guards stay as defence in depth.
* 0014 was applied to broko-dev only (2026-11-12) in the form that contains items 1 and 2; both are confirmed present in the applied functions. It has not been applied anywhere else, and no relationship data exists yet, so rollback (the manual `drop` at the end of the file) would lose nothing.

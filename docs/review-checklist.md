# Release review checklist

## Functional

- Project ambiguity never searches multiple projects.
- Current queries exclude archived/history/process material unless explicitly requested.
- Search returns no more than four primary and two linked evidence items.
- Every evidence item resolves to an existing Markdown file and line range.
- Missing evidence is `insufficient`; active-source conflicts are `conflict`.
- AI-created candidate memory cannot self-confirm.
- Incremental synchronization (`sbrain sync` / `second_brain_sync`) updates only affected collections and cleans deleted slices.
- Unindexed notes modified after sync are recalled via read-only in-memory overlay while reporting degraded search mode.
- Synchronous health reporting (v2) returns exact vector coverage and per-scope freshness without fabricating values.
- Deleted files never cause search exceptions and are cleanly filtered from stale lexical/vector lists.

## Privacy and security

- Package contains no vault Markdown, absolute personal paths, credentials, indexes, models, logs, or candidate records.
- Audit traces contain no snippets or secret-like values.
- Search and sync start no network listener and write nothing to the vault.
- FastEmbed semantic indexing runs with pinned `local_files_only=True` without outbound network access.
- Data directory is outside the vault and is safe to delete.
- Lock acquisition uses atomic claim and verifies lock identity before reclamation to avoid race conditions.

## Reproducibility and license

- Clean `npm ci` succeeds on Node 22+.
- `npm run verify`, coverage, and package dry-run pass.
- Dependency audit and license inventory are reviewed.
- The package manifest includes only intended public files.

## Acceptance

- Cross-project contamination and fabricated high-impact facts: 0.
- High-impact factual claims with opened-source evidence: 100%.
- Current/history classification: at least 95%.
- Recall@5: at least 85%.
- Correct abstention: at least 90%.
- Invalid candidate promotion: 0.
- Search p95 on the target machine: at most 10 seconds.
- 40-case synthetic lexical evaluation: 100% pass rate.
- 40-case hybrid semantic evaluation: 100% pass rate over consecutive runs.


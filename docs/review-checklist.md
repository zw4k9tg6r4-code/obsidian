# Release review checklist

## Functional

- Project ambiguity never searches multiple projects.
- Current queries exclude archived/history/process material unless explicitly requested.
- Search returns no more than four primary and two linked evidence items.
- Every evidence item resolves to an existing Markdown file and line range.
- Missing evidence is `insufficient`; active-source conflicts are `conflict`.
- AI-created candidate memory cannot self-confirm.

## Privacy and security

- Package contains no vault Markdown, absolute personal paths, credentials, indexes, models, logs, or candidate records.
- Audit traces contain no snippets or secret-like values.
- Search starts no network listener and writes nothing to the vault.
- Data directory is outside the vault and is safe to delete.

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


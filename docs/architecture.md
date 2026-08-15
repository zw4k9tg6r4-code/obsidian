# Architecture

## Data boundary

```text
Obsidian Markdown vault (authoritative, read-only to retrieval)
        |
        v
project discovery and temporal filtering
        |
        v
QMD BM25 index + optional FastEmbed vector index (derived cache)
        |
        v
bounded evidence + source locations + decision

candidate memory queue (derived local state)
        |
        v
explicit human/source confirmation
        |
        v
existing safe Markdown write workflow
```

The index and candidate queue are disposable. Deleting them never deletes or changes the vault.

## Retrieval order

1. Discover projects from `02-项目/*/项目主页.md`.
2. Resolve an explicit project name or a unique positive identity match.
3. For project-scoped search, include only the explicit global-governance allowlist (`AGENTS.md`, user profile, cooperation rules), global workflows, and the resolved project collection. Full long-term memory is available only to global search. A contradiction between the explicit scope and another project named in the query abstains before retrieval.
4. Run BM25 and, when healthy, vector retrieval separately.
5. Deduplicate vector chunks by source, then fuse lexical and semantic ranks with RRF. Authority and temporal state are returned as metadata, not disguised as similarity.
6. Check the broader opened candidate set for material conflicts before truncating the response to four primary items. Expand at most two same-project Wiki links from selected evidence.
7. Open source files to locate the cited line range. Numeric claims must occur in opened evidence; explicit disputes or inconsistent current authoritative values for the same fact trigger a conflict.
8. Emit `grounded`, `insufficient`, or `conflict` with an audit trace identifier.

## Temporal and authority policy

- Current search excludes monthly conversation logs, templates, `02-过程`, and sources explicitly marked `superseded` or `expired`. Disputed sources remain visible only so a material conflict can be reported.
- History search may include process and conversation sources, labels their state, and never silently promotes them to current.
- Project home pages and project input sources outrank process notes. Explicit global-governance files remain available to project search; other long-term notes and conversation logs do not.
- A retrieval score never becomes a confidence label.

## Failure behavior

- Unknown or ambiguous project: no cross-project search.
- Missing semantic model or stale vector coverage: lexical search continues and health reports degraded mode.
- Corrupt index: close it, report failure, and rebuild only the derived cache.
- Missing source file: drop the result and record it in the audit trace.
- Candidate confirmation without user confirmation or a current authoritative source inside the bound project: reject the transition.

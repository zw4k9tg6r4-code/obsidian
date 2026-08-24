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
        |
        v
scoped incremental sync (sbrain sync / second_brain_sync)
```

The index and candidate queue are disposable. Deleting them never deletes or changes the vault.

## Retrieval order

1. Discover projects from `02-项目/*/项目主页.md` (all directory names come from `src/structure.js` and can be overridden per installation via the `structure` section of `config/config.json`).
2. Resolve an explicit project name or a unique positive identity match.
3. For project-scoped search, include only the explicit global-governance allowlist (`AGENTS.md`, user profile, cooperation rules), global workflows, and the resolved project collection. Full long-term memory is available only to global search. A contradiction between the explicit scope and another project named in the query abstains before retrieval.
4. If unindexed dirty files exist within the search scope, run an in-memory lexical overlay and exclude stale vectors corresponding to those dirty file paths.
5. Run BM25 and, when healthy, vector retrieval separately.
6. Deduplicate vector chunks by source, then fuse lexical, overlay, and semantic ranks with RRF. Authority and temporal state are returned as metadata, not disguised as similarity.
7. Check the broader opened candidate set for material conflicts before truncating the response to four primary items. Expand at most two same-project Wiki links from selected evidence.
8. Open source files to locate the cited line range. Numeric claims must occur in opened evidence; explicit disputes or inconsistent current authoritative values for the same fact trigger a conflict.
9. Emit `grounded`, `insufficient`, or `conflict` with an audit trace identifier.

## Incremental synchronization & scoped freshness

- **Scoped Freshness**: Track metadata per file with collection and temporal tags (`current` vs `history`). Modifying a history log (e.g. `04-对话纪要/2026-08.md`) only marks the history scope as pending, keeping current project searches 100% fresh.
- **In-Memory Overlay**: Search remains 100% read-only. Unsynced dirty notes in scope are scored in memory and recalled immediately without requiring disk or database writes.
- **Stable Chunking & Vector Reuse**: Chunks use deterministic content-hash IDs (`relativePath + chunkTextHash + occurrenceIndex`). Modifying adjacent sections or line numbers reuses existing vectors with zero re-embedding cost.
- **Dynamic 10s Budget**: Automatic semantic sync caps execution at 10 seconds, storing completed batches and marking remaining chunks as pending.
- **Concurrency & Locks**: Sync uses a non-blocking generation lock file outside the vault with heartbeat tracking.

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

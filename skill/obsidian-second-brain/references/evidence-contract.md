# Evidence contract

Search returns a versioned JSON object with these decision values:

- `grounded`: the opened source set satisfies the evidence gate.
- `insufficient`: scope, freshness, authority, or evidence is inadequate.
- `conflict`: current evidence is marked disputed or authoritative sources disagree on the same material fact; conflict checks use the broader opened set before response truncation.

Important fields:

- `scope`: public project identity only; it must never include a local directory.
- `temporalIntent`: `current` or `history`.
- `degraded` and `degradedReason`: whether semantic retrieval, freshness, or source opening failed.
- `evidence`: at most four reopened Markdown sources.
- `relatedEvidence`: at most two same-project Wiki-linked sources.
- `path`, `lineStart`, `lineEnd`, `contentHash`: source location and integrity data.
- `authority`, `state`, `asOf`: trust, lifecycle, and freshness data.
- `lexicalRank`, `vectorRank`, `rrfScore`, `matchType`: relevance diagnostics only.
- `traceId`: reference to a privacy-minimized local audit event.

Do not convert `rrfScore` or vector similarity into confidence. A material claim is supported only when its opened source actually states the claim and the source state applies to the question's time intent.

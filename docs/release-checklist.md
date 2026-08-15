# Release and independent-review checklist

No item in this checklist is implied by a clean branch or a successful upload. Record the command output, review decision, release hash, and remote commit as separate evidence.

## 1. Scope freeze

- [ ] The release implements only project-isolated BM25 plus local semantic retrieval, manual RRF, bounded evidence, trust gates, candidate governance, health/audit, and explicit fallback.
- [ ] Query expansion and LLM reranking remain disabled in version 1.
- [ ] There is no daemon, scheduled task, background Vault writer, cloud note upload, graph database, or bundled model.
- [ ] The exact GitHub repository URL and intended visibility were supplied by the owner; no target was inferred.
- [ ] The source tree is frozen for review and unrelated local changes are identified.

## 2. Clean reproducibility

- [ ] Node.js 22 or newer is used on the target Windows architecture.
- [ ] `package-lock.json` matches `package.json`; a clean `npm ci` succeeds in a new directory.
- [ ] `npm run verify`, `npm run test:coverage`, and `npm run pack:check` succeed from that clean copy.
- [ ] Optional semantic setup is tested separately and does not make lexical-only operation fail.
- [ ] Dependency vulnerability and license inventories are reviewed; every direct dependency and optional semantic dependency matches `THIRD_PARTY_NOTICES.md`.

## 3. Build from the explicit allowlist

Run from the repository root with a new, dedicated output directory:

```powershell
powershell -NoProfile -File .\scripts\build-release.ps1 `
  -OutputRoot 'D:\ReleaseReview\codex-second-brain'
```

- [ ] The output directory is not a Vault, home directory, repository root, or existing installation directory.
- [ ] Source allowlist roots/files and every existing ancestor of `OutputRoot` are ordinary paths, not reparse points, symbolic links, or junctions.
- [ ] The stage contains only allowlisted root files and `src/`, `scripts/`, `schemas/`, `docs/`, `skill/`, `test/`, and `.github/` source trees.
- [ ] `release-manifest.json` lists every source file with its size and SHA-256.
- [ ] `SHA256SUMS` covers every packaged file except itself.
- [ ] The directory scan and ZIP scan both report `status: ok`.
- [ ] The archive SHA-256 is recorded in the review evidence.

## 4. Privacy and secret gates

- [ ] No real Vault Markdown, `.obsidian` directory, personal absolute path, real Vault name, email, phone number, government identifier, customer fact, price, account, or private benchmark question is present.
- [ ] No `.env`, local config, credential, private key, API token, database, SQLite/WAL/SHM, index, cache, model, candidate store, audit log, backup, coverage output, `node_modules`, or private evaluation directory is present.
- [ ] The only packaged test Vault is explicitly synthetic and contains no copied personal facts.
- [ ] Built-in scanning is rerun directly against both artifacts:

```powershell
powershell -NoProfile -File .\scripts\scan-release.ps1 `
  -Path '<stage-path>' -AllowSyntheticFixtures
powershell -NoProfile -File .\scripts\scan-release.ps1 `
  -Path '<archive-path>' -AllowSyntheticFixtures
```

- [ ] Gitleaks or an equivalent current secret scanner passes on both the working tree and complete Git history with matched values redacted from logs.
- [ ] A reviewer manually inspects the final ZIP entry list and searches all text for local usernames, Vault names, workspace paths, and organization/customer identifiers.

## 5. Contract and behavior gates

- [ ] Project identity is resolved before retrieval; ambiguous or unknown identity does not search multiple projects.
- [ ] Current retrieval excludes superseded, expired, disputed, process, conversation-history, archived, and candidate material unless the requested mode allows it.
- [ ] Each result contains no more than four primary and two same-project one-hop evidence items.
- [ ] Every evidence path is Vault-relative, remains inside the resolved Vault after real-path resolution, opens successfully, and has a valid line range and content hash.
- [ ] `grounded` requires opened current authoritative evidence; missing/weak evidence returns `insufficient`; active-source contradictions return `conflict` without silent arbitration.
- [ ] Missing semantic runtime/model, stale coverage, source-open failure, or index failure is surfaced as degraded mode; fallback never becomes an ungrounded answer.
- [ ] Candidate-to-confirmed requires explicit user confirmation or an independent current authoritative Markdown source inside the candidate's bound project. AI output and global/other-project notes cannot confirm it.
- [ ] Confirmed-to-current requires a verified Markdown write and reread/hash check. Replaced current facts become superseded atomically.
- [ ] Audit events conform to `schemas/audit-event.schema.json` and contain no raw query, snippet, note body, candidate content, secret, or absolute path.

## 6. Forty-question acceptance set

Use eight groups of five synthetic questions: exact keyword, Chinese paraphrase, similar-project isolation, current versus historical state, insufficient-evidence refusal, conflict detection, one-hop/provenance, and candidate-state governance.

- [ ] Cross-project leakage: 0.
- [ ] Invalid candidate promotion: 0.
- [ ] High-impact factual claims with opened source evidence: 100%.
- [ ] Current/history classification: at least 95%.
- [ ] Recall@5: at least 85%.
- [ ] Correct no-data refusal: at least 90%.
- [ ] Evidence path and line resolution: 100%.
- [ ] Search p95 on the target machine: at most 10 seconds.
- [ ] Three repeated synthetic runs produce stable decisions and evidence ordering.
- [ ] A real-Vault evaluation, if run, is read-only and publishes aggregate metrics only.

## 7. Windows install and rollback

- [ ] Install, semantic initialization, and Vault indexing are separate commands.
- [ ] Installation requires an explicit Vault path and validates Node, architecture, disk space, Vault root, target containment, and writable local data directory.
- [ ] Existing ancestors of the project, Vault, InstallRoot, Codex Skill root, and Antigravity Skill root contain no reparse point, symbolic link, or junction.
- [ ] Existing Codex and Antigravity Skill targets are backed up separately with file manifests and SHA-256 before replacement.
- [ ] Installation copies into a temporary sibling, verifies hashes, and replaces atomically; any failure restores the previous files.
- [ ] Installation does not change persistent execution policy, install a scheduled task, delete a Vault file, download a model without explicit consent, or uninstall a shared global runtime.
- [ ] Rollback restores the recorded prior Skill and configuration hashes, leaves the Vault unchanged, and moves new derived state to quarantine rather than deleting it.
- [ ] Uninstall retains index/cache/model data by default; any purge is a separate explicit and clearly targeted option.
- [ ] A disposable test Vault passes new install, lexical search, optional semantic setup, health check, uninstall/rollback, and restored-install smoke tests.

## 8. Independent approval and remote verification

- [ ] A reviewer who did not author the release performs a read-only scope, privacy, license, contract, Windows rollback, and artifact review.
- [ ] Findings are resolved and the exact reviewed archive hash is approved before any push.
- [ ] Only the owner-supplied repository is used. The intended branch and visibility are confirmed immediately before push.
- [ ] After push, the remote default branch, commit SHA, complete blob list/count, `LICENSE`, release manifest, and artifact SHA-256 match the approved local candidate.
- [ ] Source, staging, and publication worktrees are clean after remote verification.
- [ ] The release is called published only after remote verification evidence exists.

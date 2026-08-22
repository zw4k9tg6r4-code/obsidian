# Changelog

## 0.1.3 - 2026-08-22

- Centralize every vault-structure convention in `src/structure.js` and allow per-installation overrides through the optional `structure` section of `config/config.json`; align `schemas/config.schema.json` with what the runtime actually reads.
- Parse YAML frontmatter on Windows notes saved with a UTF-8 BOM so project status and identity fields no longer degrade silently.
- Let two-character project names participate in automatic positive scope matching.
- Match thousands-separated numerals (`12,000` vs `12000`) on both query and evidence sides, and treat English high-impact and conflict keywords like their Chinese counterparts.
- Reuse one index store per search (health plus lexical) and replace the full-content vault fingerprint with a path+size+mtime digest so health checks stop re-reading every note.
- Quarantine a corrupt candidate store instead of failing every candidate command, and guard read-modify-write cycles with a lock file so the CLI and MCP server cannot lose writes to each other.
- Surface lexical backend failures to search results instead of silently dropping them.
- Report one version everywhere from `package.json` via `src/version.js` (CLI help and MCP server previously announced 0.1.0).
- Prefer the Windows `py.exe` launcher over the Store-shadowed `python.exe` fallback, remove the unused `probeSemantic` helper and `configPath` runtime field, document the missing CLI commands, and add unit tests for structure resolution, BOM parsing, chunking, RRF edge cases, audit redaction, and store recovery.

## 0.1.2 - 2026-08-17

- Add a self-describing root `AGENTS.md` so a fresh Codex can safely install from a short request.
- Add `INSTALL.cmd` and a guided Windows installer with zero-write preflight, lexical initialization, health verification, and rollback reporting.
- Reject package/Vault containment and make installed-app index initialization independent of the caller's working directory.

## 0.1.1 - 2026-08-17

- Make release hashing independent of PowerShell module autoloading on Windows runners.
- Preserve the lexical Vault boundary when Windows short-path and long-path aliases differ.

## 0.1.0 - 2026-08-15

- Add project-isolated QMD BM25 and optional local Chinese semantic retrieval.
- Add source reopening, temporal and authority gates, material conflict detection, and bounded evidence.
- Add candidate-memory governance with explicit confirmation and verified activation.
- Add JSON CLI and candidate-limited local stdio MCP interfaces.
- Add Windows install, rollback, release allowlist, privacy scanning, schemas, and a 40-case synthetic evaluation.

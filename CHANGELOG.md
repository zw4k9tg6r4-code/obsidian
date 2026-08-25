# Changelog

## [0.2.0] - 2026-08-24

### Added
- **Incremental Lexical & Semantic Sync (`sbrain sync`)**: Added collection-scoped incremental index synchronization for QMD SQLite and FastEmbed semantic vector database.
- **Generation ID & Sync Locking**: Added generation tracking (`generationId`) with atomic `.claim` lock acquisition, heartbeat renewal, and dead/stale PID reclamation with identity verification.
- **Concurrent Write Detection**: Added pre/post sync snapshot comparison (`snapshotBefore` vs `trackedAfterSync`) so notes modified during sync remain dirty (`lexicalFresh: false`).
- **Read-Only In-Memory Overlay**: Added real-time recall for modified unindexed notes directly in search without requiring synchronous indexing.
- **Health v2 Schema**: Added detailed per-scope freshness (`current` vs `history`), exact vector coverage computed via `node:sqlite`, and `dirtyFiles` enumeration.
- **MCP Tool `second_brain_sync`**: Exposed incremental synchronization tool through stdio MCP server for agentic workflows.
- **FastEmbed Offline Contract & Budgeting**: Pinned `local_files_only=True` and offline environment variables with dynamic EMA batch budgeting.

### Changed
- **Version Bump**: Updated package version from `0.1.3` to `0.2.0`.
- **RRF Dirty Path Filtering**: Excluded dirty and physically deleted note paths from QMD BM25 ranked lists prior to fusion.
- **Default Hybrid Degraded Reporting**: Default hybrid search now reports `degraded: true` with reason when local semantic index is unavailable or missing.
- **History Scope Alignment**: Aligned history synchronization collections to include current project notes and global governance rules.

### Fixed
- Fixed semantic initialization so explicit `-AcceptModelDownload` consent invokes a dedicated model downloader, verifies offline loading, and then indexes while ordinary workers remain offline-only.
- Fixed Python runtime detection under Windows PowerShell 5.1 by using `python --version` instead of a quote-sensitive inline probe.
- Fixed manual index initialization from a dependency-free source package by falling back to the installed app CLI.
- Fixed unhandled exception when searching after physical note deletion.
- Fixed atomic lock reclamation race condition by verifying claimed lock identity before unlinking.
- Fixed atomic transaction rollback in semantic worker so index failures preserve existing chunks.
- Fixed stale semantic row cleanup for deleted notes across synchronized collections.

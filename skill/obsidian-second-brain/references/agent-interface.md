# Agent interface

## JSON CLI

Set `SECOND_BRAIN_VAULT` and, optionally, `SECOND_BRAIN_DATA_DIR`. When installed on Windows, the CLI is `%LOCALAPPDATA%\CodexSecondBrain\app\bin\sbrain.cmd`; a development checkout can use `npm run sbrain --`. Then call:

```text
sbrain projects --json
sbrain sync --project "project name" --time current --semantic auto --json
sbrain search --query "question" --project "project name" --time current --json
sbrain health --json
sbrain candidate add --content "proposal" --scope "project name" --json
```

All returned source paths are vault-relative. Search and health are read-only.

## stdio MCP

Run `%LOCALAPPDATA%\CodexSecondBrain\app\bin\sbrain-mcp.cmd` (or `npm run mcp` in a development checkout) with these environment variables in the MCP host configuration:

- `SECOND_BRAIN_VAULT`: absolute path to the local Markdown vault.
- `SECOND_BRAIN_DATA_DIR`: optional path for derived local state.

Available tools:

- `second_brain_search`: Read-only scoped search with in-memory overlay.
- `second_brain_projects`: Read-only project listing.
- `second_brain_health`: Read-only health status (Schema v2).
- `second_brain_candidate_add`: Propose candidate memory outside the vault.
- `second_brain_sync`: Bounded, incremental index synchronization for a project or all current scopes.

The MCP server is local stdio only. It does not open a network port. It intentionally omits confirm, activate, delete, and arbitrary-file-read tools.

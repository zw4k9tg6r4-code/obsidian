# Codex Obsidian Second Brain

A local retrieval and memory-governance companion for an Obsidian Markdown vault. It keeps Markdown as the only source of truth, narrows retrieval to a confirmed project scope, returns bounded evidence with source locations, and prevents model-generated guesses from silently becoming long-term facts.

## What it adds

- deterministic project-scope resolution before retrieval;
- pinned QMD BM25 keyword search plus an optional local FastEmbed Chinese semantic index;
- reciprocal-rank fusion without query expansion or LLM reranking by default;
- at most four primary evidence items and two same-project linked notes;
- `grounded`, `insufficient`, and `conflict` decisions;
- index health, privacy-safe audit traces, and lexical fallback;
- a candidate-memory lifecycle where AI output cannot confirm itself;
- JSON CLI and local stdio MCP interfaces for Codex, Antigravity, and other Agents.

It does **not** upload notes, replace Obsidian, run a graph database, start a background writer, or publish a copy of your vault.

## Requirements

- Windows, macOS, or Linux
- Node.js 22 or newer
- Python 3.12 for optional semantic search
- an existing Markdown vault with a root `AGENTS.md`

The first semantic indexing run may download the 90 MB `BAAI/bge-small-zh-v1.5` model. Keyword search works without Python or that model. Notes are not uploaded for search.

## Quick start

### Self-guided Windows package

Download and fully extract the release ZIP outside the Vault, open its root folder in Codex, and say `安装这个`. The root `AGENTS.md` gives a fresh Codex the complete safe installation flow, so no long prompt is needed. If the Vault path is not known, that is the only information Codex must request.

For a human-guided setup, double-click `INSTALL.cmd`. It installs the Codex Skill and creates a lexical index by default; it never modifies Vault Markdown or downloads the optional semantic model.

### Manual commands

```powershell
.\scripts\install.ps1 -VaultPath 'D:\Notes\MyVault' -Target both -AcceptNetwork
.\scripts\setup-semantic.ps1 -AcceptNetwork
.\scripts\initialize-index.ps1 -VaultPath 'D:\Notes\MyVault' -Semantic -AcceptModelDownload
& "$env:LOCALAPPDATA\CodexSecondBrain\app\bin\sbrain.cmd" health --json
```

Installation backs up the existing Codex/Antigravity Skill, installs pinned dependencies, and writes only local configuration outside the vault. It does not index the vault or download a model. Those are separate explicit steps. Use `scripts/rollback.ps1` with the emitted manifest to restore the previous installation.

The one-click wizard composes those explicit steps only after the user confirms its summary. Its default is Codex-only plus lexical indexing; semantic setup remains separately consented.

By default, derived data is stored under `%LOCALAPPDATA%\CodexSecondBrain`. Override it with `SECOND_BRAIN_DATA_DIR`.

## Trust rules

1. Project scope is resolved before search. Ambiguous scope returns candidates instead of searching several projects together.
2. Similarity is relevance, not factual confidence.
3. High-impact facts require an opened authoritative Markdown source.
4. Missing evidence returns `insufficient`; conflicting current sources return `conflict`.
5. AI-generated text starts as a project-bound `candidate`. Confirmation requires explicit user confirmation or a current authoritative source inside that same project, and activation is restricted to Markdown inside the bound project.
6. Superseded facts remain auditable and are excluded from current retrieval by default.

See [architecture](docs/architecture.md) and [review checklist](docs/review-checklist.md) for the full behavior and release gates.
The [research notes](docs/research-notes.md) record which open-source mechanisms were evaluated and what was deliberately not adopted.

## Commands

```text
sbrain index [--vault PATH] [--semantic]
sbrain sync [--project NAME] [--time current|history] [--semantic auto|always|never] [--budget MS]
sbrain search --query TEXT [--project NAME] [--time current|history] [--max-evidence 4] [--lexical-only]
sbrain health [--vault PATH]
sbrain projects [--vault PATH]
sbrain source-hash --path FILE [--vault PATH]
sbrain candidate add --content TEXT --scope PROJECT [--source-ref PATH]
sbrain candidate confirm --id ID (--user-confirmed | --source-ref PATH)
sbrain candidate activate --id ID --target FILE --expected-hash SHA256 [--supersedes ID]
sbrain candidate mark --id ID --status expired|disputed [--reason TEXT]
sbrain candidate list [--status STATE]
sbrain-mcp
```

All CLI commands can emit JSON with `--json`.
- `sbrain sync`: Incrementally synchronizes lexical QMD collections and optional semantic embeddings with generation locks and pre/post snapshot dirty verification. `--budget` specifies the embedding batch computation time budget in milliseconds.
- `sbrain search`: Read-only multi-source retrieval with RRF fusion, dirty-path filtering, and real-time in-memory overlay for modified unindexed notes.
- Search and health never write to the vault. The stdio MCP server exposes search, sync (`second_brain_sync`), projects, health, and candidate creation; it intentionally omits confirmation, activation, deletion, and arbitrary file reads.

## Vault structure

The default conventions are `02-项目/*/项目主页.md` for projects, `01-长期记忆/` for long-term memory, `04-对话纪要/` for conversation history, `05-工作流/` for workflows, and `01-输入/`, `02-过程/`, `03-输出/`, `04-反馈/` inside each project. Project directories starting with `_` are skipped. Every convention lives in `src/structure.js` and can be overridden per installation through the optional `structure` section of `config/config.json` (see `schemas/config.schema.json`); unknown keys, absolute paths, and parent traversal are rejected.

## Verification

The public test Vault is synthetic. `npm run verify` runs static checks, unit/integration tests, MCP tests, and a 40-case lexical safety baseline. A full local hybrid evaluation covers Chinese paraphrases, project isolation, current/history separation, abstention, conflicts, linked evidence, and candidate-state gates.

## License and upstream ideas

This repository is MIT licensed. It uses the MIT-licensed [`@tobilu/qmd`](https://github.com/tobi/qmd) package as a dependency. Basic Memory, Graphiti, LangMem, Mem0, and related projects informed the architecture; their code is not copied into this repository.

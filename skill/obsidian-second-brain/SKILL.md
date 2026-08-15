---
name: obsidian-second-brain
description: Retrieve and govern durable context in a local Obsidian Markdown second brain. Use when prior project context, decisions, preferences, workflows, failures, or current-vs-history distinctions may improve a substantive task; when the user asks to remember, retrieve, archive, continue, or update prior work; or before making high-impact claims that depend on local knowledge.
---

# Obsidian Second Brain

Treat Markdown as the only source of truth. Use the local retrieval companion to narrow scope, open real source evidence, and keep model output out of trusted memory until it is confirmed.

Resolve the CLI before use. Prefer `SECOND_BRAIN_CLI`; on Windows use `%LOCALAPPDATA%\CodexSecondBrain\app\bin\sbrain.cmd` when installed by this project; otherwise use `sbrain` from `PATH`. If no CLI is available, preserve the same rules with read-only filesystem search.

## Retrieve before acting

1. Resolve the project identity before searching. Run `<cli> projects --json` when the user did not name an exact project.
2. Run `<cli> search --query "..." --project "..." --time current --json`.
3. If the result says `ambiguous` or `unknown`, stop and ask the user which project they mean. Do not search several similar projects together.
4. Use only returned evidence whose relative path and line range can be reopened. Treat similarity as relevance, never as factual confidence.
5. For prices, commitments, status, account, permission, publication, deletion, or other high-impact facts, require a current authoritative source. If it is missing, answer that evidence is insufficient.
6. If current sources conflict, show both with their citations and ask for a decision. Do not silently choose one.

Use `--time history` only when the user explicitly asks how a decision changed or requests prior versions. Never let superseded or expired facts answer a current-state question.

## Answer from bounded evidence

- Use at most four primary evidence items and two same-project linked items.
- Cite vault-relative paths and line numbers in the answer.
- Reopen the Markdown source before stating a material fact; do not rely on an index snippet alone.
- If health reports `degraded`, say so. Lexical fallback is acceptable, but unsupported claims are not.
- Do not expose absolute local paths, audit contents, index files, or candidate-store files to the user.

Read [references/evidence-contract.md](references/evidence-contract.md) when interpreting result fields or reviewing a disputed answer.

## Govern durable memory

At a natural checkpoint, decide whether the conversation produced a durable preference, decision, project state, reusable workflow, important idea, or failure lesson.

1. Submit model-derived text only as a candidate:
   `<cli> candidate add --content "..." --scope "..." --json`.
2. Confirm it only after explicit user confirmation or an independent current authoritative Markdown source inside the candidate's bound project:
   `<cli> candidate confirm --id ID --user-confirmed --json` or `--source-ref PATH`.
3. Write to the intended Markdown note only after rereading its local `AGENTS.md` and the target file. Make the smallest necessary change.
4. Reopen the file, compute `<cli> source-hash --path PATH --json`, then activate with the verified hash.
5. When replacing a fact, mark the older record as superseded. Keep history; do not delete it to make the new answer appear certain.

Never save passwords, tokens, verification codes, private keys, identity numbers, or other secrets. Never describe a candidate or an unverified write as remembered.

## Agent interfaces

Prefer the JSON CLI for one-shot work. Use the local stdio MCP server for another Agent runtime. The MCP write surface exposes candidate creation only; confirmation and activation remain deliberate CLI/user-governed steps.

Read [references/agent-interface.md](references/agent-interface.md) when configuring another Agent or troubleshooting the interface.

## Safe operating boundary

- Keep indexes, models, audit traces, candidates, backups, and logs outside the vault.
- Do not start background indexing or background writes.
- Do not modify the vault during search or health checks.
- Do not add links, tags, or facts solely because a model inferred them.
- When retrieval is unavailable, use read-only filesystem search and open the source directly; preserve the same project and evidence rules.

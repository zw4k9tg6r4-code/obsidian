# Open-source research notes

Reviewed on 2026-08-15. This project adopts mechanisms, not source code, schemas, prompts, tests, or documentation from the referenced repositories.

| Project | Mechanism evaluated | Decision in this project |
|---|---|---|
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | User-owned Markdown as canonical knowledge, disposable local index, project boundaries, CLI/MCP | Adopt Markdown as truth, local derived state, JSON CLI, and a smaller read-mostly MCP surface |
| [QMD](https://github.com/tobi/qmd) | Local BM25, vector retrieval, RRF, source-oriented document search | Use the pinned BM25 primitive; implement project filtering, semantic retrieval, RRF, and evidence gates independently |
| [Obsidian Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) | Local semantic discovery of related notes and excerpts | Adopt bounded related-note expansion without installing an Obsidian community plugin |
| [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) | Project-scoped agents and local vault search | Keep project `AGENTS.md` boundaries and expose a provider-neutral Agent interface |
| [Khoj](https://github.com/khoj-ai/khoj) | Self-hosted second-brain retrieval and agent access | Adopt local-first retrieval; avoid its broader service, automation, and cloud surface for the MVP |
| [Graphiti](https://github.com/getzep/graphiti) | Temporal facts, provenance, and explicit evolution of knowledge | Adopt current/history intent, effective/recorded metadata, dispute, expiration, and supersession without a graph database |
| [LangMem](https://github.com/langchain-ai/langmem) | Long-term Agent memory management | Separate proposed memory from trusted durable knowledge |
| [Mem0](https://github.com/mem0ai/mem0) | Agent memory layer, deduplication, retrieval, and update lifecycle | Add exact candidate deduplication and a verified state machine |
| [Cognee](https://github.com/topoteretes/cognee) | Persistent Agent memory with scoped knowledge processing | Keep scope explicit and require deliberate promotion into durable Markdown |

## Deliberate non-adoptions

- No cloud sync, hosted embedding, telemetry, scheduled job, daemon, or background Vault writer.
- No automatic query expansion or LLM reranker in the first release; deterministic retrieval is easier to audit on the target hardware.
- No graph database migration. Wiki links provide bounded one-hop context while Markdown remains portable.
- No direct Agent confirmation or activation over MCP. External Agents may only create candidates.
- No copied AGPL or mixed-license implementation material. See `THIRD_PARTY_NOTICES.md` for dependency and license boundaries.


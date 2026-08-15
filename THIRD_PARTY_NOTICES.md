# Third-party notices

This repository's original code is released under the MIT License. The project also depends on third-party software whose licenses remain in force. This file is a notice, not a replacement for the complete license texts shipped by those projects.

## Direct runtime dependencies

| Component | Pinned version | License | Upstream |
|---|---:|---|---|
| `@tobilu/qmd` | 2.5.3 | MIT | https://github.com/tobi/qmd |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `yaml` | 2.9.0 | ISC | https://github.com/eemeli/yaml |
| `zod` | 4.2.1 | MIT | https://github.com/colinhacks/zod |
| `fastembed` | 0.8.0 | Apache-2.0 | https://github.com/qdrant/fastembed |
| `onnxruntime` (Windows semantic runtime) | 1.20.1 | MIT | https://github.com/microsoft/onnxruntime |

The exact JavaScript dependency graph is recorded in `package-lock.json`. The exact optional Python semantic dependency is recorded in `requirements-semantic.txt`. A release reviewer must regenerate and review a dependency-license inventory from the lock files before publication.

## Local model files

QMD, FastEmbed, and their transitive runtimes may download embedding or related model files during an explicit semantic-setup or indexing action. Model files are not part of this repository or its release archives. Each model has its own upstream terms and must be reviewed at download time; the software licenses above do not automatically grant rights to redistribute model weights.

## Architectural references

The following projects informed high-level architecture research only:

| Project | Upstream license boundary at review time | Use in this repository |
|---|---|---|
| Basic Memory | AGPL-3.0 | Concepts only; no copied material |
| Khoj | AGPL-3.0 | Concepts only; no copied material |
| Reor | AGPL-3.0 | Concepts only; no copied material |
| SurfSense | Mixed upstream licensing; review each component | Concepts only; no copied material |
| AnythingLLM | MIT | Concepts only; no copied material |
| Obsidian Smart Connections | Review upstream terms before reuse | Concepts only; no copied material |
| Obsidian Copilot | AGPL-3.0 at review time | Concepts only; no copied material |

Graphiti, LangMem, Mem0, and similar projects were also reviewed only at the mechanism level. No source code, documentation, tests, schemas, model files, or knowledge-base content from any of these projects is intended to be copied into this repository. Their licenses do not apply to independently written code merely because a general mechanism was studied.

If copied or adapted third-party material is ever introduced, the contributor must identify it in the change, retain required copyright and license notices, and update this file before release.

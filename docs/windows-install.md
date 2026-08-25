# Windows installation

Installation, semantic setup, and indexing are separate on purpose. Installation verifies the selected Vault but never changes or indexes it and never downloads a model.

For the guided path, fully extract the ZIP outside the Vault and double-click `INSTALL.cmd`. It asks for the Vault folder and one final confirmation, then composes the base installer, lexical initialization, and health check. A fresh Codex can perform the same flow by opening the extracted package and receiving the short request `安装这个`; root `AGENTS.md` contains the exact commands and safety boundaries.

The guided default is `codex` plus `lexical`. It does not download a semantic model. Agent/non-interactive usage is:

```powershell
.\scripts\install-wizard.ps1 -VaultPath 'D:\Notes\MyVault' `
  -Target codex -IndexMode lexical -NonInteractive -PlanOnly
.\scripts\install-wizard.ps1 -VaultPath 'D:\Notes\MyVault' `
  -Target codex -IndexMode lexical -NonInteractive -AcceptNetwork
```

After installation, start a new Codex task or restart Codex so its Skill inventory is refreshed.

The installer fails closed if the project allowlist, Vault path, installation root, Skill root, or any existing ancestor traverses a Windows reparse point, symbolic link, or junction. Use ordinary directories; junction-based redirection is not supported for installation targets.

Do not extract or run the package from inside the Vault. The package root, Vault, and local installation root must not contain one another.

```powershell
.\scripts\install.ps1 -VaultPath 'D:\Notes\MyVault' -Target both -AcceptNetwork
powershell -ExecutionPolicy Bypass -File .\scripts\setup-semantic.ps1 -AcceptNetwork
powershell -ExecutionPolicy Bypass -File .\scripts\initialize-index.ps1 `
  -VaultPath 'D:\Notes\MyVault' -Semantic -AcceptModelDownload
```

`-ExecutionPolicy Bypass` applies only to that process; the scripts never change machine or user execution policy.

Semantic initialization keeps the normal worker offline. When `-AcceptModelDownload` is present, a dedicated one-time downloader fetches the pinned model into the derived-data directory, creates a 512-dimensional test embedding, reloads the model with local-files-only mode, and then starts semantic indexing. Without that explicit switch, no model download is attempted.

The installer emits an `install-manifest.json` path. New manifests are bound to one install batch and include the exact backup directory/file inventory, byte lengths, and SHA-256 hashes. Rollback validates the complete manifest, rejects duplicate Skill entries and any reparse/junction traversal, and verifies every recorded backup before moving any current file. Restore the previous app, configuration, and Skill copies with:

```powershell
.\scripts\rollback.ps1 -ManifestPath 'path-from-install-output'
```

Schema-v1 manifests from earlier releases remain restorable with the same strict path and batch checks, but cannot provide the hash attestation that was not recorded at installation time. On rollback failure, the script attempts to restore the pre-rollback state and reports the preserved quarantine directory if manual recovery is needed.

Derived state is stored under `%LOCALAPPDATA%\CodexSecondBrain` by default:

- `index/`: QMD BM25 database and FastEmbed semantic database;
- `models/`: downloaded local embedding model;
- `audit/`: query hashes, selected relative paths, ranks, and decisions without snippets;
- `candidates/`: unconfirmed local candidate memories;
- `runtime/`: isolated Python environment;
- `backups/`: installer backups of Skill files.
- `app/`: installed runtime and local command wrappers.

All of it is disposable and outside the vault. Removing it does not remove a note.

# Windows installation

Installation, semantic setup, and indexing are separate on purpose. Installation verifies the selected Vault but never changes or indexes it and never downloads a model.

The installer fails closed if the project allowlist, Vault path, installation root, Skill root, or any existing ancestor traverses a Windows reparse point, symbolic link, or junction. Use ordinary directories; junction-based redirection is not supported for installation targets.

```powershell
.\scripts\install.ps1 -VaultPath 'D:\Notes\MyVault' -Target both -AcceptNetwork
powershell -ExecutionPolicy Bypass -File .\scripts\setup-semantic.ps1 -AcceptNetwork
powershell -ExecutionPolicy Bypass -File .\scripts\initialize-index.ps1 `
  -VaultPath 'D:\Notes\MyVault' -Semantic -AcceptModelDownload
```

`-ExecutionPolicy Bypass` applies only to that process; the scripts never change machine or user execution policy.

The installer emits an `install-manifest.json` path. Restore the previous app, configuration, and Skill copies with:

```powershell
.\scripts\rollback.ps1 -ManifestPath 'path-from-install-output'
```

Derived state is stored under `%LOCALAPPDATA%\CodexSecondBrain` by default:

- `index/`: QMD BM25 database and FastEmbed semantic database;
- `models/`: downloaded local embedding model;
- `audit/`: query hashes, selected relative paths, ranks, and decisions without snippets;
- `candidates/`: unconfirmed local candidate memories;
- `runtime/`: isolated Python environment;
- `backups/`: installer backups of Skill files.
- `app/`: installed runtime and local command wrappers.

All of it is disposable and outside the vault. Removing it does not remove a note.

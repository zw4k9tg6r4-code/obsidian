# Privacy boundary

This project searches a user-selected local Markdown vault. The Markdown files remain the only authoritative knowledge source. The search index, embeddings, audit events, candidate memories, downloaded models, and runtime environments are derived local state and are not part of the vault or a release package.

## Data handled locally

At runtime the application may read:

- Markdown files under the explicitly configured vault;
- project identity, state, dates, headings, and Wiki links extracted from those files;
- local keyword and semantic indexes derived from those files;
- local candidate-memory records awaiting review.

Search opens the selected Markdown source again before treating a result as evidence. It does not make an index or model output authoritative.

Derived state is stored outside the vault, under the configured data directory. On Windows the default is `%LOCALAPPDATA%\CodexSecondBrain`. That directory may contain indexes, model files, a private semantic runtime, privacy-minimized audit events, candidate records, and installation backups. It must never be committed, attached to an issue, or included in a release.

## Network behavior

Ordinary local search does not require note content to be uploaded. Network access can occur during explicit dependency installation or semantic setup, including downloading packages and model files from their upstream hosts. Installation and model initialization are separate actions. A release package contains neither a model nor a prebuilt index.

This project does not provide telemetry and does not start a background writer. It must not create a scheduled task, daemon, or unattended Vault write. If an integration exposes search through a local protocol server, the operator is responsible for keeping it local and authenticating any broader exposure.

## Audit minimization

Search audit events are limited to a query hash and length, result decision, project identifier, degraded-mode reason, relative evidence paths, line ranges, authority/state labels, ranks, and content hashes. They must not contain a raw query, evidence snippet, note body, candidate content, credential, or absolute personal path.

Candidate records can contain the proposed text and are therefore sensitive. They remain local derived data. AI-created candidates cannot confirm themselves, and confirmation does not make a fact current until an authoritative Markdown write has been separately verified.

## Public release guarantee

The release builder selects only documented source, tests, schemas, and project documentation through an explicit allowlist. The scanner rejects personal profile paths, the known private Vault name, common credentials and identifiers, Vault configuration, indexes, databases, caches, model files, candidate data, audit logs, backups, binary files, unmanifested files, and files outside the allowlist.

The public test Vault is synthetic. Real Vault notes, private evaluation output, raw benchmark questions derived from personal facts, and local audit output are forbidden in the repository. Only aggregate metrics from a private read-only evaluation may be reported.

## Deletion and incident response

Deleting derived state does not delete Markdown notes. Uninstall and rollback should preserve or quarantine derived state by default; irreversible purge must require a separate explicit option. If private data is ever committed, stop publication, rotate any affected credential, remove the material from Git history rather than only the latest tree, rebuild the release from a clean checkout, and rerun both history and archive scans.

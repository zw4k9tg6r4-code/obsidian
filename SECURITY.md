# Security and privacy

This project is designed for local Markdown vaults.

- Vault files remain the source of truth and are never copied into the repository.
- Search indexes, audit records, models, and candidate memories live outside the vault and must not be committed.
- Search is read-only. Memory promotion is a review workflow, not an unattended vault writer.
- Audit records intentionally omit evidence snippets and redact common secret patterns.
- The first semantic-index run may download the pinned local embedding model used by QMD. Document content is not sent with that download.
- Do not expose a local search endpoint beyond loopback. This package does not start an HTTP server.

Report security issues privately to the repository owner. Do not include real vault content, credentials, or customer data in an issue.


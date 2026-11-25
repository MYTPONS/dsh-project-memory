# Changelog

## 1.0.0 - 2026-11-26

- Published as a DSH-exclusive project-memory plugin.
- Added public README, package metadata, MIT license, CI, and a no-network test suite.
- Fixed `project_restore` fill mode so it no longer overwrites newer project-level documents when both stores contain content.
- Added backups when rewriting `features.md`.
- Changed git commit detection to inspect staged changes only.
- Added repository privacy scanning for secrets, real local paths, and `.dsh` memory data.

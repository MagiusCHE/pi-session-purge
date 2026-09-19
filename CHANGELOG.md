# Changelog

Release notes are maintained in English. When a release is prepared, the `Unreleased` section automatically becomes the new version section.

## [Unreleased]

## [1.0.0] - 2026-09-19

- First stable release: `/purge` rewrites the session file on disk, deleting everything appended before the last compaction while keeping the original header, the compaction checkpoint, the tail it retains and everything appended after it.
- Tolerated unreadable session lines instead of refusing to purge: they are removed with the earlier history or kept verbatim after the compaction, and are always reported in the confirmation dialog and in the final report.
- Transactional rewrite: backup next to the session file, anti-concurrency check, atomic replacement, post-write verification and automatic restore on failure.
- Confirmation dialog with the entry count and expected saving, final report with the bytes and percentage saved, and a reminder to restart pi.

## [0.1.0] - 2026-09-19

- Added the `/purge` command: it rewrites the current session file on disk, deleting everything appended before the last compaction while keeping the original session header, the compaction checkpoint, the retained tail and everything appended afterwards.
- Added explicit refusals for sessions that were never compacted, branches without a compaction, files that are not valid sessions and sessions that already start at the last compaction.
- Added a confirmation dialog that reports how many entries are removed and the expected saving, warns that abandoned branches are deleted, and asks to close other pi instances using the session.
- Added a transactional rewrite with a backup next to the session file, an atomic temp-file replacement, a post-write verification and automatic restore on failure.
- Added a final report with the bytes and percentage saved, plus a reminder to restart pi because the file was rewritten while pi had it loaded.
- Added the deterministic release tooling (prepare, commit, publish, tag, GitHub release) adapted from `pi-webview`.

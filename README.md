# @magiusche/pi-session-purge

A one-command extension for [pi](https://pi.dev), the coding agent: `/purge`
rewrites the current session file on disk, deleting everything that was appended
before the last compaction.

pi stores every session in an append-only JSONL file. Compaction adds a summary
entry, but the physical history before it is never removed, so long sessions
leave files of tens or hundreds of megabytes even though the model only receives
the summary plus the retained tail. `/purge` closes that gap: it restructures the
file so that it starts at the last compaction, without changing the context pi
rebuilds from it.

## Install

```bash
pi install npm:@magiusche/pi-session-purge
```

Update later with `pi update --extensions`, remove with
`pi remove npm:@magiusche/pi-session-purge`.

## Usage

Inside a session that has been compacted at least once:

```
/purge
```

The command takes no arguments. It refuses to do anything when the session has
never been compacted, when the current branch carries no compaction, or when the
file already starts at the last compaction.

Before touching anything it asks for confirmation and shows the file name, how
many entries will be removed, the expected size and percentage, what is deleted
and what is kept.

## What survives the purge

| Kept                                                                                                                                                                      | Removed                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| The original session header, byte for byte                                                                                                                                | Messages, tool results and reasoning before the last compaction |
| The `compaction` entry verbatim (summary, details, usage, `retainedTail`)                                                                                                 | Abandoned branches created before the compaction                |
| The retained tail that pi rebuilds from `firstKeptEntryId`                                                                                                                | Labels pointing at removed entries                              |
| Everything appended after the compaction, branches included                                                                                                               |                                                                 |
| The last `thinking_level_change`, `model_change`, `session_info` and the last `custom` entry per type, so model, thinking level, session name and extension state survive |                                                                 |

The result is a consistent session: the header stays first, the entry point of
the compaction stays reachable from the leaf, and no entry points at a removed
parent (an entry whose parent was dropped simply becomes a root, which pi already
supports).

### Unreadable lines

Session files can contain corrupt lines (interrupted writes, NUL bytes,
truncated JSON) that pi itself skips when loading a session. `/purge` does not
refuse because of them: unreadable lines before the compaction are removed with
the history, the ones after it are kept byte for byte, and their count is
reported both in the confirmation dialog and in the final report.

## Safety

`/purge` runs only while the agent is idle and refuses to run when the agent is
streaming, because a concurrent append would invalidate the rewrite. The
transaction is:

1. a backup is copied next to the session file (`<session>.jsonl.purge-backup`);
2. the file is checked again for concurrent changes;
3. the purged content is written to a temp file, flushed, and renamed over the
   session file (pi appends by path, so no file descriptor is left behind);
4. the result is re-read and verified: header unchanged, every line valid JSON,
   no lost or duplicated entry, no dangling parent;
5. only then the backup is deleted. Any failure restores the backup and reports
   what happened.

## After the purge

**Restart pi** (and close every other pi instance that had that session open).
The file was rewritten while pi had it loaded: the running process still holds
the previous entries in memory, and operations that regenerate the file from
memory (for example `/clone`) would bring the removed history back into a new
session file.

## Development

The project is intentionally small: no runtime dependencies, no bundler (pi loads
the TypeScript sources directly), one command to implement.

```bash
pnpm install              # pnpm only, enforced by a preinstall guard
pnpm test                 # node --test, native TypeScript
pnpm test:watch
pnpm typecheck            # tsc --noEmit
pnpm format               # prettier
pnpm release -- --version 0.1.1   # prepare: bump + notes + checks + hashed tarball
pnpm release -- --publish         # publish the committed release, then tag it
```

- `index.ts` — the pi extension: registers `/purge`, drives the confirmation
  dialog, the transaction and the notifications.
- `src/purge.ts` — pure planning and serialization of the purged session.
- `src/session-file.ts` — snapshot, backup, atomic write, verification.
- `tests/` — unit tests, including a reference implementation of pi's
  `buildContextEntries` used to prove that the rebuilt context does not change.
- `docs/plans/0001-purge-comando-sessione.md` — design notes and decisions.

## License

MIT © Magius(CHE)

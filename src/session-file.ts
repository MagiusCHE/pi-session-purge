// File I/O for /purge: snapshot, backup, atomic rewrite and post-write verification.
//
// The rewrite happens in place (temp file + rename) because pi appends to the
// session file by path with `appendFileSync`, so replacing the inode is safe.

import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

export interface SessionFileSnapshot {
  path: string;
  text: string;
  /** Size in bytes, used for the anti-concurrency check and the savings report. */
  size: number;
  mtimeMs: number;
  /** Permission bits of the original file. */
  mode: number;
}

export interface PurgeVerification {
  /** Header line that must stay byte-identical. */
  headerRaw: string;
  /** Every entry id the purge promised to keep. */
  keptIds: readonly string[];
  /** Ids that must stay resolvable for pi to rebuild the context. */
  requiredIds: readonly string[];
  /** Expected number of lines, header included: catches truncation or extras. */
  lineCount: number;
}

const TMP_SUFFIX = ".purge-tmp";
const BACKUP_SUFFIX = ".purge-backup";

export const backupPathFor = (path: string): string => `${path}${BACKUP_SUFFIX}`;

export function readSessionFile(path: string): SessionFileSnapshot {
  const stats = statSync(path);
  return {
    path,
    text: readFileSync(path, "utf8"),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode & 0o777,
  };
}

/** Refuse to continue when the file changed after the snapshot (concurrent append). */
export function assertUnchanged(snapshot: SessionFileSnapshot): void {
  const stats = statSync(snapshot.path);
  if (stats.size !== snapshot.size || stats.mtimeMs !== snapshot.mtimeMs) {
    throw new Error("the session file changed while /purge was running");
  }
}

/** Copy the session file next to itself and return the backup path. */
export function createBackup(path: string): string {
  const backup = backupPathFor(path);
  rmSync(backup, { force: true });
  copyFileSync(path, backup);
  return backup;
}

/** Put the backup content back in place and drop the backup file. */
export function restoreBackup(backup: string, path: string): void {
  copyFileSync(backup, path);
  rmSync(backup, { force: true });
}

export function removeBackup(backup: string): void {
  rmSync(backup, { force: true });
}

/** Write the purged content through a temp file, then rename it over the original. */
export function writeSessionFileAtomically(
  path: string,
  content: string,
  mode: number,
): void {
  const temp = `${path}${TMP_SUFFIX}`;
  rmSync(temp, { force: true });
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    chmodSync(path, mode);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Re-read the purged file and fail when it is not a valid session: wrong line
 * count, changed header, lost or duplicated entry, dangling parent. Lines that
 * are not entries (corrupt lines pi skips) are tolerated and left untouched.
 */
export function verifyPurgedFile(path: string, expected: PurgeVerification): void {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines[0] !== expected.headerRaw) {
    throw new Error("the purged file does not keep the original session header");
  }
  if (lines.length !== expected.lineCount) {
    throw new Error(
      `the purged file has ${lines.length} lines instead of the expected ${expected.lineCount}`,
    );
  }

  const entries: { id: string; parentId: string | null }[] = [];
  for (const line of lines.slice(1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Unreadable line kept verbatim: pi skips it on load as well.
      continue;
    }
    const record = parsed as { id?: unknown; parentId?: unknown };
    if (typeof record?.id !== "string") continue;
    entries.push({
      id: record.id,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
    });
  }

  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length) {
    throw new Error("the purged file contains duplicated entry ids");
  }
  const missing = [...expected.keptIds, ...expected.requiredIds].filter(
    (id) => !ids.has(id),
  );
  if (missing.length > 0) {
    throw new Error(`the purged file lost ${missing.length} expected entries`);
  }
  const dangling = entries.filter(
    (entry) => entry.parentId !== null && !ids.has(entry.parentId),
  );
  if (dangling.length > 0) {
    throw new Error(
      `the purged file has ${dangling.length} entries with a missing parent`,
    );
  }
}

// Pure planning and serialization for the /purge command.
//
// /purge rewrites a session JSONL file so that everything appended before the
// last compaction disappears, while the context pi rebuilds from that file stays
// the same. Only the header, the pre-compaction entries pi needs to reconstruct
// the retained tail, the small state entries (model, thinking level, session
// name, extension state) and everything appended after the compaction survive.
//
// This module performs no I/O, so the whole planning step stays unit-testable.

export type JsonRecord = Record<string, unknown>;

export interface SessionEntry extends JsonRecord {
  type: string;
  id: string;
  parentId: string | null;
}

export interface ParsedLine {
  /** 0-based position in the file. */
  lineIndex: number;
  /** The line, verbatim, without its trailing carriage return. */
  raw: string;
}

export interface SessionRecord extends ParsedLine {
  /** Parsed entry, normalized so `parentId` is always present. */
  entry: SessionEntry;
}

export interface ParsedSession {
  /** Verbatim header line (`{"type":"session",...}`), or null when absent. */
  headerRaw: string | null;
  /** Non-header entries in file order. */
  records: SessionRecord[];
  /**
   * Non-empty lines that are not usable entries: corrupt or truncated lines,
   * objects without an id and extra header lines. pi skips them when loading a
   * session, so they carry no recoverable context.
   */
  junk: ParsedLine[];
}

export type PurgeRefusal =
  | "not-a-session"
  | "no-active-path"
  | "no-compaction"
  | "no-compaction-on-branch"
  | "nothing-to-remove";

export interface PurgePlan {
  /** Verbatim header line, kept as the first line of the purged file. */
  headerRaw: string;
  /** Purged file lines (header first), without trailing newline. */
  lines: string[];
  /** Id of the compaction entry the purge starts from. */
  compactionId: string;
  /** `firstKeptEntryId`, when it must stay resolvable after the purge. */
  requiredIds: string[];
  /** Every id kept by the purge. */
  keptIds: string[];
  removedRecords: number;
  keptRecords: number;
  /** Unreadable lines dropped with the history before the compaction. */
  junkRemoved: number;
  /** Unreadable lines kept verbatim because they follow the compaction. */
  junkKept: number;
  totalBytes: number;
  keptBytes: number;
  removedBytes: number;
  /** Ids of the pre-compaction state entries carried over. */
  carriedIds: string[];
  /** Non-fatal findings the command reports to the user. */
  warnings: string[];
}

export type PurgePlanResult =
  { ok: true; plan: PurgePlan } | { ok: false; reason: PurgeRefusal };

const COMPACTION_TYPE = "compaction";

/** Entry types carried over from before the compaction (tiny state, not history). */
const CARRIED_STATE_TYPES = new Set([
  "thinking_level_change",
  "model_change",
  "session_info",
]);

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const isEntry = (value: unknown): value is SessionEntry => {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record.type === "string" &&
    typeof record.id === "string" &&
    (record.parentId === undefined ||
      record.parentId === null ||
      typeof record.parentId === "string")
  );
};

/** Parse a session JSONL file into its header line, entries and junk lines. */
export function parseSessionJsonl(text: string): ParsedSession {
  let headerRaw: string | null = null;
  const records: SessionRecord[] = [];
  const junk: ParsedLine[] = [];

  text.split("\n").forEach((line, lineIndex) => {
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (raw.trim() === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      junk.push({ lineIndex, raw });
      return;
    }

    const record = asRecord(parsed);
    if (record?.type === "session") {
      // The first header wins; a second one is not a usable entry.
      if (headerRaw === null) headerRaw = raw;
      else junk.push({ lineIndex, raw });
      return;
    }

    if (!isEntry(parsed)) {
      junk.push({ lineIndex, raw });
      return;
    }
    records.push({
      lineIndex,
      raw,
      entry: { ...parsed, parentId: parsed.parentId ?? null },
    });
  });

  return { headerRaw, records, junk };
}

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Entry id used as the carry-over key for pre-compaction state. */
const stateKey = (entry: SessionEntry): string | null => {
  if (CARRIED_STATE_TYPES.has(entry.type)) return entry.type;
  if (entry.type === "custom") {
    return `custom:${typeof entry.customType === "string" ? entry.customType : ""}`;
  }
  return null;
};

const stringField = (entry: SessionEntry, field: string): string | null =>
  typeof entry[field] === "string" ? (entry[field] as string) : null;

/**
 * Walk from the leaf to the root through `parentId`, mirroring pi's
 * `buildSessionPath`. Returns entries in file order (root first).
 */
export function activePath(
  records: readonly SessionRecord[],
  leafId: string,
): SessionRecord[] {
  const byId = new Map(records.map((record) => [record.entry.id, record]));
  const leaf = byId.get(leafId) ?? records[records.length - 1];
  if (!leaf) return [];

  const path: SessionRecord[] = [];
  const seen = new Set<string>();
  let current: SessionRecord | undefined = leaf;
  while (current && !seen.has(current.entry.id)) {
    seen.add(current.entry.id);
    path.push(current);
    const parentId: string | null = current.entry.parentId;
    current = parentId === null ? undefined : byId.get(parentId);
  }
  return path.reverse();
}

/**
 * Plan the purged session file. `leafId` is the session's current position
 * (`ctx.sessionManager.getLeafId()`); a null leaf means "no active position".
 */
export function planPurge(text: string, leafId: string | null): PurgePlanResult {
  const parsed = parseSessionJsonl(text);
  if (parsed.headerRaw === null) return { ok: false, reason: "not-a-session" };
  if (leafId === null || parsed.records.length === 0) {
    return { ok: false, reason: "no-active-path" };
  }

  const path = activePath(parsed.records, leafId);
  if (path.length === 0) return { ok: false, reason: "no-active-path" };

  let compactionIndex = -1;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index]?.entry.type === COMPACTION_TYPE) {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) {
    const compacted = parsed.records.some(
      (record) => record.entry.type === COMPACTION_TYPE,
    );
    return { ok: false, reason: compacted ? "no-compaction-on-branch" : "no-compaction" };
  }

  const compactionRecord = path[compactionIndex] as SessionRecord;
  const beforeCompaction = path.slice(0, compactionIndex);
  const warnings: string[] = [];
  const kept = new Map<string, SessionRecord>();

  // 1) Everything appended after the compaction stays, abandoned branches included.
  for (const record of parsed.records) {
    if (record.lineIndex > compactionRecord.lineIndex) kept.set(record.entry.id, record);
  }

  // 2) A compaction rebuilds its retained tail from `firstKeptEntryId`, which
  //    points at entries preceding the compaction: those must survive. Newer pi
  //    versions may embed the tail in `retainedTail` and ignore the id, but
  //    keeping the range stays correct for every version and never widens or
  //    narrows the rebuilt context.
  const requiredIds = [compactionRecord.entry.id];
  const retainedRange: SessionRecord[] = [];
  const firstKeptEntryId = stringField(compactionRecord.entry, "firstKeptEntryId");
  const retainedStart =
    firstKeptEntryId === null
      ? -1
      : beforeCompaction.findIndex((record) => record.entry.id === firstKeptEntryId);
  if (retainedStart < 0) {
    warnings.push("missing-kept-range");
  } else {
    requiredIds.push(firstKeptEntryId as string);
    retainedRange.push(...beforeCompaction.slice(retainedStart));
    for (const record of retainedRange) kept.set(record.entry.id, record);
  }

  // 3) State entries: the last one per key, so model, thinking level, session
  //    name and extension state survive the purge.
  const carried: SessionRecord[] = [];
  const seenState = new Set<string>();
  for (let index = beforeCompaction.length - 1; index >= 0; index -= 1) {
    const record = beforeCompaction[index] as SessionRecord;
    const key = stateKey(record.entry);
    if (key === null || seenState.has(key) || kept.has(record.entry.id)) continue;
    seenState.add(key);
    carried.push(record);
  }
  carried.reverse();
  for (const record of carried) kept.set(record.entry.id, record);

  // 4) The compaction checkpoint itself. Labels and other pre-compaction
  //    metadata reach the purged file only through the retained range.
  kept.set(compactionRecord.entry.id, compactionRecord);

  const keptRecords = [...kept.values()].sort(
    (left, right) => left.lineIndex - right.lineIndex,
  );
  // Unreadable lines cannot be interpreted, so they are never rewritten: the
  // ones that precede the compaction go away with the history, the ones that
  // follow it are kept verbatim.
  const junkKept = parsed.junk.filter(
    (line) => line.lineIndex > compactionRecord.lineIndex,
  );
  const junkRemoved = parsed.junk.length - junkKept.length;
  const removedRecords = parsed.records.length - keptRecords.length;
  if (removedRecords + junkRemoved <= 0)
    return { ok: false, reason: "nothing-to-remove" };

  // The spine (state entries, retained range, compaction) is rechained in file
  // order so the compaction stays reachable from the leaf. Everything else keeps
  // its parent and only becomes a root when its parent was removed.
  const spineIds = new Set(
    [...carried, ...retainedRange, compactionRecord].map((record) => record.entry.id),
  );
  const keptIds = new Set(keptRecords.map((record) => record.entry.id));
  const output: ParsedLine[] = [];
  let previousSpineId: string | null = null;
  for (const record of keptRecords) {
    const { entry } = record;
    let parentId: string | null;
    if (spineIds.has(entry.id)) {
      parentId = previousSpineId;
      previousSpineId = entry.id;
    } else {
      parentId =
        entry.parentId !== null && keptIds.has(entry.parentId) ? entry.parentId : null;
    }
    output.push({
      lineIndex: record.lineIndex,
      raw:
        parentId === entry.parentId ? record.raw : JSON.stringify({ ...entry, parentId }),
    });
  }
  output.push(...junkKept);
  output.sort((left, right) => left.lineIndex - right.lineIndex);
  const lines = [parsed.headerRaw, ...output.map((line) => line.raw)];

  const totalBytes =
    byteLength(parsed.headerRaw) +
    1 +
    sumBytes(parsed.records) +
    parsed.junk.reduce((total, line) => total + byteLength(line.raw) + 1, 0);
  const keptBytes = lines.reduce((total, line) => total + byteLength(line) + 1, 0);
  return {
    ok: true,
    plan: {
      headerRaw: parsed.headerRaw,
      lines,
      compactionId: compactionRecord.entry.id,
      requiredIds,
      keptIds: keptRecords.map((record) => record.entry.id),
      removedRecords,
      keptRecords: keptRecords.length,
      junkRemoved,
      junkKept: junkKept.length,
      totalBytes,
      keptBytes,
      removedBytes: Math.max(0, totalBytes - keptBytes),
      carriedIds: carried.map((record) => record.entry.id),
      warnings,
    },
  };
}

const sumBytes = (records: readonly SessionRecord[]): number =>
  records.reduce((total, record) => total + byteLength(record.raw) + 1, 0);

/** Render the purged lines as file content (trailing newline included). */
export const renderSessionFile = (lines: readonly string[]): string =>
  `${lines.join("\n")}\n`;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Share of the original file removed by the purge, clamped to 0..100. */
export function savingsPercent(originalBytes: number, purgedBytes: number): number {
  if (!Number.isFinite(originalBytes) || originalBytes <= 0) return 0;
  const percent = ((originalBytes - purgedBytes) / originalBytes) * 100;
  return Math.max(0, Math.min(100, percent));
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatBytes,
  parseSessionJsonl,
  planPurge,
  renderSessionFile,
  savingsPercent,
  type SessionEntry,
} from "../src/purge.ts";

const HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
});

const entryLine = (
  type: string,
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({ type, id, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...extra });

const messageLine = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
): string =>
  entryLine("message", id, parentId, {
    message: {
      role,
      content: `${role} ${id}`,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      timestamp: 1,
    },
  });

const sessionFile = (...lines: string[]): string => `${HEADER}\n${lines.join("\n")}\n`;

const compactionLine = (
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
): string =>
  entryLine("compaction", id, parentId, {
    summary: "summarized",
    firstKeptEntryId: parentId,
    tokensBefore: 1234,
    ...extra,
  });

const planOf = (text: string, leafId: string | null) => {
  const result = planPurge(text, leafId);
  assert.equal(result.ok, true, `expected a plan, got ${result.ok ? "" : result.reason}`);
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
};

const refusalOf = (text: string, leafId: string | null) => {
  const result = planPurge(text, leafId);
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) throw new Error("unreachable");
  return result.reason;
};

const idsOfLines = (lines: readonly string[]): string[] =>
  lines
    .slice(1)
    .map((line) => {
      // Unreadable lines are kept verbatim and carry no id.
      try {
        return (JSON.parse(line) as { id?: unknown }).id;
      } catch {
        return undefined;
      }
    })
    .filter((id): id is string => typeof id === "string");

const parentsOfLines = (lines: readonly string[]): [string, string | null][] =>
  lines.slice(1).map((line) => {
    const parsed = JSON.parse(line) as { id: string; parentId: string | null };
    return [parsed.id, parsed.parentId];
  });

/**
 * Reference implementation of pi's `buildSessionPath` + `buildContextEntries`
 * (packages/coding-agent/src/core/session-manager.ts, pi 0.85.1). The tests use
 * it to prove that /purge leaves the context pi rebuilds from the file intact.
 */
const piContextIds = (text: string, leafId: string | null): string[] => {
  const { records } = parseSessionJsonl(text);
  const byId = new Map(records.map((record) => [record.entry.id, record.entry]));
  const leaf = leafId === null ? undefined : (byId.get(leafId) ?? records.at(-1)?.entry);
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  path.reverse();

  let compactionIndex = -1;
  for (let index = 0; index < path.length; index += 1) {
    if (path[index]?.type === "compaction") compactionIndex = index;
  }
  if (compactionIndex < 0) return path.map((entry) => entry.id);

  const compaction = path[compactionIndex] as SessionEntry;
  const context: string[] = [compaction.id];
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = path[index] as SessionEntry;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) context.push(entry.id);
  }
  for (const entry of path.slice(compactionIndex + 1)) context.push(entry.id);
  return context;
};

/** Reference implementation of pi's `getSessionContextSettings`. */
const piSettings = (text: string, leafId: string | null) => {
  const { records } = parseSessionJsonl(text);
  const byId = new Map(records.map((record) => [record.entry.id, record.entry]));
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leafId === null ? undefined : byId.get(leafId);
  while (current) {
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  path.reverse();

  let thinkingLevel = "off";
  let model: string | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change")
      thinkingLevel = String(entry.thinkingLevel);
    else if (entry.type === "model_change") model = `${entry.provider}/${entry.modelId}`;
    else if (entry.type === "message") {
      const message = entry.message as {
        role?: string;
        provider?: string;
        model?: string;
      };
      if (message?.role === "assistant") model = `${message.provider}/${message.model}`;
    }
  }
  return { thinkingLevel, model };
};

const contextIsPreserved = (text: string, purged: string, leafId: string): void => {
  assert.deepEqual(piContextIds(purged, leafId), piContextIds(text, leafId));
  assert.deepEqual(piSettings(purged, leafId), piSettings(text, leafId));
};

test("parseSessionJsonl keeps the header verbatim and skips empty lines", () => {
  const parsed = parseSessionJsonl(`\n${HEADER}\n\n${messageLine("u1", null, "user")}\n`);
  assert.equal(parsed.headerRaw, HEADER);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.junk, []);
});

test("parseSessionJsonl collects corrupt, id-less and duplicated header lines as junk", () => {
  const parsed = parseSessionJsonl(`${HEADER}\nnot json\n${HEADER}\n{"type":"label"}\n`);
  assert.deepEqual(
    parsed.junk.map((line) => line.lineIndex),
    [1, 2, 3],
  );
  assert.equal(parsed.records.length, 0);
});

test("a corrupt line before the compaction is removed with the history", () => {
  const corrupt = `${"\u0000".repeat(32)}{\"type\":\"message\",\"id\":\"m2\"}`;
  const text = `${HEADER}\n${messageLine("m1", null, "user")}\n${corrupt}\n${messageLine(
    "m3",
    "m1",
    "assistant",
  )}\n${compactionLine("cmp", "m3", { firstKeptEntryId: "m3" })}\n${messageLine(
    "m4",
    "cmp",
    "user",
  )}\n`;

  const plan = planOf(text, "m4");
  assert.deepEqual(idsOfLines(plan.lines), ["m3", "cmp", "m4"]);
  assert.equal(plan.junkRemoved, 1);
  assert.equal(plan.junkKept, 0);
  assert.equal(plan.removedRecords, 1);
});

test("a corrupt line after the compaction is kept verbatim", () => {
  const corrupt = `${JSON.stringify({ type: "message", id: "x1" })}\u0000\u0000`;
  const text = `${HEADER}\n${messageLine("m1", null, "user")}\n${messageLine(
    "m2",
    "m1",
    "assistant",
  )}\n${compactionLine("cmp", "m2", { firstKeptEntryId: "m2" })}\n${corrupt}\n${messageLine(
    "m3",
    "cmp",
    "user",
  )}\n`;

  const plan = planOf(text, "m3");
  assert.deepEqual(idsOfLines(plan.lines), ["m2", "cmp", "m3"]);
  assert.equal(plan.lines.includes(corrupt), true);
  assert.equal(plan.junkRemoved, 0);
  assert.equal(plan.junkKept, 1);
  assert.equal(plan.removedRecords, 1);
  assert.equal(plan.totalBytes, Buffer.byteLength(text, "utf8"));
  assert.equal(plan.keptBytes, Buffer.byteLength(renderSessionFile(plan.lines), "utf8"));
});

test("refuses a file that is not a session", () => {
  assert.equal(refusalOf(`${JSON.stringify({ nope: true })}\n`, null), "not-a-session");
});

test("refuses a session that never compacted", () => {
  const text = sessionFile(
    messageLine("u1", null, "user"),
    messageLine("a1", "u1", "assistant"),
    messageLine("u2", "a1", "user"),
  );
  assert.equal(refusalOf(text, "u2"), "no-compaction");
});

test("refuses a session whose current branch carries no compaction", () => {
  const text = sessionFile(
    messageLine("u1", null, "user"),
    messageLine("a1", "u1", "assistant"),
    compactionLine("cmp", "a1"),
    messageLine("u2", "a1", "user"),
  );
  assert.equal(refusalOf(text, "u2"), "no-compaction-on-branch");
});

test("refuses without an active position or when nothing can be removed", () => {
  const text = sessionFile(messageLine("u1", null, "user"), compactionLine("cmp", "u1"));
  assert.equal(refusalOf(text, null), "no-active-path");
  assert.equal(refusalOf(text, "cmp"), "nothing-to-remove");
});

test("old-format compaction keeps header, retained tail and carried state", () => {
  const text = sessionFile(
    messageLine("u1", null, "user"),
    messageLine("a1", "u1", "assistant"),
    entryLine("thinking_level_change", "tl", "a1", { thinkingLevel: "high" }),
    entryLine("model_change", "mc", "tl", { provider: "openai", modelId: "gpt-5" }),
    messageLine("u2", "mc", "user"),
    messageLine("a2", "u2", "assistant"),
    compactionLine("cmp", "a2", { firstKeptEntryId: "u2" }),
    messageLine("u3", "cmp", "user"),
    messageLine("a3", "u3", "assistant"),
  );

  const plan = planOf(text, "a3");
  assert.deepEqual(idsOfLines(plan.lines), ["tl", "mc", "u2", "a2", "cmp", "u3", "a3"]);
  assert.equal(plan.lines[0], HEADER);
  assert.equal(plan.removedRecords, 2);
  assert.equal(plan.keptRecords, 7);
  assert.deepEqual(plan.carriedIds, ["tl", "mc"]);
  assert.deepEqual(plan.requiredIds, ["cmp", "u2"]);
  assert.deepEqual(plan.warnings, []);

  // The carried state is rechained in front of the compaction, so pi still
  // resolves model, thinking level and the leaf path.
  assert.deepEqual(parentsOfLines(plan.lines), [
    ["tl", null],
    ["mc", "tl"],
    ["u2", "mc"],
    ["a2", "u2"],
    ["cmp", "a2"],
    ["u3", "cmp"],
    ["a3", "u3"],
  ]);

  const purged = renderSessionFile(plan.lines);
  contextIsPreserved(text, purged, "a3");
  assert.deepEqual(piSettings(purged, "a3"), {
    thinkingLevel: "high",
    model: "anthropic/claude-sonnet-4-5",
  });
  assert.equal(plan.removedBytes, plan.totalBytes - plan.keptBytes);
});

test("kept entries are written verbatim when their parent is kept", () => {
  const custom = entryLine("custom", "c1", "u0", { customType: "agent-router" });
  const compaction = compactionLine("cmp", "c1", { firstKeptEntryId: "c1" });
  const after = messageLine("u1", "cmp", "user");
  const text = sessionFile(messageLine("u0", null, "user"), custom, compaction, after);

  const plan = planOf(text, "u1");
  assert.deepEqual(idsOfLines(plan.lines), ["c1", "cmp", "u1"]);
  // c1 was rechained to the root, so only the entries after it stay verbatim.
  assert.equal(plan.lines[2], compaction);
  assert.equal(plan.lines[3], after);
});

test("a compaction with an embedded retained tail keeps the tail pi rebuilds", () => {
  const retainedTail = [{ role: "user", content: "latest request" }];
  const text = sessionFile(
    messageLine("u1", null, "user"),
    messageLine("a1", "u1", "assistant"),
    compactionLine("cmp", "a1", { firstKeptEntryId: "a1", retainedTail }),
    messageLine("u2", "cmp", "user"),
    messageLine("a2", "u2", "assistant"),
  );

  const plan = planOf(text, "a2");
  assert.deepEqual(idsOfLines(plan.lines), ["a1", "cmp", "u2", "a2"]);
  assert.equal(plan.removedRecords, 1);
  assert.equal(plan.keptRecords, 4);
  assert.deepEqual(plan.carriedIds, []);
  assert.deepEqual(plan.requiredIds, ["cmp", "a1"]);

  const purged = renderSessionFile(plan.lines);
  const keptCompaction = JSON.parse(plan.lines[2] as string) as Record<string, unknown>;
  assert.deepEqual(keptCompaction.retainedTail, retainedTail);
  assert.equal(keptCompaction.parentId, "a1");
  contextIsPreserved(text, purged, "a2");
  assert.deepEqual(piContextIds(purged, "a2"), ["cmp", "a1", "u2", "a2"]);
});

test("branches appended after the compaction survive", () => {
  const text = sessionFile(
    messageLine("u1", null, "user"),
    messageLine("a1", "u1", "assistant"),
    compactionLine("cmp", "a1", { firstKeptEntryId: "a1" }),
    messageLine("u2", "cmp", "user"),
    messageLine("a2", "u2", "assistant"),
    messageLine("b1", "cmp", "user"),
    messageLine("b2", "b1", "assistant"),
  );

  const purged = renderSessionFile(planOf(text, "a2").lines);
  assert.deepEqual(idsOfLines(planOf(text, "a2").lines), [
    "a1",
    "cmp",
    "u2",
    "a2",
    "b1",
    "b2",
  ]);
  assert.equal(planOf(text, "a2").removedRecords, 1);
  assert.deepEqual(piContextIds(purged, "a2"), ["cmp", "a1", "u2", "a2"]);
  assert.deepEqual(piContextIds(purged, "b2"), ["cmp", "a1", "b1", "b2"]);
  contextIsPreserved(text, purged, "a2");
});

test("an entry whose parent was removed becomes a root instead of dangling", () => {
  const text = sessionFile(
    messageLine("u1", null, "user"),
    messageLine("a1", "u1", "assistant"),
    compactionLine("cmp", "a1", { firstKeptEntryId: "a1" }),
    messageLine("u2", "cmp", "user"),
    // A branch forked back before the compaction: its parent will be removed.
    messageLine("x1", "u1", "user"),
  );

  const plan = planOf(text, "u2");
  assert.deepEqual(idsOfLines(plan.lines), ["a1", "cmp", "u2", "x1"]);
  assert.deepEqual(parentsOfLines(plan.lines), [
    ["a1", null],
    ["cmp", "a1"],
    ["u2", "cmp"],
    ["x1", null],
  ]);
});

test("a missing firstKeptEntryId is reported as a warning", () => {
  const text = sessionFile(
    messageLine("u1", null, "user"),
    compactionLine("cmp", "u1", { firstKeptEntryId: "gone" }),
    messageLine("u2", "cmp", "user"),
  );
  const plan = planOf(text, "u2");
  assert.deepEqual(plan.warnings, ["missing-kept-range"]);
  assert.deepEqual(idsOfLines(plan.lines), ["cmp", "u2"]);
});

test("labels inside the retained range and custom state survive", () => {
  const text = sessionFile(
    messageLine("u0", null, "user"),
    entryLine("custom", "c1", "u0", { customType: "agent-router", data: { agent: "a" } }),
    messageLine("u1", "c1", "user"),
    entryLine("label", "l1", "u1", { targetId: "u1", label: "checkpoint" }),
    entryLine("session_info", "si", "l1", { name: "Purge work" }),
    compactionLine("cmp", "si", { firstKeptEntryId: "u1" }),
    messageLine("u2", "cmp", "user"),
  );

  const plan = planOf(text, "u2");
  assert.deepEqual(idsOfLines(plan.lines), ["c1", "u1", "l1", "si", "cmp", "u2"]);
  assert.deepEqual(plan.carriedIds, ["c1"]);
  assert.equal(plan.removedRecords, 1);
  contextIsPreserved(text, renderSessionFile(plan.lines), "u2");
});

test("reports the byte budget of the rewrite", () => {
  const text = sessionFile(
    messageLine("u1", null, "user"),
    messageLine("a1", "u1", "assistant"),
    compactionLine("cmp", "a1", { retainedTail: [{ role: "user", content: "tail" }] }),
    messageLine("u2", "cmp", "user"),
  );

  const plan = planOf(text, "u2");
  assert.equal(plan.totalBytes, Buffer.byteLength(text, "utf8"));
  assert.equal(plan.keptBytes, Buffer.byteLength(renderSessionFile(plan.lines), "utf8"));
  assert.ok(plan.removedBytes > 0);
  assert.ok(savingsPercent(plan.totalBytes, plan.keptBytes) > 0);
});

test("formatBytes and savingsPercent", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1024 * 1024 * 3.5), "3.5 MB");
  assert.equal(savingsPercent(1000, 250), 75);
  assert.equal(savingsPercent(0, 0), 0);
  assert.equal(savingsPercent(100, 200), 0);
});

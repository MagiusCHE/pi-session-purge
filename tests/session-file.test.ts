import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertUnchanged,
  backupPathFor,
  createBackup,
  readSessionFile,
  removeBackup,
  restoreBackup,
  verifyPurgedFile,
  writeSessionFileAtomically,
} from "../src/session-file.ts";

const HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
});

const entry = (id: string, parentId: string | null): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
  });

const withSessionFile = (content: string, run: (path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-purge-test-"));
  try {
    const path = join(dir, "2026-01-01_session-1.jsonl");
    writeFileSync(path, content, { mode: 0o600 });
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const validContent = `${HEADER}\n${entry("e1", null)}\n${entry("e2", "e1")}\n`;
const validExpectation = {
  headerRaw: HEADER,
  keptIds: ["e1", "e2"],
  requiredIds: ["e1"],
  lineCount: 3,
};

test("readSessionFile snapshots text, size, mode and mtime", () => {
  withSessionFile(validContent, (path) => {
    const snapshot = readSessionFile(path);
    assert.equal(snapshot.text, validContent);
    assert.equal(snapshot.size, Buffer.byteLength(validContent, "utf8"));
    assert.equal(snapshot.mode, 0o600);
    assert.equal(snapshot.mtimeMs, statSync(path).mtimeMs);
  });
});

test("backup, restore and remove", () => {
  withSessionFile(validContent, (path) => {
    const backup = createBackup(path);
    assert.equal(backup, backupPathFor(path));
    assert.equal(readFileSync(backup, "utf8"), validContent);

    writeFileSync(path, "broken\n");
    restoreBackup(backup, path);
    assert.equal(readFileSync(path, "utf8"), validContent);
    assert.throws(() => statSync(backup));

    const second = createBackup(path);
    removeBackup(second);
    assert.throws(() => statSync(second));
  });
});

test("writes atomically and preserves the file mode", () => {
  withSessionFile(validContent, (path) => {
    writeSessionFileAtomically(path, `${HEADER}\n${entry("e1", null)}\n`, 0o600);
    assert.equal(readFileSync(path, "utf8"), `${HEADER}\n${entry("e1", null)}\n`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => statSync(`${path}.purge-tmp`));
  });
});

test("assertUnchanged refuses a file modified after the snapshot", () => {
  withSessionFile(validContent, (path) => {
    const snapshot = readSessionFile(path);
    assert.doesNotThrow(() => assertUnchanged(snapshot));

    writeFileSync(path, `${validContent}${entry("e3", "e2")}\n`);
    assert.throws(() => assertUnchanged(snapshot), /changed while \/purge was running/);
  });
});

test("verifyPurgedFile accepts a consistent file", () => {
  withSessionFile(validContent, (path) => {
    assert.doesNotThrow(() => verifyPurgedFile(path, validExpectation));
  });
});

test("verifyPurgedFile tolerates unreadable lines kept verbatim", () => {
  const corrupt = `${JSON.stringify({ type: "message", id: "x1" })}\u0000\u0000`;
  withSessionFile(
    `${HEADER}\n${entry("e1", null)}\n${corrupt}\n${entry("e2", "e1")}\n`,
    (path) => {
      assert.doesNotThrow(() =>
        verifyPurgedFile(path, { ...validExpectation, lineCount: 4 }),
      );
    },
  );
});

test("verifyPurgedFile rejects a wrong line count", () => {
  withSessionFile(validContent, (path) => {
    assert.throws(
      () => verifyPurgedFile(path, { ...validExpectation, lineCount: 2 }),
      /3 lines instead of the expected 2/,
    );
    assert.throws(
      () => verifyPurgedFile(path, { ...validExpectation, lineCount: 9 }),
      /3 lines instead of the expected 9/,
    );
  });
});

test("verifyPurgedFile rejects a modified header and dangling parents", () => {
  withSessionFile(validContent, (path) => {
    assert.throws(
      () => verifyPurgedFile(path, { ...validExpectation, headerRaw: `${HEADER} ` }),
      /does not keep the original session header/,
    );
  });

  withSessionFile(
    `${HEADER}\n${entry("e1", null)}\n${entry("e2", "missing")}\n`,
    (path) => {
      assert.throws(() => verifyPurgedFile(path, validExpectation), /missing parent/);
    },
  );

  withSessionFile(`${HEADER}\n${entry("e1", null)}\n${entry("e1", null)}\n`, (path) => {
    assert.throws(() => verifyPurgedFile(path, validExpectation), /duplicated entry ids/);
  });
});

test("verifyPurgedFile rejects a file that lost a promised entry", () => {
  withSessionFile(`${HEADER}\n${entry("e1", null)}\n`, (path) => {
    assert.throws(
      () => verifyPurgedFile(path, { ...validExpectation, lineCount: 2 }),
      /lost 1 expected entries/,
    );
    assert.throws(
      () =>
        verifyPurgedFile(path, {
          ...validExpectation,
          keptIds: ["e1"],
          requiredIds: ["e2"],
          lineCount: 2,
        }),
      /lost 1 expected entries/,
    );
  });
});

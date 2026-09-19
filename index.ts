// pi-session-purge — a pi extension with a single command: /purge.
//
// pi keeps every session in an append-only JSONL file: compaction adds a
// summary entry but never removes the history before it. /purge rewrites the
// current session file so that only the last compaction, the entries it needs
// to rebuild its retained tail and everything appended after it survive.
//
// The in-memory session of the running pi process is left untouched, so the
// command always ends by asking the user to restart pi.

import { statSync } from "node:fs";
import { basename } from "node:path";
import {
  formatBytes,
  planPurge,
  renderSessionFile,
  savingsPercent,
  type PurgePlan,
  type PurgeRefusal,
} from "./src/purge.ts";
import {
  assertUnchanged,
  createBackup,
  readSessionFile,
  removeBackup,
  restoreBackup,
  verifyPurgedFile,
  writeSessionFileAtomically,
} from "./src/session-file.ts";

type NotifyKind = "info" | "warning" | "error";

// Minimal pi API used by this extension, typed locally to avoid depending on
// @earendil-works/pi-coding-agent as a devDependency.
interface PurgeCommandContext {
  cwd: string;
  ui: {
    notify(message: string, kind?: NotifyKind): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
  sessionManager: {
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
  };
  isIdle(): boolean;
}

interface PiApi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, ctx: PurgeCommandContext): void | Promise<void>;
    },
  ): void;
}

const REFUSAL_MESSAGES: Record<PurgeRefusal, string> = {
  "not-a-session": "/purge works only on a pi session file.",
  "unsupported-format":
    "The session file contains lines that are not valid session entries, so /purge was aborted to avoid data loss.",
  "no-active-path": "This session has no active position to purge.",
  "no-compaction":
    "/purge can be used only on sessions that have been compacted at least once. This session has never been compacted, so nothing was changed.",
  "no-compaction-on-branch":
    "The current branch has no compaction, and /purge can be used only on the compacted branch of a session. Nothing was changed.",
  "nothing-to-remove":
    "Nothing to purge: this session file already starts at the last compaction.",
};

const WARNING_MESSAGES: Record<string, string> = {
  "missing-kept-range":
    "The compaction does not point to a retained tail on this branch: the purged file keeps everything from the compaction onwards.",
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Text of the confirmation dialog, including every consequence of the purge. */
export function confirmationMessage(sessionFile: string, plan: PurgePlan): string {
  const percent = savingsPercent(plan.totalBytes, plan.keptBytes);
  return [
    "This rewrites the session file on disk. The original physical history of the",
    "session is restructured and everything appended before the last compaction is",
    "deleted: earlier messages, tool results and abandoned branches can no longer be",
    "resumed.",
    "",
    `  File:     ${basename(sessionFile)}`,
    `  Entries:  ${plan.removedRecords} of ${plan.removedRecords + plan.keptRecords} removed`,
    `  Size:     ${formatBytes(plan.totalBytes)} -> about ${formatBytes(plan.keptBytes)} (${percent.toFixed(1)}% smaller)`,
    "",
    "The original session header, the compaction and the messages it retains are",
    "kept, together with everything appended after it.",
    "",
    "A backup is written next to the session file and removed only once the rewrite",
    "is verified; any failure restores it.",
    "",
    "Close every other pi session that has this session open before continuing, and",
    "restart pi afterwards: the file is rewritten while pi has it loaded.",
  ].join("\n");
}

async function purgeSessionFile(
  sessionFile: string,
  ctx: PurgeCommandContext,
): Promise<void> {
  let snapshot;
  try {
    snapshot = readSessionFile(sessionFile);
  } catch (error) {
    ctx.ui.notify(
      `/purge could not read the session file: ${errorMessage(error)}`,
      "error",
    );
    return;
  }

  const result = planPurge(snapshot.text, ctx.sessionManager.getLeafId());
  if (!result.ok) {
    ctx.ui.notify(
      REFUSAL_MESSAGES[result.reason],
      result.reason === "unsupported-format" || result.reason === "not-a-session"
        ? "error"
        : "info",
    );
    return;
  }
  const { plan } = result;

  const confirmed = await ctx.ui.confirm(
    "Purge session file?",
    confirmationMessage(sessionFile, plan),
  );
  if (!confirmed) {
    ctx.ui.notify("/purge cancelled: the session file was not modified.", "info");
    return;
  }

  let backup: string;
  try {
    backup = createBackup(sessionFile);
  } catch (error) {
    ctx.ui.notify(
      `/purge could not create the backup file, so nothing was modified: ${errorMessage(error)}`,
      "error",
    );
    return;
  }

  try {
    assertUnchanged(snapshot);
    writeSessionFileAtomically(sessionFile, renderSessionFile(plan.lines), snapshot.mode);
    verifyPurgedFile(sessionFile, {
      headerRaw: plan.headerRaw,
      keptIds: plan.keptIds,
      requiredIds: plan.requiredIds,
    });
  } catch (error) {
    let restored = true;
    try {
      restoreBackup(backup, sessionFile);
    } catch {
      restored = false;
    }
    ctx.ui.notify(
      `/purge failed and the session file was ${restored ? "restored from the backup" : "NOT restored"}: ${errorMessage(error)}`,
      "error",
    );
    return;
  }

  removeBackup(backup);

  const purgedBytes = statSync(sessionFile).size;
  const percent = savingsPercent(snapshot.size, purgedBytes);
  const saved = Math.max(0, snapshot.size - purgedBytes);
  ctx.ui.notify(
    `Purged ${basename(sessionFile)}: ${plan.removedRecords} of ${plan.removedRecords + plan.keptRecords} entries removed, ${formatBytes(snapshot.size)} -> ${formatBytes(purgedBytes)} (${percent.toFixed(1)}% smaller, ${formatBytes(saved)} saved).`,
    "info",
  );
  for (const warning of plan.warnings) {
    ctx.ui.notify(WARNING_MESSAGES[warning] ?? `purge warning: ${warning}`, "warning");
  }
  ctx.ui.notify(
    "Restart pi, and every other pi instance that had this session open, to reload it from the purged file.",
    "warning",
  );
}

export default function piSessionPurge(pi: PiApi): void {
  pi.registerCommand("purge", {
    description:
      "Rewrite this session file, deleting everything appended before the last compaction",
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        ctx.ui.notify("Usage: /purge (no arguments)", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "/purge can run only while the agent is idle, otherwise the rewrite could race an append. Try again once the current turn finishes.",
          "warning",
        );
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify(
          "/purge needs a file-backed session, and this session is not persisted.",
          "warning",
        );
        return;
      }
      await purgeSessionFile(sessionFile, ctx);
    },
  });
}

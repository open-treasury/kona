/**
 * The whole of the viewer's access to the disk. §6.10 rule 10: the log file plus a watch on
 * it is the one read contract, and this module is that contract expressed as three functions.
 *
 * It matters that it is small and that it is the only one. There is no call here that opens a
 * file for writing, so "the viewer is read-only" is a property of the shape rather than a rule
 * somebody has to keep remembering. Without this module the view would need the store to hand
 * it state, and the seam in §6.12 — viewer depends on `core`, never on the store — would have
 * nowhere to sit.
 */

import { statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** §6.1's layout, from the outside. Two segments, and neither of them is a snapshot. */
export const LOG_RELATIVE_PATH = ".kona/mutations.jsonl";

/**
 * Walk up from `from` looking for the log, the way git finds `.git`.
 *
 * `packages/kona/src/paths.ts` has this same walk. Importing it is the one architectural sin:
 * it would hand the viewer a path to the store. Ten lines of directory walk is the correct
 * price of that seam, and it is paid here in full view rather than argued about later.
 *
 * Returns null rather than throwing, so the caller owns the error message.
 */
export function findPursuitRoot(from: string): string | null {
  let current = resolve(from);
  for (;;) {
    if (statSync(join(current, LOG_RELATIVE_PATH), { throwIfNoEntry: false })?.isFile() === true) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The log a `root` names.
 *
 * Normally `root` is the pursuit root and the log is under `.kona/`. A `root` that is itself a
 * file is read as the log directly — that is how `KONA_LOG` points the dev server straight at
 * `fixtures/thursday.mutations.jsonl`, which the binary wrote where it wrote it and which we
 * are not going to copy into a fake `.kona/` just to satisfy a path shape.
 *
 * The stat is synchronous on purpose: it is one local `lstat` on a path we are about to touch
 * anyway, and making it async would buy a race between the check and the read.
 */
function logPathOf(root: string): string {
  const direct = statSync(root, { throwIfNoEntry: false });
  return direct?.isFile() === true ? root : join(root, LOG_RELATIVE_PATH);
}

/** The log as bytes. Rejects — it does not return an empty string — when it cannot be read:
 *  an unreadable log and an empty pursuit are different facts and must stay so. */
export async function readLog(root: string): Promise<string> {
  return readFile(logPathOf(root), "utf8");
}

/**
 * The unsubscribe returned when there was never a watcher. Named so the two `return` paths of
 * `watchLog` are visibly the same kind of thing.
 */
const NOTHING_TO_UNWATCH = (): void => {
  // No watcher was opened, so there is nothing to close and no timer to disarm.
};

/**
 * Watch the DIRECTORY that holds the log, never the log itself.
 *
 * A writer that replaces the file atomically — write a temp, rename over the top — leaves a
 * file watch attached to an inode nobody will ever write to again, and the viewer goes quiet
 * without ever looking broken. The directory watch sees the rename; measured here, it does.
 *
 * `fs.watch` also fires more than once per logical change: three appends 10ms apart produced
 * two events on this machine, and one write can produce two. Every caller would otherwise
 * write the same debounce, so it lives here. 60ms is long enough to swallow a burst and short
 * enough that the canvas still reads as live.
 *
 * A directory that is not there is NOT an error here. `kona view` run before `kona init` — or
 * in a directory somebody typed wrong — is a pursuit that does not exist yet, which is a state
 * the viewer has a message for: `GET /api/log` answers 500 with the reason the read failed.
 * `fs.watch` throws that case synchronously, before `Bun.serve` is ever reached, so letting it
 * out would kill the process with a `node:fs` stack and take the carefully worded message with
 * it — the message written for exactly this failure would be unreachable on exactly this
 * failure. Swallowed here, the server starts and the read route owns the explaining. Nothing
 * is then watching, so a pursuit created afterwards appears on the next connect rather than by
 * itself; a retry loop is the wrong thing to hide inside the module that is supposed to be the
 * small one.
 *
 * Returns an unsubscribe. Call it: a live `fs.watch` holds the event loop open, which is how
 * a test suite ends up hanging with nothing to show for it.
 */
export function watchLog(root: string, onChange: () => void, debounceMs = 60): () => void {
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(dirname(logPathOf(root)));
  } catch {
    return NOTHING_TO_UNWATCH;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let live = true;

  watcher.on("change", () => {
    if (!live) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  });

  // A watcher whose directory is removed under it emits an error. Losing the feed is a real
  // problem, but it is one the next read reports, in a route that can phrase it; taking the
  // process down from inside an event handler tells the reader nothing.
  watcher.on("error", () => {
    live = false;
  });

  return () => {
    live = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    watcher.close();
  };
}

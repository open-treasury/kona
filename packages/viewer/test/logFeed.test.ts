/**
 * The read contract, exercised against a real directory on a real filesystem.
 *
 * There is nothing to mock here that would be worth mocking: the whole value of this module is
 * that it behaves correctly against the two things the OS actually does — coalesce and repeat
 * watch events, and replace a file by renaming over it. A fake `fs` would agree with whatever
 * we believed while writing it, which is exactly the belief under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldLog } from "@kona/core";
import { LOG_RELATIVE_PATH, findPursuitRoot, readLog, watchLog } from "../src/server/logFeed.ts";
import { headVersion, logText } from "./fixture.ts";

/** The module under test, as a path a spawned child can import. Derived, so a move follows. */
const LOG_FEED = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "logFeed.ts");

let base: string;
let root: string;
let log: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "kona-logfeed-"));
  root = join(base, "pursuit");
  mkdirSync(join(root, ".kona"), { recursive: true });
  log = join(root, LOG_RELATIVE_PATH);
  writeFileSync(log, "");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * Long enough for the events from the setup writes above to have been delivered before a test
 * subscribes. Without it a watcher can open onto a notification about a write it never saw,
 * and the burst count is off by one for reasons that have nothing to do with debouncing.
 */
function quiet(): Promise<void> {
  return Bun.sleep(200);
}

describe("findPursuitRoot", () => {
  test("walks up from a nested subdirectory, the way git finds .git", () => {
    const deep = join(root, "notes", "drafts", "thursday");
    mkdirSync(deep, { recursive: true });

    expect(findPursuitRoot(deep)).toBe(root);
    expect(findPursuitRoot(root)).toBe(root);
  });

  test("returns null rather than throwing when there is no pursuit above", () => {
    const orphan = mkdtempSync(join(tmpdir(), "kona-orphan-"));
    try {
      expect(findPursuitRoot(orphan)).toBeNull();
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  test("stops at the nearest pursuit, not the outermost", () => {
    const inner = join(root, "sub", "inner");
    mkdirSync(join(inner, ".kona"), { recursive: true });
    writeFileSync(join(inner, LOG_RELATIVE_PATH), "");

    expect(findPursuitRoot(join(inner, "deeper"))).toBe(inner);
  });
});

describe("readLog", () => {
  test("round-trips the fixture log byte for byte", async () => {
    const text = logText();
    writeFileSync(log, text);

    const read = await readLog(root);
    expect(read).toBe(text);
    // Not just the same bytes: the same pursuit. The fixture folds to its own head version.
    expect(foldLog(read).graph.version).toBe(headVersion());
  });

  test("reads a log named directly, which is how KONA_LOG points at the fixture", async () => {
    const text = logText();
    writeFileSync(log, text);

    expect(await readLog(log)).toBe(text);
  });

  test("rejects when the log is unreadable — not the same fact as an empty pursuit", async () => {
    const empty = join(base, "nothing-here");
    mkdirSync(empty);

    await expect(readLog(empty)).rejects.toThrow();
  });
});

describe("watchLog", () => {
  test("collapses a burst of appends into one callback", async () => {
    await quiet();
    let fired = 0;
    const bump = () => {
      fired += 1;
    };
    const unsubscribe = watchLog(root, bump, 200);
    try {
      await Bun.sleep(50);
      appendFileSync(log, '{"v":1}\n');
      await Bun.sleep(20);
      appendFileSync(log, '{"v":2}\n');
      await Bun.sleep(20);
      appendFileSync(log, '{"v":3}\n');
      await Bun.sleep(500);

      expect(fired).toBe(1);
      // And the callback is a nudge, not a payload: the reader goes back to the file.
      expect(await readLog(root)).toBe('{"v":1}\n{"v":2}\n{"v":3}\n');
    } finally {
      unsubscribe();
    }
  });

  test("fires again after the window — the debounce delays, it does not swallow", async () => {
    await quiet();
    let fired = 0;
    const bump = () => {
      fired += 1;
    };
    const unsubscribe = watchLog(root, bump, 40);
    try {
      await Bun.sleep(50);
      appendFileSync(log, '{"v":1}\n');
      await Bun.sleep(300);
      appendFileSync(log, '{"v":2}\n');
      await Bun.sleep(300);

      expect(fired).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  test("sees an atomic replace, which a watch on the file itself would miss", async () => {
    await quiet();
    let fired = 0;
    const bump = () => {
      fired += 1;
    };
    const unsubscribe = watchLog(root, bump, 60);
    try {
      await Bun.sleep(50);
      const staging = join(root, ".kona", "mutations.jsonl.tmp");
      writeFileSync(staging, '{"v":9}\n');
      renameSync(staging, log);
      await Bun.sleep(400);

      expect(fired).toBeGreaterThanOrEqual(1);
      expect(await readLog(root)).toBe('{"v":9}\n');
    } finally {
      unsubscribe();
    }
  });

  test("the default window is short enough to feel live and long enough to coalesce", async () => {
    await quiet();
    let fired = 0;
    const bump = () => {
      fired += 1;
    };
    const unsubscribe = watchLog(root, bump);
    try {
      await Bun.sleep(50);
      appendFileSync(log, '{"v":1}\n');
      await Bun.sleep(5);
      appendFileSync(log, '{"v":2}\n');
      await Bun.sleep(400);

      expect(fired).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  test("a pursuit that does not exist yet is a no-op watch, not a crash", async () => {
    // `kona view` before `kona init`, or a path somebody typed wrong. `fs.watch` throws for
    // this synchronously, and `serveViewer` calls it before `Bun.serve` — so a throw that got
    // out would kill the process with an fs stack, and the 500 that exists to explain exactly
    // this case would never be reachable on exactly this case.
    const missing = join(base, "no-pursuit-here");
    let fired = 0;
    const bump = () => {
      fired += 1;
    };

    const unsubscribe = watchLog(missing, bump, 40);
    try {
      mkdirSync(join(missing, ".kona"), { recursive: true });
      writeFileSync(join(missing, LOG_RELATIVE_PATH), '{"v":0}\n');
      await Bun.sleep(300);

      // Nothing is watching, and the claim is only that this did not throw. A pursuit created
      // after the viewer started reaches the canvas on the next connect — `/api/events` reads
      // the log when a stream opens — not by itself.
      expect(fired).toBe(0);
      expect(await readLog(missing)).toBe('{"v":0}\n');
    } finally {
      // And tearing down a watch that was never opened has to be safe, or the caller needs to
      // know which kind of unsubscribe it is holding.
      unsubscribe();
    }
  });

  test("unsubscribing stops the callback and releases the watch", async () => {
    await quiet();
    let fired = 0;
    const bump = () => {
      fired += 1;
    };
    const unsubscribe = watchLog(root, bump, 40);
    await Bun.sleep(50);
    appendFileSync(log, '{"v":1}\n');
    await Bun.sleep(300);
    expect(fired).toBe(1);

    unsubscribe();
    appendFileSync(log, '{"v":2}\n');
    await Bun.sleep(300);
    expect(fired).toBe(1);
  });

  test("the released watch lets the process end — the half a callback count cannot see", async () => {
    // The test above passes with `watcher.close()` deleted: `live = false` is enough to stop
    // the callback on its own. What `close()` buys is the other half of the sentence, and it
    // is invisible from inside the process doing the watching — a live `fs.watch` holds the
    // event loop open, so the only witness is a process that is allowed to end. `serveViewer`
    // calls this unsubscribe from `stop()`, which makes this the difference between `kona
    // view` ending on Ctrl-C and hanging there with nothing on screen to explain itself.
    //
    // The child proves the watch was really open — it appends and waits for the event —
    // before it unwatches. A script that exits without ever having opened a watcher exits
    // promptly for a reason that has nothing to do with `close()`, and would read as a pass.
    // Measured here: ~50ms end to end against this module, still running after ten seconds
    // with the `close()` removed.
    const home = mkdtempSync(join(tmpdir(), "kona-logfeed-exit-"));
    try {
      const pursuit = join(home, "pursuit");
      mkdirSync(join(pursuit, ".kona"), { recursive: true });
      writeFileSync(join(pursuit, LOG_RELATIVE_PATH), "");

      const probe = join(home, "probe.ts");
      writeFileSync(
        probe,
        [
          `import { appendFileSync } from "node:fs";`,
          `import { watchLog } from ${JSON.stringify(LOG_FEED)};`,
          // Exit 3 rather than hang if the event never arrives: that is a broken premise, and
          // it must not be reported as the leak this test is looking for.
          `const giveUp = setTimeout(() => { process.exit(3); }, 1500);`,
          `let sawChange = () => {};`,
          `const changed = new Promise((resolve) => { sawChange = resolve; });`,
          `const unwatch = watchLog(${JSON.stringify(pursuit)}, () => { sawChange(); }, 10);`,
          `appendFileSync(${JSON.stringify(join(pursuit, LOG_RELATIVE_PATH))}, '{"v":1}\\n');`,
          `await changed;`,
          `clearTimeout(giveUp);`,
          `unwatch();`,
          // Nothing else here holds the loop open. If the watcher is still attached, this is
          // where the process fails to end.
        ].join("\n"),
      );

      const child = Bun.spawn({
        // Run it out of the temp directory, not the repo: the child needs nothing from the
        // workspace, and standing it somewhere else keeps the suite's own resolution out of
        // what is being measured.
        cmd: [process.execPath, "run", probe],
        cwd: home,
        stdout: "ignore",
        stderr: "inherit",
      });
      try {
        const LEAKED = "still running — the fs.watch outlived its unsubscribe";
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const overran = new Promise<typeof LEAKED>((resolve) => {
          deadline = setTimeout(() => {
            resolve(LEAKED);
          }, 2500);
        });
        const outcome = await Promise.race([child.exited, overran]);
        if (deadline !== undefined) clearTimeout(deadline);

        // Not "it finished in time" — the exit status itself. A 3 says the watch never fired
        // and this run proved nothing; anything else says the child died on its own error.
        expect(outcome).toBe(0);
      } finally {
        child.kill();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("an append inside the window after unsubscribing never lands", async () => {
    await quiet();
    let fired = 0;
    const bump = () => {
      fired += 1;
    };
    const unsubscribe = watchLog(root, bump, 150);
    await Bun.sleep(50);
    appendFileSync(log, '{"v":1}\n');
    await Bun.sleep(30);
    // Mid-debounce: the timer is armed and has not run. Tearing down has to disarm it, or a
    // stopped server still pushes one last frame into a closed stream.
    unsubscribe();
    await Bun.sleep(400);

    expect(fired).toBe(0);
  });
});

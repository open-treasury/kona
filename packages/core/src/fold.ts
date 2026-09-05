/**
 * `fold(mutations) -> graph` (§6.1). Pure, deterministic, and tolerant of a torn final line.
 *
 * Folding is a data operation, not a replay: nothing here re-executes anything, which is
 * precisely what lets crash-resume and mid-run mutation coexist. Every replay-based engine
 * buys resume by forbidding mutation; this function is where Kona declines that trade.
 */

import { type Graph, emptyGraph } from "./graph.ts";
import { SCHEMA_VERSION, type MutationRecord, MutationRecordSchema } from "./schema.ts";
import { applyOps } from "./apply.ts";

/** A line the loader could not use. §6.7: report which records failed rather than dying. */
export interface DamagedLine {
  /** 1-based, so it matches what an editor shows. */
  line: number;
  reason: string;
  detail: string;
}

export interface FoldResult {
  graph: Graph;
  records: MutationRecord[];
  /**
   * A truncated final line, dropped rather than guessed at. Append-then-fsync means a
   * crash can only ever damage the tail, so this is the expected shape of a crash.
   */
  torn_tail: string | null;
  damaged: DamagedLine[];
}

/**
 * Split a log into lines, stripping one trailing `\r` per line so a CRLF checkout folds
 * identically to a LF one, and dropping blank lines (which can carry no data either way).
 */
export function splitLogLines(text: string): { line: number; text: string }[] {
  return text
    .split("\n")
    .map((raw, index) => ({ line: index + 1, text: raw.replace(/\r$/, "") }))
    .filter((entry) => entry.text.trim().length > 0);
}

function parseLine(text: string): MutationRecord | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
  const parsed = MutationRecordSchema.safeParse(json);
  if (!parsed.success) {
    return {
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return parsed.data;
}

export interface FoldOptions {
  schemaVersion?: number;
  /**
   * Stop after folding the record with this version — read-only time travel (§6.10 rule 6).
   * It is not a revert: nothing is removed from the log and no earlier state is restored,
   * so the scrubber that consumes this can look nothing like undo.
   */
  upToVersion?: number;
}

export function foldLog(text: string, options: FoldOptions = {}): FoldResult {
  const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
  const lines = splitLogLines(text);
  const records: MutationRecord[] = [];
  const damaged: DamagedLine[] = [];
  let tornTail: string | null = null;
  let graph = emptyGraph(schemaVersion);

  for (const [position, entry] of lines.entries()) {
    const isFinalLine = position === lines.length - 1;
    const parsed = parseLine(entry.text);

    if ("error" in parsed) {
      // Only the tail can be torn. Anything else is corruption of a durable record, and
      // it is reported rather than skipped quietly — a missing version is worse than a
      // loud one.
      if (isFinalLine) {
        tornTail = entry.text;
      } else {
        damaged.push({ line: entry.line, reason: "UNPARSEABLE_RECORD", detail: parsed.error });
      }
      continue;
    }

    // The genesis record carries the format's version, so this is the one place a log from
    // an older store can be turned away — before a single op is applied. Refusing here
    // rather than at each verb keeps "every read starts with a fold" true.
    if (parsed.v === 0 && parsed.schema_version !== SCHEMA_VERSION) {
      damaged.push({
        line: entry.line,
        reason: "SCHEMA_VERSION_UNSUPPORTED",
        detail:
          `log is schema_version ${parsed.schema_version}, this store writes ` +
          `${SCHEMA_VERSION}. There is no migration: start a new pursuit with \`kona init\`.`,
      });
      break;
    }

    // `?? -1` covers the empty case, so there is no length test to get wrong.
    const expected = (records[records.length - 1]?.v ?? -1) + 1;
    if (parsed.v !== expected) {
      damaged.push({
        line: entry.line,
        reason: "VERSION_DISCONTINUITY",
        detail: `expected v=${expected}, found v=${parsed.v}`,
      });
      continue;
    }

    // No ceiling means no ceiling; folding to head is the default, not a special case.
    if (parsed.v > (options.upToVersion ?? Number.POSITIVE_INFINITY)) break;

    const applied = applyOps(graph, parsed.ops, parsed.v, parsed.occurred_at);
    if (!applied.ok) {
      damaged.push({
        line: entry.line,
        reason: applied.rejection.reason,
        detail: applied.rejection.message,
      });
      continue;
    }

    graph = applied.value;
    records.push(parsed);
  }

  return { graph, records, torn_tail: tornTail, damaged };
}

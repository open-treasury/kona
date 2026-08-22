/**
 * The client half of the one read contract (§6.10 rule 10): the log file, and a watch on it.
 *
 * The viewer holds no authoritative state. This hook owns the only mutable thing in the app —
 * the text of `.kona/mutations.jsonl` — and everything else in the tree is a pure function of
 * it. That is what makes "the file always wins" true rather than aspirational: there is no
 * local edit path for a re-render to lose, and a reconnect cannot leave the view half-stale,
 * because every message carries the whole log rather than a delta.
 */

import { useEffect, useState } from "react";

export type FeedState = "connecting" | "open" | "lost";

export interface Feed {
  text: string;
  state: FeedState;
  /** Bytes seen. Useful in the topbar, and it makes an append visible even at v-unchanged. */
  bytes: number;
}

interface Message {
  text?: unknown;
}

const EVENTS_PATH = "/api/events";

export function useLogFeed(path: string = EVENTS_PATH): Feed {
  const [text, setText] = useState("");
  const [state, setState] = useState<FeedState>("connecting");

  useEffect(() => {
    // EventSource reconnects on its own with a backoff, which is the behaviour we want when
    // the operator restarts `kona view` mid-demo. `lost` is therefore a display state, not an
    // error path: there is nothing to retry by hand.
    const source = new EventSource(path);

    const onLog = (event: MessageEvent<string>): void => {
      let parsed: Message;
      try {
        parsed = JSON.parse(event.data) as Message;
      } catch {
        return;
      }
      if (typeof parsed.text === "string") setText(parsed.text);
      setState("open");
    };

    source.addEventListener("log", onLog);
    source.addEventListener("open", () => {
      setState("open");
    });
    source.addEventListener("error", () => {
      setState("lost");
    });

    return () => {
      source.removeEventListener("log", onLog);
      source.close();
    };
  }, [path]);

  return { text, state, bytes: text.length };
}

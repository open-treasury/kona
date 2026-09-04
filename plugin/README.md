# The Kona plugin

All the judgment. `kona` is a deterministic CLI that never calls a model; this is where the
model lives.

```bash
claude --plugin-dir ./plugin
```

Then `/kona:plan <what you are trying to get done>`.

|                     |                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `/kona:plan`        | author a pursuit from a brief — a batch of typed ops the CLI validates                     |
| `/kona:run`         | the loop: dispatch what is ready, take in replies, change the plan                         |
| `kona-executor`     | subagent; does one action node from its brief, returns `EXECUTED` / `COMPOSED` / `REFUSED` |
| `SessionStart` hook | reports an open pursuit's status. **Reports — it never writes**                            |
| `bin/kona`          | the CLI. Plugin `bin/` is on the Bash PATH, so skills just say `kona`                      |

## What it is careful about

**The catalogue is not paraphrased.** §6.9 records that a paraphrase of the op vocabulary
produced four stuck-gate defects. But the spec writes ops in a shorthand that is not
parseable JSON, so "verbatim" has to mean _the shape the CLI accepts_ —
`packages/kona/test/plugin-catalogue.test.ts` extracts every JSON example in these files and
runs it through the real parser. If the schema moves and the prompt does not, that test
fails. It has already caught one: `"node": "<the event>"` is not a valid node id, and a model
copying it literally would have been rejected on arrival.

**Mutation is automatic, with exactly one gate.** Every topology change — fan-out, reroute,
follow-up, obviation, supersede-with-compensation, re-plan — happens without asking.
The one thing that stops is _a new irreversible effect to a recipient the graph has never
seen_. At n=60, when the graph became unsatisfiable, the mutator's most common repair was to
invent counterparties and queue email to them; it passed every other check. The plan changes
freely; the world does not; nobody new enters the world without a human.

**`/kona:run` cannot be auto-invoked.** It carries `disable-model-invocation: true`, because
it dispatches sends that cannot be taken back. A human starts it.

**The SessionStart hook uses `--dry-run`.** Plan T5.5 describes it as making kill-and-resume
automatic, and a plain `kona resume` would — by committing a mutation. Firing timeouts
unprompted at every session start, in a session opened for something else entirely, is a
write nobody asked for. It reports, and says what it _would_ repair.

**It is additive and trivially removable.** One `SessionStart` hook, no git hooks, no
daemon, no writes to `~/.claude/settings.json`. Delete the directory and nothing is left
behind.

## Testing changes

```bash
claude plugin validate ./plugin       # manifest
bun test packages/kona/test/plugin-catalogue.test.ts   # the prompt against the parser
```

Note: `plugin.json`'s `agents` field wants an array of **file** paths, not a directory —
`"./agents/"` fails validation. It is omitted here, since `agents/` at the plugin root is
auto-discovered.

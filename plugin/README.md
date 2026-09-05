# Kona portable capability bundle

Canonical copy, PRD, SPEC, and issues skills run on OpenCode, Codex, Claude Code, and Pi. PRD and
SPEC create or refine agreed documents. Copy supports `generate`, `revise`, and `source-edit`: it
returns a standalone draft, improves supplied copy, or changes only explicitly agreed project files
and strings. Issues plans and executes Beads-backed work. One Kona release and lifecycle operation
manages all four skills.

Copy source edits preserve placeholders, interpolation, markup, links, accessibility semantics,
localization keys, syntax, formatting, behavior, and unrelated content. The skill requests any
host-required approval before writing or running proportionate local validation, and reports failed
or unavailable checks instead of claiming success.

## Acquire `kona`

Prerequisites: macOS or Linux, Node.js 20+, `curl`, `tar`, and `sha256sum` or `shasum`. Lifecycle
verification also requires the selected host's CLI on `PATH`. Inspect the published bootstrap
before running it:

```bash
curl -fsSL https://github.com/open-treasury/kona/releases/latest/download/install.sh -o install.sh
less install.sh
sh install.sh
rm install.sh
```

The equivalent one-line acquisition is:

```bash
curl -fsSL https://github.com/open-treasury/kona/releases/latest/download/install.sh | sh
```

The bootstrap downloads only immutable versioned assets from the approved GitHub release/CDN
hosts. It verifies `SHA256SUMS` and the archive's internal manifest before activation, uses no
`sudo`, and changes no startup file. Versions live under
`${XDG_DATA_HOME:-$HOME/.local/share}/kona/versions/`; the command is linked at
`${KONA_BIN_DIR:-$HOME/.local/bin}/kona`. Put that bin directory on `PATH` yourself.

The standalone curl/package command exposes exactly `install`, `update`, `verify`, `disable`,
`enable`, and `remove`. The existing Claude plugin's `plugin/bin/kona` exposes those lifecycle
verbs and forwards its workflow CLI verbs unchanged; forwarded workflow verbs require Bun or the
compiled workflow binary. Lifecycle verbs require only Node.js 20+.

## Lifecycle rules

```text
kona <install|update|verify|disable|enable|remove> \
  --host <opencode|codex|claude|pi> --scope <project|user|local>
```

`local` is valid only for Claude Code. `--project-root <path>` defaults to the current directory.
`--json` emits machine-readable results. Verification uses native discovery/listing and never
calls a model. Claude and Pi accept `--source`; Claude defaults to the approved GitHub marketplace,
Pi defaults to `git:github.com/open-treasury/kona`, and both accept explicit local sources for
offline validation.

Protected lifecycle state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/kona`; project and
Claude local records are keyed by the canonical project root rather than written into project
source.

Only one scope per host may be active. Disable or remove the active scope before installing or
enabling another; disabled scopes may coexist. There is no per-capability selector: every verb acts
on the copy, PRD, SPEC, and issues bundle together. Kona refuses unsafe links, ownership/version
drift, unknown state schemas, and changed backups. If an allowed destination already contains an
unowned file, inspect the reported conflict and consent to only those exact bytes:

```bash
kona install --host opencode --scope project --confirm-replace <reported-sha256>
```

Repeat `--confirm-replace` for each reported digest. Kona backs up confirmed replacements and
restores them on disable or removal. Mutations are locked and journaled; the next invocation tries
to recover an interrupted operation. If rollback cannot be proved, Kona leaves recovery evidence
and refuses to claim success. Disable and remove affect every Kona capability, but authored copy,
authored PRDs/SPECs, project source, and unrelated configuration are never lifecycle-owned.

Release `0.4.1` writes strict schema-v4 ownership state for the ordered
`copy`/`prd`/`spec`/`issues` bundle. Schema-v1 `0.1.1` PRD-only, schema-v2 `0.2.0` PRD+SPEC,
and schema-v3 `0.3.0` copy+PRD+SPEC installations remain inspectable and removable. `verify` and
`install` return `UPDATE_REQUIRED`; only an explicit `update` validates legacy ownership and
migrates directly to schema v4. A disabled legacy install must be enabled and verified before
update.

## OpenCode

| Scope   | Installed roots and adapters                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Project | `.opencode/skills/{copy,prd,spec,issues}/` and `.opencode/agents/{copy-writer,prd-writer,spec-writer}.md`                   |
| User    | `~/.config/opencode/skills/{copy,prd,spec,issues}/` and `~/.config/opencode/agents/{copy-writer,prd-writer,spec-writer}.md` |

```bash
kona install --host opencode --scope project
kona verify --host opencode --scope project
kona update --host opencode --scope project
kona disable --host opencode --scope project
kona enable --host opencode --scope project
kona remove --host opencode --scope project
```

Replace `project` with `user` for user scope. Invoke `@copy-writer <brief>`, `@prd-writer <brief>`,
`@spec-writer <brief>`, or `issues`. Copy edits and proportionate local validation commands require
approval; network access is denied. Disable removes owned discovery files while preserving
protected state; enable restores them. Kona does not edit unrelated `opencode.json` content.

## Codex

| Scope   | Installed skill roots                      |
| ------- | ------------------------------------------ |
| Project | `.agents/skills/{copy,prd,spec,issues}/`   |
| User    | `~/.agents/skills/{copy,prd,spec,issues}/` |

```bash
kona install --host codex --scope project
kona verify --host codex --scope project
kona update --host codex --scope project
kona disable --host codex --scope project
kona enable --host codex --scope project
kona remove --host codex --scope project
```

Replace `project` with `user` for user scope. Invoke `$copy <brief>`, `$prd <brief>`, or
`$spec <brief>`, or `$issues`. Disable/enable changes all four entries in one bounded Kona-owned
block in `~/.codex/config.toml`; restart Codex afterward.

## Claude Code

Claude supports `project`, `local`, and `user`. Mutations display the exact native argv plan and
require a second run with `--approve`:

```bash
kona install --host claude --scope project
kona install --host claude --scope project --approve
kona verify --host claude --scope project
kona update --host claude --scope project --approve
kona disable --host claude --scope project --approve
kona enable --host claude --scope project --approve
kona remove --host claude --scope project --approve
```

Replace `project` with `local` for an unshared repository installation or `user` for all projects.
Claude stores the single Kona plugin in its host-managed plugin root for that scope and discovers
all four skills through the existing `./skills/` directory. Invoke `/kona:copy <brief>`,
`/kona:prd <brief>`, `/kona:spec <brief>`, or `/kona:issues`. Kona registers the approved marketplace
when absent and refuses a duplicate marketplace, a same-named plugin from another source, or another
active scope. Claude's marketplace auto-update setting remains host-controlled; `kona update`
requests an explicit update.

The equivalent direct native commands are:

```bash
claude plugin marketplace add https://github.com/open-treasury/kona
claude plugin install kona --scope project
claude plugin install kona --scope local
claude plugin install kona --scope user
claude plugin list
claude plugin update kona
claude plugin disable kona
claude plugin enable kona
claude plugin uninstall kona
claude plugin marketplace remove kona
```

Review native plugin and marketplace trust prompts before approval. Native package-manager effects
are not globally atomic; Kona journals completed steps and compensates only when it can prove the
reverse operation.

## Pi

Kona's canonical Pi source is `git:github.com/open-treasury/kona`. Pi reads the repository-root
`package.json`, whose package metadata declares `./plugin/skills/copy`, `./plugin/skills/prd`,
`./plugin/skills/spec`, and `./plugin/skills/issues` in deterministic order. Project scope records the one package in
`.pi/settings.json`; user scope records it in `~/.pi/agent/settings.json`. Both resolve those skill
roots inside the same installed package. A project must be trusted before Pi loads local resources.
Kona uses Pi's one-run `--approve` override and does not persist a user trust decision.

```bash
pi install git:github.com/open-treasury/kona -l
pi install git:github.com/open-treasury/kona

kona install --host pi --scope project
kona install --host pi --scope project --approve
kona verify --host pi --scope project
kona disable --host pi --scope project --approve
kona enable --host pi --scope project --approve
kona remove --host pi --scope project --approve
```

Replace `project` with `user` for user scope. `--source /absolute/path/to/kona` overrides the
canonical source for local/offline validation. Invoke `/skill:copy <brief>`, `/skill:prd <brief>`,
`/skill:spec <brief>`, or `/skill:issues`. Unpinned sources update
natively; pinned git tags or commits must be replaced with a different pin for the same package:

```bash
kona update --host pi --scope user --approve
kona update --host pi --scope project --source git:github.com/open-treasury/kona@v0.4.1 --approve
```

The corresponding native lifecycle is:

```text
pi install git:github.com/open-treasury/kona -l
pi install git:github.com/open-treasury/kona
pi list
pi config -l
pi config
pi update git:github.com/open-treasury/kona
pi install git:github.com/open-treasury/kona@<new-pin> -l
pi install git:github.com/open-treasury/kona@<new-pin>
pi remove git:github.com/open-treasury/kona -l
pi remove git:github.com/open-treasury/kona
```

Disable/enable opens `pi config -l` or `pi config`; toggle all four Kona skills and exit so Kona can
verify their discovery state.

## Privacy and development

The skills, templates, adapters, and lifecycle runtime contain no analytics or telemetry, no
background network behavior, and no runtime dependency on the source repository's `guidelines/`
directory. Copy and PRD authoring are offline. The issues skill accesses the network only for an
explicitly approved `br` installation. SPEC external research occurs only when a material public
fact requires it and host/user policy permits it; private repository content is never transmitted
without permission. The release bootstrap contacts only approved GitHub release/CDN hosts; Claude
and Pi may contact only the sources configured for their explicit native package operations.

Run the checkout directly with `claude --plugin-dir ./plugin`; Claude uses its existing skill
directory discovery, so invoke `/kona:copy <brief>`, `/kona:prd <brief>`, `/kona:spec <brief>`,
`/kona:plan <brief>`, or `/kona:run`. Validate changes with:

```bash
bun run plugin:build
bun run plugin:validate
bun run test:plugin
claude plugin validate ./plugin
```

The automated cross-host check is adapter payload/contract parity, not semantic output parity or an
LLM evaluation. It proves that every installed and distributed host resolves the exact canonical
skill/reference/template bytes, invocation, supported modes, and write contracts. Before release,
manually dogfood copy generate, revise, and source-edit plus PRD/SPEC create and refinement with a
real model on every supported host. Review source-edit approvals, token preservation, unsupported
claims, preserved decisions, scope, acceptance criteria, and write boundaries. Record the
host/version, model, prompt, output path, and outcome in
[`test/DOGFOOD.md`](test/DOGFOOD.md). The record identifies any remaining host/mode evidence that
must be collected before release.

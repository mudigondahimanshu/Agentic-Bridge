# Enterprise Agentic Bridge

**An MCP server that turns a legacy codebase — and the human decisions around it — into
machine-readable context an AI can be trusted with.**

Built entirely on [NitroStack](https://nitrostack.ai). One project, one process: the swarm,
the admin dashboard, the metaprogramming engine and the deployment target are all NitroStack.

---

## The problem

Drop a stateless AI into a thirty-year-old enterprise repository and it produces code that
compiles and gets rejected in review. Not because the model is weak — because it cannot see
the things that actually govern the codebase:

- that `aurora-orm.js` is load-bearing and **frozen for the sprint** (said out loud in standup,
  written down nowhere);
- that the Jira ticket says *"introduce Redis"* but the engineering lead **killed that decision
  verbally two days ago**;
- that CI rejects any commit without a `[AUR-1234]` key;
- that the coverage gate is 78% lines and the build hard-fails below it;
- that every list view must use `<DataTable>` and no one may invent a hex colour.

None of that is in the source code. It is in Jira, in a Teams transcript, in a Jenkinsfile,
in `CONTRIBUTING.md`, and in a `tokens.css` file nobody reads.

## What this does

A swarm of seven specialist agents traverses all of it in one pass, cross-references the
written record against what humans actually said, **stops and asks a person when those two
disagree**, and distils the result into a single `CLAUDE.md` manifest that any AI reads on
startup.

Along the way it writes new MCP tools for whatever it finds that has no modern equivalent.

```
run_swarm ──► 7 personas ──► knowledge base ──► conflict? ──► HUMAN RULES ──► CLAUDE.md
                                                    │                            ▲
                                                    └── paused, nothing guessed ──┘
```

---

## Quick start

```bash
npm install     # also installs widget deps and builds them — see note below
npm run verify
```

> **One command is enough.** A `postinstall` step installs the widget dependencies and
> produces the static export. That export is derived, so it is correctly absent from git —
> but NitroStack resolves every `@Widget` route to `src/widgets/out/<name>/index.html` while
> building the tool list, so a clone that has never been built dies at startup with
> `Exported HTML for route 'architecture-map' not found` and the client reports only that the
> server shut down. The server also rebuilds the bundle itself if it ever goes missing.
> If either safety net is bypassed (`npm install --ignore-scripts`), run `npm run setup`.

`npm run verify` spawns the real MCP server over STDIO and drives the entire demo path with
live JSON-RPC — 65 assertions covering every claim in this README. If it prints
`ALL 65 CHECKS PASSED`, the demo works.

### In NitroStudio

1. **Add Server → Nitro Project → browse to this folder → Open Project → Studio App Canvas.**
   Studio runs `npx tsx src/index.ts` for you.
2. Go to **Tools** and run `run_swarm` with no arguments.
3. The **Swarm Console** widget renders. The run pauses on a conflict.
4. Run `detect_conflicts` → the **Conflict Resolution** widget renders → click a ruling.
5. Run `synthesize_claude_md` → read the manifest.

See [`DEMO.md`](DEMO.md) for the timed stage script.

---

## What's inside

### 23 tools across 11 domain modules

| Module | Persona | Tools |
|---|---|---|
| `codebase` | Structural Cartographer | `map_file_dependencies`, `find_change_surface` |
| `documentation` | Documentation Synthesizer | `parse_package_specs` |
| `qa` | Quality Assurance Analyst | `extract_test_strategy` |
| `devops` | DevOps Navigator | `parse_ci_cd_pipelines` |
| `agile` | Product Synchronizer / Scrum Analyst | `fetch_sprint_goals`, `fetch_meeting_transcripts` |
| `uiux` | UI/UX Integrator | `parse_design_system` |
| `conflict` | — | `detect_conflicts`, `resolve_conflict`, `list_conflicts` |
| `skills` | — | `generate_custom_skill`, `list_generated_skills` |
| `pipeline` | — | `list_pipeline_nodes`, `save_pipeline`, `get_pipeline`, `run_pipeline`, `query_knowledge` |
| `synthesis` | — | `synthesize_claude_md`, `ingest_manual_document`, `reset_bridge` |
| `swarm` | Orchestrator | `run_swarm`, `get_swarm_run` |

Plus **5 MCP resources** (`bridge://manifest/claude-md`, `bridge://knowledge/graph`,
`bridge://skills/registry`, `bridge://conflicts`, `bridge://runs/latest`) and **3 prompts**
that encode the correct tool ordering, so a first-time user gets the full path from a menu.

### 7 widgets — the admin dashboard, inside NitroStack

The dashboard is not a separate Next.js app. It is seven `@nitrostack/widgets` React
components that call MCP tools back through `useWidgetSDK().callTool()`. Clicking
*"Source B is authoritative"* in the conflict widget invokes the real `resolve_conflict` tool,
writes the ruling into the durable knowledge base, and resumes the paused swarm run.

That means the same dashboard renders in NitroStudio, in ChatGPT, and on NitroCloud — with no
second server to deploy and nothing to keep in sync.

| Widget | Surfaces |
|---|---|
| `swarm-console` | per-agent status, timings, fact counts, pause state |
| `conflict-resolver` | side-by-side sources, two-signal scores, resolution buttons |
| `pipeline-builder` | 11-stage palette, ordered composer, run output |
| `architecture-map` | layer distribution, blast-radius meters, change-surface tracer |
| `design-system` | palette swatches, type stack, component inventory, violations |
| `skill-forge` | mint a tool and watch it register live |
| `claude-manifest` | the generated artifact + document dropzone |

---

## Three things worth looking at closely

### 1. Cosine similarity alone cannot catch the conflict — so we don't rely on it

The architecture spec says: flag a conflict when cosine similarity drops below 0.7. That rule
**provably misses the case it was written for**. Compare:

> **Jira AUR-4471:** "Introduce a Redis cache in front of the invoice read path…"
> **Standup:** "we are NOT introducing Redis. We stay on Memcached."

These share nearly all their vocabulary. A pure similarity threshold sails straight past them.

[`semantic.service.ts`](src/shared/services/semantic.service.ts) scores two orthogonal signals:

- **Alignment** — cosine over hashed token vectors. *Are these about the same thing?*
- **Divergence** — entity extraction plus per-clause polarity (adopt / reject / freeze /
  mandate). *Do they choose differently?*

A contradiction is high divergence regardless of alignment; semantic drift is low alignment
with some divergence. Both raise a conflict, tagged with which kind it is. On the bundled
fixture: **alignment 0.21, divergence 1.00 → contradiction.** Caught.

### 2. The swarm genuinely writes and registers new MCP tools at runtime

`generate_custom_skill` is not a stub. It:

1. compiles the spec (syntax errors fail before anything touches disk);
2. writes real, reviewable NitroStack source to `src/skills/<name>.skill.ts` with a proper
   `@Tool` decorator;
3. registers it on the **running** server via `NitroStackServer.tool()` +
   `notifyToolsListChanged()`.

The verification suite asserts the tool count goes 23 → 24 in the same session and that
calling the brand-new tool returns real data. It also survives restart — skills are rehydrated
from the durable registry on boot.

### 3. The manifest is deterministic

`CLAUDE.md` is generated with **zero LLM calls**. Same repository in, byte-identical manifest
out — the verification suite asserts this. It cannot hallucinate a coverage threshold or
invent a component, every claim carries its evidence path, and it works offline with no API
key and no rate limit. Set `ANTHROPIC_API_KEY` only if you want narrative prose layered on
top; the manifest is correct without it.

---

## Honest notes

These are things a reviewer would find, so they are stated up front.

- **Jira and Teams are local fixtures**, not live OAuth — `data/mock-jira-sprint.json` and
  `data/mock-teams-transcript.txt`. The *shape* is the real integration shape: swap
  `AgileService.loadSprint()` for a Jira REST call and nothing downstream changes.
- **Side-effecting pipeline stages are planned, not performed.** `push`, `deploy`,
  `update_jira` and `send_slack_message` return the exact command they would issue — derived
  from what the DevOps Navigator actually found — and are flagged `executed: false`. A bridge
  that force-pushes to a stranger's branch during a demo is not a feature.
- **Skill bodies execute in-process** via `new AsyncFunction`. That is not a security sandbox
  and is not presented as one. A deny-list rejects `require`, `import`, `process`, `eval`,
  `child_process`, `globalThis`, `fetch` and `__dirname` before compilation; the body gets no
  module scope, only a `WorkspaceService`-backed `api`; and
  `BRIDGE_ALLOW_SKILL_GENERATION=false` disables the path. Right threat model: a developer
  running this against their own codebase. Wrong threat model: accepting skill bodies from
  untrusted third parties.
- **`jsonBodyLimit` does not exist in NitroStack v1.0.14.** The architecture spec cites it, but
  it is [issue #4](https://github.com/nitrocloudofficial/nitrostack/issues/4) — an open feature
  request, not a shipped option. Payload safety is instead enforced upstream in
  [`WorkspaceService`](src/shared/services/workspace.service.ts): a root allow-list, a 4,000-file
  cap, a 2 MB per-file cap and a 64 MB traversal budget, with symlinks resolved before the
  containment check.
- **Restate is not used.** The value it would provide here — a long run and a human pause that
  both survive a restart — comes from MCP Tasks (`taskSupport: 'optional'`, `ctx.task`) plus an
  atomic-write JSON store that commits after every agent. One process instead of three.
- The framework logs a `Cannot resolve token "OAUTH_CONFIG"` error on boot. That is NitroStack
  core instantiating its optional OAuth module; it is harmless and unrelated to this project.

---

## Configuration

Everything has a working default. Nothing is required.

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_TRANSPORT` | `stdio` (`http` in production) | Transport mode |
| `PORT` | `8080` | HTTP port |
| `BRIDGE_ALLOWED_ROOTS` | project + fixture | `:`-separated extra roots the swarm may read |
| `BRIDGE_ALLOW_SKILL_GENERATION` | `true` | Set `false` to disable runtime skill minting |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ANTHROPIC_API_KEY` | unset | Optional; enables narrative enrichment |

### Pointing at your own codebase

Every reconnaissance tool takes an optional `target`:

```
map_file_dependencies { "target": "/absolute/path/to/your/repo" }
```

Paths outside the allow-list are refused with an actionable message. Opt in with:

```bash
export BRIDGE_ALLOWED_ROOTS="/Users/you/work/big-monolith"
```

---

## Deploying

```bash
npm run build
```

Bundles the 7 widgets and compiles TypeScript to `dist/`. Then from Studio's App Canvas:
**Link to app… → Deploy**. Once live, the ChatGPT connector URL is `{serviceUrl}/sse` —
verified working locally (`GET /sse` → 200, `POST /mcp` → 200 in production mode).

Ship `fixtures/` and `data/` with the bundle, or the bundled demo target will be missing in the
deployed environment.

---

## Layout

```
src/
├── index.ts                    bootstrap; stashes the live server for runtime tool registration
├── app.module.ts               root @McpApp — transport switches on NODE_ENV
├── shared/
│   ├── schemas/                every Zod schema, one place
│   └── services/
│       ├── workspace.service.ts   allow-list + traversal budget — the only path to the disk
│       ├── store.service.ts       atomic-write durable state (the Restate replacement)
│       ├── semantic.service.ts    embeddings + the two-signal conflict engine
│       └── server-registry.ts     live server handle for runtime tool registration
├── modules/                    one directory per persona
├── widgets/                    the admin dashboard (Next.js, in-project)
├── health/                     3 health checks
└── skills/                     generated at runtime
fixtures/legacy-monolith/       34-file synthetic enterprise repo with a planted contradiction
data/                           mock Jira sprint + Teams transcript
scripts/verify.ts               65-assertion end-to-end suite
```

Built with `@nitrostack/core` 1.0.14 · `@nitrostack/cli` 1.0.15 · `@nitrostack/widgets` 1.0.8

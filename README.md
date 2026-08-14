# dsh-skill-hub

**In-GUI skill hub for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**
Browse the full local skill catalog from the official `ctx.skills` registry, toggle skills on/off, inspect
their bodies, understand why a skill is missing, and scaffold new ones — all from the dsh web GUI.

> A skill manager beyond the read-only browser. The host half runs in the dsh process and speaks only
> official SDKs; the browser half renders inside the GUI through official slots. No dsh source changes.

## Why another skill manager?

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) is a read-only browser,
[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) and
[dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) focus on importing and market-style installs.
**dsh-skill-hub fills the gap between them: a full catalog you can actually manage.**

| Capability | dsh-skill-manager (read-only) | **dsh-skill-hub (this plugin)** |
| --- | --- | --- |
| Catalog source | self-scans disk, user roots only | official `ctx.skills` registry: project / custom / user / bundled + third-party providers |
| Browse / search | ✅ | ✅ (group by source **or** by Sets) |
| Enable / disable | ❌ | ✅ (renames `SKILL.md`; file never deleted, always restorable) |
| Inspect skill body | ❌ | ✅ |
| Discovery diagnostics | ❌ | ✅ (missing frontmatter / missing `name`/`description` / invalid name — each reason listed) |
| New-skill wizard | ❌ | ✅ (writes to `~/.dsh/skills` or `~/.agents/skills`) |
| Invocation statistics | ❌ | ✅ (per-skill call counts read from session logs) |
| Sets grouping | ❌ | ✅ (frontmatter `sets`; skills without sets go to “Uncategorized”) |
| Live updates | — | filesystem-provider watcher, with a 5s panel poll as fallback |

## Features

- **Full catalog** — every skill the official registry knows: project `.dsh/skills` & `.agents/skills`,
  custom roots, user `~/.dsh/skills` & `~/.agents/skills`, bundled, and third-party providers.
- **Search & grouping** — filter by name, group by source or by frontmatter `sets`.
- **Enable / disable** — disable renames `SKILL.md` out of discovery (tracked in a sidecar file), so the
  change survives restarts and is trivially reversible. Files are never deleted.
- **Skill detail** — read a skill’s rendered body straight from disk.
- **Discovery diagnostics** — the catalog reports *why* a skill was ignored (missing YAML frontmatter,
  missing `name`/`description`, illegal name), per skill.
- **New-skill wizard** — scaffold a valid skill into `~/.dsh/skills` or `~/.agents/skills` from the GUI.
- **Invocation statistics** — the panel shows how many times each skill was actually called, read from
  session logs (optional; absent session-query deployments simply omit the data).
- **Settings card** — enable the plugin and toggle the agent announcement from **Settings → 插件 → Skill Hub**.

## How it works

```text
src/
├── index.ts            host entry: inject [webServer, skills, systemPrompt]; system-prompt announcement
├── routes.ts           /api/skill-hub/{catalog,skill,toggle,create,stats,config} (loopback-only fence)
├── store.ts            sidecar state ~/.dsh/dsh-skill-hub.json (disabled list + runtime config, atomic write)
├── skillfs.ts          root resolution / toggle rename / scaffold / diagnostics / frontmatter parsing
├── stats.ts            invocation stats: session logs → per-skill call counts (optional sessionQuery)
├── protocol.ts         host ↔ browser shared API contract (types + endpoint table)
└── client/             browser half: settings card + skill hub panel (React, CSS Modules)
```

- **Host half** uses only official SDKs: `ctx.skills.snapshot()/get()`, `ctx.webServer.register()`,
  `ctx.systemPrompt.section()`. No dsh source is modified.
- **Browser half** mounts through official slots: a **Settings → 技能** section and a
  **Settings → 插件 → Skill Hub** configuration card.
- **Configuration** is plugin-owned. The host’s settings service refuses to expose third-party
  namespaces to the web client, so the settings card reads/writes the plugin’s own
  `/api/skill-hub/config` route instead of the settings transport — no namespace mounting required.

## Installation

From the dsh web profile:

```bash
dsh plugin --profile web add dsh-skill-hub
```

Requires Node `^22.19.0 || >=24.0.0` and a dsh web deployment (`0.1.0-rc.6` SDK family).

## Usage

Open **Settings → 技能** (Skill Hub) in the dsh web GUI:

- **Browse** — the full catalog, searchable and grouped by source or Sets.
- **Toggle** — enable/disable any skill from a user-writable root; disabled skills list separately and
  can be re-enabled any time.
- **Diagnose** — the discovery diagnostics explain why a skill is not showing up.
- **New skill** — scaffold a new skill from the form and start writing.
- **Statistics** — per-skill invocation counts when session-query data is available.

The plugin’s own switches live on the **Settings → 插件 → Skill Hub** card:

| Field | Meaning |
| --- | --- |
| Enable plugin | Master switch: routes, provider, and announcement all go live with this. |
| Announce to agent | Adds a system-prompt section so agents know how to collaborate when users mention skill management. |

## HTTP API

All endpoints are **loopback-only** (`127.0.0.1`/`localhost`) and JSON.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/skill-hub/catalog` | GET | Full catalog: skills, disabled list, discovery diagnostics, Sets. |
| `/api/skill-hub/skill?name=` | GET | One skill’s detail (path, provider, body). |
| `/api/skill-hub/toggle` | POST | Enable/disable a writable skill (`{name, enabled}`). |
| `/api/skill-hub/create` | POST | Scaffold a new skill (`{name, description?, root?}`). |
| `/api/skill-hub/stats` | GET | Per-skill invocation counts (unavailable when session-query is absent). |
| `/api/skill-hub/config` | GET/POST | Plugin runtime config (`{enabled, announceToAgent}`); `null` clears an override. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (54 tests across 5 suites)
npm run build       # tsc declarations + tsdown bundles (lib/index.js + lib/client.js)
npm pack            # build the installable tarball (dsh-skill-hub-<version>.tgz)
```

The test suites cover the route family (including the config route and the disabled gate), the sidecar
store, skill filesystem operations, the registry provider, and invocation statistics.

## Roadmap

- **v0.1.0** — full catalog, enable/disable, diagnostics, new-skill wizard, settings card.
- **v0.2.0** — invocation statistics ✅ · Sets grouping ✅ · recycle-bin delete (pending).
- **v0.3.0** — SSE realtime push to replace polling.

## License

MIT — see [LICENSE](LICENSE).

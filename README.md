# dsh-skill-hub

[中文版](README.zh.md) | [English](README.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-skill-hub"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-skill-hub?color=2f81f7&label=npm"></a>
  <img alt="downloads" src="https://img.shields.io/npm/dm/dsh-skill-hub">
  <img alt="license" src="https://img.shields.io/npm/l/dsh-skill-hub">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933">
  <a href="https://github.com/cheshireez/dsh-skill-hub/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/cheshireez/dsh-skill-hub/ci.yml?branch=main"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub.png" alt="dsh-skill-hub panel" width="640">
</p>

**In-GUI skill hub for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**
Browse the full local skill catalog from the official `ctx.skills` registry, toggle skills on/off, inspect
their bodies, understand why a skill is missing, install from the built-in market, and scaffold new
ones — all from the dsh web GUI.

> A skill manager beyond the read-only browser. The host half runs in the dsh process and speaks only
> official SDKs; the browser half renders inside the GUI through official slots. No dsh source changes.

> **Disclaimer** — source tracking, market sync, and the restorable trash are implemented by this
> plugin; they are not guarantees of the dsh runtime itself. Screenshots may lag the latest UI.

## Table of Contents

- [Why another skill manager?](#why-another-skill-manager)
- [Features](#features)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Usage](#usage)
- [Troubleshooting](#troubleshooting)
- [HTTP API](#http-api)
- [Development](#development)
- [Community](#community)
- [License](#license)

## Why another skill manager?

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) is a read-only browser,
[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) and
[dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) focus on importing and market-style installs.
**dsh-skill-hub fills the gap between them: a full catalog you can actually manage.**

| Capability | dsh-skill-manager (read-only) | **dsh-skill-hub (this plugin)** |
| --- | --- | --- |
| Catalog source | self-scans disk, user roots only | official `ctx.skills` registry: project / custom / user / bundled + third-party providers |
| Browse / search | ✅ | ✅ (group by **tags** or by **source repo**, search + filter in one row) |
| Workspace skills | ❌ | ✅ (enter a project path → its `.dsh/skills` & `.agents/skills` appear, read-only) |
| Enable / disable | ❌ | ✅ (renames `SKILL.md`; file never deleted, always restorable; per-group tri-state switches) |
| Inspect skill body | ❌ | ✅ |
| Discovery diagnostics | ❌ | ✅ (missing frontmatter / missing `name`/`description` / invalid name — each reason listed) |
| New-skill wizard | ❌ | ✅ (writes to `~/.dsh/skills` or `~/.agents/skills`) |
| Invocation statistics | ❌ | ✅ (per-skill call counts read from session logs; group headers summarize) |
| Upstream source tracking | ❌ | ✅ (repo + commit snapshot; check updates, sync, follow upstream deletion into a restorable trash; delete/restore keeps source + scene membership) |
| Market | ❌ | ✅ (unified market list: built-in curated catalog + custom repos; scan any top-level root — `skills/`, `design-templates/`, `templates/` … auto-derived, no allowlist — one-click import, per-source installed/updatable/deleted-upstream badges, one-click update-all) |
| Live updates | — | filesystem-provider watcher, with a 5s panel poll as fallback |
| Drag reorder | ❌ | ✅ (drag handles on every group header: scenes, source collections, and the top-level source-group bar — order persists in `~/.dsh/dsh-skill-hub.json`) |

## Features

### Catalog & switches — manage local skills

> **Browse everything, change anything you own.** The full registry is visible and searchable;
> writes are confined to your user-level roots and never delete files.

- **Full catalog** — every skill the official registry knows: project `.dsh/skills` & `.agents/skills`,
  custom roots, user `~/.dsh/skills` & `~/.agents/skills`, bundled, and third-party providers.
- **Search & grouping** — one row combines search, source filter, and flat/grouped view; groups are
  user **tags (scenes)** plus **source collections** (auto-aggregated by upstream repo); uncategorized
  stays visible.
- **Workspace discovery** — known workspaces (from dsh’s workspace registry) are merged into the
  default view and grouped in a project-level tree (per project, optionally split into
  `.dsh`/`.agents`); the header path field pins the view to one workspace.
- **Group switches** — every group header carries a sliding switch: enable/disable the whole group in
  one click. Closing a group whose member is also enabled elsewhere opens a conflict dialog (close all /
  keep on → the group falls into a half-filled mixed state). Read-only skills are skipped with
  per-name reports.
- **Drag reorder & edit mode** — every group header has a drag handle; scenes, source collections, and
  the top-level source-group bar (project / collections / personal) can be reordered and the order
  persists. An **Edit** toggle on Sources/Scenes reveals delete/reorder controls while keeping the
  flat/grouped view readable — market rows hide edit controls entirely.
- **Enable / disable** — disable renames `SKILL.md` out of discovery (tracked in a sidecar file), so
  the change survives restarts and is trivially reversible. Files are never deleted.
- **Skill detail** — read a skill’s body straight from disk, with its source card (repo, commit,
  check/sync/follow-delete actions).
- **New-skill wizard** — scaffold a valid skill into `~/.dsh/skills` or `~/.agents/skills` from the GUI.

### Market & updates

> **Add a repo, install in one click, stay updated forever.** Imports are tracked upstream
> automatically; updates surface per source and can be applied all at once.

- **Unified market list** — one list on the Market tab: built-in catalog entries show a description
  and an **Add** button until added; once added (or custom sources entered by hand) the same row
  becomes a full source row. No duplicate entries.
- **Scan → install** — scan any repo (any top-level root that contains `SKILL.md` — `skills/`,
  `design-templates/`, `templates/`, … auto-derived, no hard-coded allowlist), tick the skills you
  want, import with one click. Imports record the upstream repo/commit automatically. Large imports
  run as async jobs with byte-level progress (`{jobId, total, totalBytes}` → poll `/repo/import/progress`,
  cancellable) so the panel stays responsive.
- **State badges** — every source row aggregates its state: installed count, updatable count, and
  deleted-upstream count.
- **Check all / update all** — “Check all” refreshes every source (release + skill diffs); “Update
  all” syncs every source with pending updates in one pass (per-source failures are reported, never
  fatal). A daily auto-check (24h, timestamped in localStorage) covers the “forgot to click” case;
  manual buttons are never throttled.
- **Source tracking** — per-source check (1–2 GitHub API requests, 5-minute server throttle), sync
  selected skills (overwrite confirm), and follow upstream deletion into a restorable trash.
  Deleting and restoring a tracked skill keeps its source and scene membership (snapshotted in the
  trash entry). Personal skills (no source) are never tracked.
- **Self-update check** — the panel header checks the plugin’s own latest GitHub release.

### Stats & diagnostics

> **Know what your agents actually use.** Invocation counts come from your own session logs —
> no telemetry leaves the machine.

- **Invocation statistics** — per-skill call counts and last-used times read from session logs
  (optional; absent session-query deployments simply omit the data); group headers summarize. Rolling
  window is configurable (default 14 days; `0` = full history) and a background incremental-scan cache
  (adaptive TTL, daily full reconciliation) keeps large log volumes cheap; both interval and window are
  live from the settings card.
- **Discovery diagnostics** — the catalog reports *why* a skill was ignored (missing YAML
  frontmatter, missing `name`/`description`, illegal name), per skill.
- **Settings card** — enable the plugin, toggle the agent announcement, and adjust panel display
  preferences from **Settings → 插件 → Skill Hub**.

## Quick start

```bash
dsh plugin --profile web add dsh-skill-hub
```

Restart `dsh web`, open **Settings → 技能**, and on the **Market** tab pick a repo from the
built-in catalog (or paste an `owner/repo`), scan it, tick the skills you want, and import. They are
tracked upstream from then on: check for updates and sync with one click.

A skill is just a directory with a `SKILL.md` — the panel can also scaffold one for you:

```markdown
---
name: my-skill
description: One line describing when the agent should use this skill.
---
# my-skill

What the skill does, when to use it, and what output is expected.
```

Requires Node `^22.19.0 || >=24.0.0` and a dsh web deployment (compatible with the `0.1.0-rc.7` and `0.1.1-rc.2` SDK families; peer ranges cover both and forward `0.1.x` lines).

## How it works

```text
 GitHub repo ──scan / import──▶ ~/.dsh/skills (user level)
      ▲                            │
      │ check / sync / delete      ▼
      │                ctx.skills registry ◀── skill-hub provider (registers user + project roots)
      │                            │ snapshot / get
      └────── daily auto-check     ▼
                      /api/skill-hub/* routes ──▶ Browser panel (Settings → 技能)
```

| File | Responsibility |
| --- | --- |
| `src/index.ts` | host entry: inject `[webServer, skills, systemPrompt, settings]`; registers the `dsh-skill-hub` settings namespace; system-prompt announcement |
| `src/routes.ts` | declarative route wrapper: `/api/skill-hub/*` (loopback / method / master-switch / JSON-body fences handled once; handlers stay business-only; async import jobs + drag-reorder routes) |
| `src/store.ts` | sidecar state `~/.dsh/dsh-skill-hub.json` v4 (disabled, tags, sources, market sources, trash, `skillStats` checkpoint, `collectionOrder`/`sourceGroupOrder`; versioned v1→v4 migrations) |
| `src/repo.ts` | GitHub discovery/import + source tracking (latest commit, tree diff, manifest; roots auto-derived from any top-level `SKILL.md`) |
| `src/skillfs.ts` | root resolution / toggle rename / trash & restore / scaffold / diagnostics (Windows-safe `rootOfPath` via `sep`/`relative`) |
| `src/stats.ts` | invocation stats: session logs → per-skill call counts with incremental frozen-bucket cache (rolling window, adaptive TTL, optional sessionQuery) |
| `src/protocol.ts` | host ↔ browser shared API contract (types + endpoint table; generic `RepoRoot = string`, reorder contracts, async import progress) |
| `src/client/` | browser half: settings card + skill hub panel. State and flows live in `useSkillHub.ts`; views are thin components (`SourcesView` / `ScenesView` / `MarketView` / `SkillRow` / dialogs / …). CSS Modules, Apple-style; edit-mode toggle + drag handles |

- **Host half** uses only official SDKs: `ctx.skills.snapshot()/get()`, `ctx.webServer.register()`,
  `ctx.systemPrompt.section()`. No dsh source is modified.
- **Browser half** mounts through official slots: a **Settings → 技能** section and a
  **Settings → 插件 → Skill Hub** configuration card.
- **Configuration** is dsh-native. Since rc.7 the host serves every registered settings namespace to
  the web client (the old namespace allowlist is gone), so the plugin registers a `dsh-skill-hub`
  settings namespace and the card reads/writes it through the official settings transport — the
  configurable-plugins tab dispatches the card by that namespace, and the host consumes the same
  resolved value (single source of truth). Installations upgraded from the older sidecar-configured
  build migrate their saved config into the namespace once.

## Usage

Open **Settings → 技能** (Skill Hub) in the dsh web GUI. Three tabs:

- **来源 (Sources)** — the skill list, flat or grouped: a project-level tree (workspaces merged by
  default, per project optionally split into `.dsh`/`.agents`) plus source collections and
  uncategorized. Search, source filter and sort share one row; group headers carry tri-state
  switches plus a drag handle (reorder persists); the source-group badge doubles as the re-check
  entry. An **Edit** toggle reveals delete/reorder controls without cluttering the read view. *(see the screenshot at the top)*
- **场景 (Scenes)** — your own enable/disable units (e.g. a “Godot” scene vs a “Java” scene): create
  tags, assign members, flip a whole scene on/off with one switch, and drag to reorder scenes. Edit
  mode keeps the grouped/flat switch visible.

  <p align="center">
    <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub-scenes.png" alt="场景 tab" width="560">
  </p>
- **市场 (Market)** — one unified list: built-in curated repos (Add button until added) and your
  custom sources; scan to install, check for updates, update all in one pass.

  <p align="center">
    <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub-catalog.png" alt="市场 tab" width="560">
  </p>

Everywhere: **work space field** in the header (enter a project path to see its read-only project
skills), **trash** section (restorable, restores source + scene membership), **diagnostics** section
(why a skill is missing), and the **new-skill** form.

The plugin’s own switches live on the **Settings → 插件 → Skill Hub** card:

| Field | Meaning |
| --- | --- |
| Enable plugin | Master switch: routes, provider, and announcement all go live with this. |
| Announce to agent | Adds a system-prompt section so agents know how to collaborate when users mention skill management. |
| Model / user dot colors | Override the single status-dot colors shown in the skill panel and the chat `/` menu (blue = model-callable, green = user-only). |
| Show invocation count | Show per-skill call-count chips when session stats are available. |
| Show last-used time | Show relative last-used time on each skill row. |
| Show group summaries | Show count/last-used summaries after group titles. |
| Stats window (days) | Rolling window for invocation counts (default 14; `0` = full history). Change applies live; widening forces a full reconciliation. |
| Auto stats interval (min) | Background session-log scan interval (min 1, default 5); heavy scans automatically stretch the interval. Live from the card. |

## Troubleshooting

- **⚠️ `duplicate loader entry id: skill-hub`** — the plugin was mounted twice (for example both
  through `dsh plugin add` and a local `file:` install). Keep exactly one installation method; on
  upgrade, replace rather than add.
- **A skill is not in the catalog** — open the **发现诊断** (diagnostics) section: missing
  frontmatter, a name mismatch with the directory, or an over-short description are each listed with
  their reason.
- **Update check shows nothing** — the server throttles checks (5 min per source) and the panel
  auto-checks once per day; manual buttons are never throttled.
- **Read-only boundary** — only user-level skills (`~/.dsh/skills`, `~/.agents/skills`) are writable;
  project, bundled, and runtime skills are displayed read-only.
- **Chat `/` menu status dots depend on a dsh-internal registry** — the dots render by wrapping the
  core `/skill` trigger source's candidates. If a dsh upgrade reshapes that internals, the dots
  silently disappear but the skill list and `/` menu keep working. A known, deliberate trade-off for
  portability — it never affects skill management itself.

## HTTP API

All endpoints are **loopback-only** (`127.0.0.1`/`localhost`) and JSON.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/skill-hub/catalog?cwd=` | GET | Full catalog: skills, disabled list, discovery diagnostics (`cwd` adds project skills). |
| `/api/skill-hub/skill?name=&cwd=` | GET | One skill’s detail (path, provider, body). |
| `/api/skill-hub/skill/delete` | POST | Move a skill into the restorable trash (snapshots source + scenes). |
| `/api/skill-hub/toggle` | POST | Enable/disable a writable skill (`{name, enabled}`). |
| `/api/skill-hub/toggle-batch` | POST | Enable/disable a whole group in one write (`{names, enabled}`). |
| `/api/skill-hub/create` | POST | Scaffold a new skill (`{name, description?, root?}`). |
| `/api/skill-hub/stats` | GET | Per-skill invocation counts (unavailable when session-query is absent). |
| `/api/skill-hub/config` | GET/POST | Plugin runtime config (`{enabled, announceToAgent, dot colors, show toggles, statsWindowDays, statsScanMinutes}`); `null` clears an override. |
| `/api/skill-hub/groups` | GET | User tags + source collections + origin map + drag order (`sourceGroupOrder`/`collectionOrder`). |
| `/api/skill-hub/tag` | POST | Create/rename a tag group. |
| `/api/skill-hub/tag/delete` | POST | Delete a tag group. |
| `/api/skill-hub/tag/members` | POST | Set a tag’s member list. |
| `/api/skill-hub/tag/reorder` | POST | Drag-reorder scenes (`{orderedIds}` — must contain all ids). |
| `/api/skill-hub/collections/reorder` | POST | Drag-reorder source collections (`{orderedNames}`). |
| `/api/skill-hub/source-groups/reorder` | POST | Drag-reorder top-level source groups (`{orderedKeys}` — `project` / `col:<name>` / `uncategorized-source`). |
| `/api/skill-hub/market` | GET | The user’s market source repos. |
| `/api/skill-hub/market/source` | POST | Add a market source (`{repo}`). |
| `/api/skill-hub/market/source/delete` | POST | Remove a market source. |
| `/api/skill-hub/market/source/ref` | POST | Pin a market source to a release/branch ref. |
| `/api/skill-hub/market/check` | GET | Check market sources for newer releases (throttled). |
| `/api/skill-hub/market/source/sync` | POST | Align a market source to its pinned ref; returns tracked skills. |
| `/api/skill-hub/repo?repo=` | GET | Discover importable skills in a GitHub repo (any top-level root auto-derived). |
| `/api/skill-hub/repo/import` | POST | Create an async import job (returns `{jobId, total, totalBytes}`); poll progress below. |
| `/api/skill-hub/repo/import/progress?jobId=` | GET | Poll a running import job (`{status, done, total, downloadedBytes, totalBytes, bytesPerSecond, current, imported, skipped, failed}`). |
| `/api/skill-hub/repo/import/cancel` | POST | Cancel a running import job (`{jobId}`). |
| `/api/skill-hub/sources` | GET | Source records, derived origins/collections, trash. |
| `/api/skill-hub/sources/check` | POST | Check upstream updates (throttled, 5 min). |
| `/api/skill-hub/sources/sync` | POST | Sync selected (or all) skills of a source. |
| `/api/skill-hub/sources/delete` | POST | Follow upstream deletion (moves to trash). |
| `/api/skill-hub/sources/restore` | POST | Restore a trashed skill (re-attaches source + scenes). |
| `/api/skill-hub/sources/trash/clear` | POST | Permanently clear the trash. |
| `/api/skill-hub/update` | GET | Check the plugin’s own latest release. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (174 tests across 9 suites)
npm run build       # tsc declarations + tsdown bundles (lib/index.js + lib/client.js)
npm pack            # build the installable tarball (dsh-skill-hub-<version>.tgz)
```

> **Local testing:** do not run two `dsh web` instances against the same
> `$DSH_HOME` and the same project directory at the same time. dsh rc releases have no
> cross-process session-log lock, and a second instance resuming the same
> session can write duplicate `seq` rows (`corrupt session log: seq gap in
> committed region`). Stop the old instance first, or give the preview its own
> `DSH_HOME`.

The test suites cover the route family (including the config route and the disabled gate), the sidecar
store, skill filesystem operations, the registry provider, and invocation statistics.

## Community

- [Issues](https://github.com/cheshireez/dsh-skill-hub/issues) — bug reports and feature requests.
- [Discussions](https://github.com/cheshireez/dsh-skill-hub/discussions) — Q&A, feedback, and ideas.
- [Showcase @ deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) — announcement posted in the official repository.
- [Plugin market listing](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) — PR to the community market; once merged, install from **Settings → Plugin Market**.
- [DeepSeek Harness Discord](https://discord.gg/Ycq5dCaS4) — official community (primarily Chinese).
- [Contributing](CONTRIBUTING.md) — development setup and contribution guidelines.

## License

MIT — see [LICENSE](LICENSE).

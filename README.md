# dsh-skill-hub

[中文版](README.zh.md) | [English](README.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-skill-hub"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-skill-hub?color=2f81f7&label=npm"></a>
  <img alt="downloads" src="https://img.shields.io/npm/dm/dsh-skill-hub">
  <img alt="license" src="https://img.shields.io/npm/l/dsh-skill-hub">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub.png" alt="dsh-skill-hub panel" width="640">
</p>

In-GUI skill hub for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — browse the full `ctx.skills` catalog, toggle skills, inspect bodies, fix discovery issues, install from the market, and scaffold new ones.

> Host runs in the dsh process via official SDKs only; browser renders through official slots. No dsh source changes.

## Quick start

```bash
dsh plugin --profile web add dsh-skill-hub
# restart dsh web → Settings → 技能 → Market → scan → import
```

Requires `Node ^22.19 || >=24` + dsh web (`0.1.2-alpha.5`, `0.1.x` forward compatible).

## Features

**Settings → 技能** — 3 tabs: **Sources** (skills, flat/grouped + project tree), **Scenes** (custom tag groups), **Market** (install + update).

- **Browse** — every root of the `ctx.skills` registry: project / user / bundled + third-party providers. Search across name, description, `displayName`; filter by source and invocation (model / user); sort by name, added time, or usage. Same-name skills from different sources get a duplicate badge instead of silently hiding.
- **Toggle** — per-skill switches and per-group tri-state switches with a conflict dialog (close all / keep on). Disabling renames the discovery file (never deletes); disabled skills stay inspectable and re-enableable from their detail page. Only `~/.dsh/skills` & `~/.agents/skills` are writable; everything else is read-only.
- **Organize** — scenes (tags) plus auto-aggregated source collections, all drag-reorderable and persisted in `~/.dsh/dsh-skill-hub.json`. Edit mode reveals delete/reorder without cluttering the read view.
- **Diagnose & fix** — files the provider skips (missing frontmatter, bad YAML, name mismatch, short description) show up with reasons; auto-fixable ones (e.g. unquoted `:` in descriptions) get a one-click Fix button.
- **Scaffold** — new-skill wizard writing to `~/.dsh/skills` or `~/.agents/skills` (`SKILL.md` template below).
- **Market** — built-in curated repos plus custom `owner/repo` sources. Any top-level directory containing `SKILL.md` scans as a root (no allowlist). Async import with byte-level progress and cancel. Each source pins a version — click the ref badge to switch between releases, branches, or a custom ref.
- **Track updates** — imported skills record a repo + commit snapshot. Check all / update-all, per-source badges (installed / updatable / deleted upstream / new release). Sync overwrites local edits (with confirm); upstream deletions move into a restorable trash that keeps source and scene membership.
- **Stats** — per-skill call counts + last-used times from session logs (incremental cache), group summaries; window and scan interval live-configurable from the settings card.
- **Settings card** — master switch, announce-to-agent, invocation dot colors, usage display toggles, stats window/interval; plus a self-update check against GitHub releases.

## Why not just the read-only browser?

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) browses, [dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) / [dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) import. **This plugin manages.**

| Capability | read-only browser | **dsh-skill-hub** |
| --- | --- | --- |
| Catalog | user roots, self-scanned | `ctx.skills` registry, all roots + third-party |
| Toggle | ❌ | ✅ per-skill + per-group, never deletes |
| Diagnostics | ❌ | ✅ reasons + one-click fix |
| Market | ❌ | ✅ built-in + custom, version pins, update-all |
| Source tracking | ❌ | ✅ check/sync/trash with restore |
| Stats | ❌ | ✅ counts + last-used |

Scaffold format (`SKILL.md`):

```markdown
---
name: my-skill
description: One line when the agent should use this skill.
---
# my-skill
Body...
```

## How it works

```text
GitHub repo ──scan/import──▶ ~/.dsh/skills
     ▲                          │
     └─check/sync/delete── ctx.skills ◀─ provider
                                │ snapshot/get
                                ▼
                    /api/skill-hub/* ──▶ Panel (Settings → 技能)
```

Host uses only `ctx.skills.snapshot/get`, `ctx.webServer.register`, `ctx.systemPrompt.section`. Loopback-only routes (`127.0.0.1`/`localhost`), JSON.

## HTTP API

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/skill-hub/catalog?cwd=` | GET | skills + disabled + diagnostics + duplicates |
| `/api/skill-hub/skill?name=&cwd=` | GET | skill body (works for disabled too) |
| `/api/skill-hub/skill/delete` | POST | move to trash (snapshots source+scenes) |
| `/api/skill-hub/toggle` | POST | `{name, enabled}` |
| `/api/skill-hub/toggle-batch` | POST | `{names, enabled}` |
| `/api/skill-hub/create` | POST | `{name, description?, root?}` |
| `/api/skill-hub/diagnostic/fix` | POST | `{path}` auto-fix frontmatter |
| `/api/skill-hub/stats` | GET | invocation counts |
| `/api/skill-hub/config` | GET/POST | runtime config (`null` clears) |
| `/api/skill-hub/groups` | GET | tags + collections + orders |
| `/api/skill-hub/tag` etc. | POST | create/rename, delete, set members, reorder |
| `/api/skill-hub/market` etc. | GET/POST | list/add/delete/pin/check/sync sources |
| `/api/skill-hub/market/source/versions?repo=` | GET | releases + branches for the version picker |
| `/api/skill-hub/repo?repo=` | GET | discover (any root) |
| `/api/skill-hub/repo/import` | POST | async job `{jobId, total, totalBytes}` |
| `/api/skill-hub/repo/import/progress?jobId=` | GET | poll job |
| `/api/skill-hub/repo/import/cancel` | POST | cancel job |
| `/api/skill-hub/sources` etc. | GET/POST | list/check/sync/delete/restore/clear trash |
| `/api/skill-hub/update` | GET | plugin latest release |

## Development

```bash
npm run typecheck  # tsc --noEmit
npm test           # 176 tests, 9 suites
npm run build      # tsc + tsdown → lib/index.js + lib/client.js
```

> Don't run two `dsh web` on the same `$DSH_HOME` + cwd — no session-log lock (`seq gap` corruption). Use separate `DSH_HOME`.

## Troubleshooting

- `duplicate loader entry id: skill-hub` — remove the duplicate install (keep one `dsh plugin add` method).
- Skill missing — check the diagnostics section (frontmatter / name mismatch / short description).
- Dots missing in `/` menu — dsh internals changed; catalog still works.

## Community

[Issues](https://github.com/cheshireez/dsh-skill-hub/issues) · [Discussions](https://github.com/cheshireez/dsh-skill-hub/discussions) · [Showcase](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) · [Market PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) · [Discord](https://discord.gg/Ycq5dCaS4)

## License

MIT — [LICENSE](LICENSE).

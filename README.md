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

In-GUI skill hub for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — browse the full `ctx.skills` catalog, toggle skills, inspect bodies, diagnose missing skills, install from the market, and scaffold new ones.

> Host runs in the dsh process via official SDKs only; browser renders through official slots. No dsh source changes.

## Why not just the read-only browser?

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) browses, [dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) / [dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) import. **This plugin is the manager in between.**

| Capability | read-only browser | **dsh-skill-hub** |
| --- | --- | --- |
| Catalog | user roots, self-scanned | `ctx.skills` registry: project / custom / user / bundled + third-party |
| Workspace | ❌ | ✅ `.dsh/skills` & `.agents/skills` (read-only, merged by default) |
| Toggle | ❌ | ✅ rename `SKILL.md` (never delete), tri-state group switches + drag reorder |
| Diagnostics / scaffold | ❌ | ✅ missing frontmatter checks / `~/.dsh/skills` wizard |
| Source tracking | ❌ | ✅ repo + commit, check/sync/trash (restores source & scene) |
| Market | ❌ | ✅ built-in + custom repos, any top-level root, badges + update-all |
| Stats | ❌ | ✅ call counts from session logs (14-day window, incremental cache) |

## Features

- **Catalog** — search + source filter + flat/grouped in one row; groups = scenes (tags) + source collections; workspace tree merged by default.
- **Switches** — per-skill and per-group toggles; conflict dialog (close all / keep on) → mixed state; only `~/.dsh/skills` & `~/.agents/skills` are writable.
- **Reorder & edit** — drag handle on every group header (persists in `~/.dsh/dsh-skill-hub.json`); Edit toggle reveals reorder/delete without cluttering the read view.
- **Market** — unified list (built-in Add → becomes source row); scan any root with `SKILL.md` (no allowlist), async import with `{jobId, totalBytes}` progress & cancel; Check all / Update all (failures non-fatal, daily auto-check).
- **Stats** — per-skill `count` + `lastUsed`, group summaries; configurable window/interval live from the settings card.

## Quick start

```bash
dsh plugin --profile web add dsh-skill-hub
# restart dsh web → Settings → 技能 → Market → scan → import
```

Scaffold format (`SKILL.md`):

```markdown
---
name: my-skill
description: One line when the agent should use this skill.
---
# my-skill
Body...
```

Requires `Node ^22.19 || >=24` + dsh web (`0.1.0-rc.7` / `0.1.1-rc.2`, `0.1.x` forward compatible).

## How it works

```text
GitHub repo ──scan/import──▶ ~/.dsh/skills
     ▲                          │
     └─check/sync/delete── ctx.skills ◀─ provider
                                │ snapshot/get
                                ▼
                    /api/skill-hub/* ──▶ Panel (Settings → 技能)
```

| File | Role |
| --- | --- |
| `src/index.ts` | inject `[webServer, skills, systemPrompt, settings]`, settings namespace, announcement |
| `src/routes.ts` | `/api/skill-hub/*` fences + handlers (async import, reorder) |
| `src/store.ts` | `~/.dsh/dsh-skill-hub.json` v4 (disabled/tags/sources/market/trash/stats/order) |
| `src/repo.ts` | discovery / import / diff (any top-level `SKILL.md`) |
| `src/skillfs.ts` | toggle/trash/scaffold/diagnostics |
| `src/client/` | panel (`useSkillHub` + thin views), CSS Modules |

Host uses only `ctx.skills.snapshot/get`, `ctx.webServer.register`, `ctx.systemPrompt.section`.

## Usage

**Settings → 技能** — 3 tabs: **Sources** (flat/grouped + project tree + drag), **Scenes** (tags, drag), **Market** (unified list). Header workspace field pins to one cwd; trash & diagnostics are always visible.

**Settings → 插件 → Skill Hub** — master switch, announce to agent, dot colors, `showUseCount/showUseTime/showGroupSummary`, stats window (days, default 14, `0`=all) & interval (min, default 5).

## HTTP API

Loopback-only (`127.0.0.1`/`localhost`), JSON.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/skill-hub/catalog?cwd=` | GET | catalog + disabled + diagnostics |
| `/api/skill-hub/skill?name=&cwd=` | GET | skill body |
| `/api/skill-hub/skill/delete` | POST | move to trash (snapshots source+scenes) |
| `/api/skill-hub/toggle` | POST | `{name, enabled}` |
| `/api/skill-hub/toggle-batch` | POST | `{names, enabled}` |
| `/api/skill-hub/create` | POST | `{name, description?, root?}` |
| `/api/skill-hub/stats` | GET | invocation counts |
| `/api/skill-hub/config` | GET/POST | runtime config (`null` clears) |
| `/api/skill-hub/groups` | GET | tags + collections + orders |
| `/api/skill-hub/tag` etc. | POST | create/rename, delete, set members, reorder (`/tag/reorder`, `/collections/reorder`, `/source-groups/reorder`) |
| `/api/skill-hub/market` etc. | GET/POST | list/add/delete/pin/check/sync market sources |
| `/api/skill-hub/repo?repo=` | GET | discover (any root) |
| `/api/skill-hub/repo/import` | POST | async job `{jobId, total, totalBytes}` |
| `/api/skill-hub/repo/import/progress?jobId=` | GET | poll job |
| `/api/skill-hub/repo/import/cancel` | POST | cancel job |
| `/api/skill-hub/sources` etc. | GET/POST | list/check/sync/delete/restore/clear trash |
| `/api/skill-hub/update` | GET | plugin latest release |

## Development

```bash
npm run typecheck  # tsc --noEmit
npm test           # 174 tests, 9 suites
npm run build      # tsc + tsdown → lib/index.js + lib/client.js
```

> Don't run two `dsh web` on the same `$DSH_HOME` + cwd — rc has no session-log lock (`seq gap` corruption). Use separate `DSH_HOME`.

## Troubleshooting

- `duplicate loader entry id: skill-hub` — remove duplicate install (keep one `dsh plugin add` method).
- Skill missing — check diagnostics (frontmatter / name mismatch / short description).
- Dots missing in `/` menu — dsh internals changed; catalog still works.

## Community

[Issues](https://github.com/cheshireez/dsh-skill-hub/issues) · [Discussions](https://github.com/cheshireez/dsh-skill-hub/discussions) · [Showcase](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) · [Market PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) · [Discord](https://discord.gg/Ycq5dCaS4)

## License

MIT — [LICENSE](LICENSE).

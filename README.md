# dsh-skill-hub

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-skill-hub"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-skill-hub?color=2f81f7&label=npm"></a>
  <img alt="license" src="https://img.shields.io/npm/l/dsh-skill-hub">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933">
  <a href="https://github.com/cheshireez/dsh-skill-hub/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/cheshireez/dsh-skill-hub/ci.yml?branch=main"></a>
</p>

<details>
<summary><b>English</b>（英文）— 点击在本页展开 / 收起，无需跳转</summary>

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
| Browse / search | ✅ | ✅ (group by **tags** or by **source repo**, search + filter in one row) |
| Enable / disable | ❌ | ✅ (renames `SKILL.md`; file never deleted, always restorable; per-group tri-state switches) |
| Inspect skill body | ❌ | ✅ |
| Discovery diagnostics | ❌ | ✅ (missing frontmatter / missing `name`/`description` / invalid name — each reason listed) |
| New-skill wizard | ❌ | ✅ (writes to `~/.dsh/skills` or `~/.agents/skills`) |
| Invocation statistics | ❌ | ✅ (per-skill call counts read from session logs; group headers summarize) |
| Upstream source tracking | ❌ | ✅ (repo + commit snapshot; check updates, sync, follow upstream deletion into a restorable trash) |
| Codex-style market | ❌ | ✅ (add repo sources, scan, one-click import — imports are tracked upstream) |
| Live updates | — | filesystem-provider watcher, with a 5s panel poll as fallback |

## Features

- **Full catalog** — every skill the official registry knows: project `.dsh/skills` & `.agents/skills`,
  custom roots, user `~/.dsh/skills` & `~/.agents/skills`, bundled, and third-party providers.
- **Search & grouping** — one row combines search, source filter, and flat/grouped view; groups are
  user **tags** plus **source collections** (auto-aggregated by upstream repo); uncategorized stays visible.
- **Group switches** — every group header carries a sliding switch: enable/disable the whole group in one
  click. Closing a group whose member is also enabled elsewhere opens a conflict dialog (close all / keep on →
  the group falls into a half-filled mixed state). Read-only skills are skipped with per-name reports.
- **Enable / disable** — disable renames `SKILL.md` out of discovery (tracked in a sidecar file), so the
  change survives restarts and is trivially reversible. Files are never deleted.
- **Source tracking** — skills imported from GitHub (market sources or direct URLs) record the repo, ref,
  and upstream commit snapshot. Check for updates per source (1–2 GitHub API requests, 5-minute throttle),
  sync selected skills (overwrite confirm), and follow upstream deletion into a restorable trash.
  Private skills (no source) are never tracked.
- **Market** — codex-style: add a repo source (owner/repo or a GitHub URL), scan its `skills/` and
  `design-templates/` roots, and import with one click; imported skills become tracked sources.
- **Skill detail** — read a skill’s rendered body straight from disk.
- **Discovery diagnostics** — the catalog reports *why* a skill was ignored (missing YAML frontmatter,
  missing `name`/`description`, illegal name), per skill.
- **New-skill wizard** — scaffold a valid skill into `~/.dsh/skills` or `~/.agents/skills` from the GUI.
- **Invocation statistics** — the panel shows how many times each skill was actually called, read from
  session logs (optional; absent session-query deployments simply omit the data).
- **Settings card** — enable the plugin, toggle the agent announcement, and adjust panel display preferences from **Settings → 插件 → Skill Hub**.

## How it works

```text
src/
├── index.ts            host entry: inject [webServer, skills, systemPrompt]; system-prompt announcement
├── routes.ts           /api/skill-hub/{catalog,skill,toggle,toggle-batch,create,stats,config,
│                       groups,tag*,market*,repo*,sources*,update} (loopback-only fence)
├── store.ts            sidecar state ~/.dsh/dsh-skill-hub.json v2 (disabled, tags, sources, market
│                       sources, trash, runtime config; v1→v2 migration drops scenes, origins→sources)
├── repo.ts             GitHub discovery/import + source tracking (latest commit, tree diff, manifest)
├── skillfs.ts          root resolution / toggle rename / trash & restore / scaffold / diagnostics
├── stats.ts            invocation stats: session logs → per-skill call counts (optional sessionQuery)
├── protocol.ts         host ↔ browser shared API contract (types + endpoint table)
└── client/             browser half: settings card + skill hub panel (React, CSS Modules, Apple-style)
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

- **Browse** — the full catalog, searchable; search, source filter, and flat/grouped view share one row.
- **Groups** — user tags and source collections (upstream repos). Group headers carry tri-state sliding
  switches (on / off / mixed) with a conflict dialog when closing affects skills enabled elsewhere.
- **Sources** — import from the market (add a repo source, scan, one-click install) or direct URLs; every
  import records the upstream repo/commit. Use "check updates / sync / follow deletion" per source.
- **Trash** — skills removed after upstream deletion land in a restorable trash.
- **Toggle** — enable/disable any skill from a user-writable root; disabled skills list separately and
  can be re-enabled any time.
- **Diagnose** — the discovery diagnostics explain why a skill is not showing up.
- **New skill** — scaffold a new skill from the form and start writing.
- **Statistics** — per-skill invocation counts when session-query data is available; group headers summarize.

The plugin’s own switches live on the **Settings → 插件 → Skill Hub** card:

| Field | Meaning |
| --- | --- |
| Enable plugin | Master switch: routes, provider, and announcement all go live with this. |
| Announce to agent | Adds a system-prompt section so agents know how to collaborate when users mention skill management. |
| Model / user dot colors | Override the blue/green invocation dot colors used in the panel. |
| Show invocation count | Show per-skill call-count chips when session stats are available. |
| Show last-used time | Show relative last-used time on each skill row. |
| Show source column | Show each skill's source as a row column. |
| Show group summaries | Show count/last-used summaries after group titles. |

## HTTP API

All endpoints are **loopback-only** (`127.0.0.1`/`localhost`) and JSON.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/skill-hub/catalog` | GET | Full catalog: skills, disabled list, discovery diagnostics. |
| `/api/skill-hub/skill?name=` | GET | One skill’s detail (path, provider, body). |
| `/api/skill-hub/toggle` | POST | Enable/disable a writable skill (`{name, enabled}`). |
| `/api/skill-hub/toggle-batch` | POST | Enable/disable a whole group in one write (`{names, enabled}`). |
| `/api/skill-hub/create` | POST | Scaffold a new skill (`{name, description?, root?}`). |
| `/api/skill-hub/stats` | GET | Per-skill invocation counts (unavailable when session-query is absent). |
| `/api/skill-hub/config` | GET/POST | Plugin runtime config (`{enabled, announceToAgent}`); `null` clears an override. |
| `/api/skill-hub/groups` | GET | User tags + source collections + origin map. |
| `/api/skill-hub/tag` | POST | Create/rename a tag group. |
| `/api/skill-hub/tag/delete` | POST | Delete a tag group. |
| `/api/skill-hub/tag/members` | POST | Set a tag’s member list. |
| `/api/skill-hub/market` | GET | The user’s market source repos. |
| `/api/skill-hub/market/source` | POST | Add a market source (`{repo}`). |
| `/api/skill-hub/market/source/delete` | POST | Remove a market source. |
| `/api/skill-hub/repo?repo=` | GET | Discover importable skills in a GitHub repo. |
| `/api/skill-hub/repo/import` | POST | Import selected repo skills (records the source). |
| `/api/skill-hub/sources` | GET | Source records, derived origins/collections, trash. |
| `/api/skill-hub/sources/check` | POST | Check upstream updates (throttled, 5 min). |
| `/api/skill-hub/sources/sync` | POST | Sync selected (or all) skills of a source. |
| `/api/skill-hub/sources/delete` | POST | Follow upstream deletion (moves to trash). |
| `/api/skill-hub/sources/restore` | POST | Restore a trashed skill. |
| `/api/skill-hub/update` | GET | Check the plugin’s own latest release. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (111 tests across 9 suites)
npm run build       # tsc declarations + tsdown bundles (lib/index.js + lib/client.js)
npm pack            # build the installable tarball (dsh-skill-hub-<version>.tgz)
```

> **Local testing:** do not run two `dsh web` instances against the same
> `$DSH_HOME` and the same project directory at the same time. dsh rc.6 has no
> cross-process session-log lock, and a second instance resuming the same
> session can write duplicate `seq` rows (`corrupt session log: seq gap in
> committed region`). Stop the old instance first, or give the preview its own
> `DSH_HOME`.

The test suites cover the route family (including the config route and the disabled gate), the sidecar
store, skill filesystem operations, the registry provider, and invocation statistics.

## Roadmap

- **v0.1.0** — full catalog, enable/disable, diagnostics, new-skill wizard, settings card.
- **v0.2.0** — invocation statistics ✅ · Sets grouping ✅.
- **v0.3.0** — upstream source tracking ✅ (check/sync/follow-delete + trash) · codex-style market ✅ ·
  tri-state group switches with conflict dialogs ✅ · simplified grouping (tags + sources) ✅.
- **v0.4.0** — SSE realtime push to replace polling.

## License

MIT — see [LICENSE](LICENSE).

</details>

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的图形化技能中枢。**
在 dsh Web GUI 里浏览官方 `ctx.skills` 注册表提供的完整本地技能目录，启用/禁用技能、查看正文、
排查技能为什么没出现、并新建技能。

> 一个不止于只读浏览器的技能管理器。宿主半边运行在 dsh 进程内，只使用官方 SDK；浏览器半边通过
> 官方槽位渲染进 GUI。不改任何 dsh 源码。

## 为什么还需要一个技能管理器？

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) 是只读浏览器；
[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) 和
[dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) 专注导入与市场式安装。
**dsh-skill-hub 补上两者之间的空白：一份你可以真正管理的完整目录。**

| 能力 | dsh-skill-manager（只读版） | **dsh-skill-hub（本插件）** |
| --- | --- | --- |
| 目录来源 | 自扫盘，仅用户根 | 官方 `ctx.skills` 注册表：项目 / 自定义 / 用户 / 内置 + 第三方 provider |
| 浏览 / 搜索 | ✅ | ✅（按分组或按来源仓库分组，搜索 + 筛选一行完成） |
| 启用 / 禁用 | ❌ | ✅（重命名 `SKILL.md`；文件不删除，可随时恢复；分组/来源头部滑动开关一键整组启停） |
| 查看技能正文 | ❌ | ✅ |
| 发现诊断 | ❌ | ✅（缺 frontmatter / 缺 `name`/`description` / 非法名称，逐项列明原因） |
| 新建技能向导 | ❌ | ✅（写入 `~/.dsh/skills` 或 `~/.agents/skills`） |
| 触发统计 | ❌ | ✅（从会话日志读每技能实际调用次数；组头汇总） |
| 来源跟踪 | ❌ | ✅（记录上游 repo + commit 快照；检查更新 / 同步 / 上游删除跟进进回收站） |
| 市场（codex 式） | ❌ | ✅（添加仓库源 → 扫描 → 一键导入；导入即受来源跟踪） |
| 实时更新 | — | 文件系统 provider 的 watcher 驱动，面板 5s 轮询兜底 |

## 功能

- **完整目录** —— 官方注册表知道的每个技能：项目 `.dsh/skills` 与 `.agents/skills`、自定义根、
  用户 `~/.dsh/skills` 与 `~/.agents/skills`、内置、以及第三方 provider。
- **搜索与分组** —— 搜索框、来源筛选、平铺/分组视图合并为一行；分组 = 用户 tag + 来源集合（按上游
  仓库自动聚合），未归类兜底可见。
- **组开关（三态）** —— 每个分组头部一个滑动开关，一键启用/禁用整组；关闭时若成员在其他组开启，
  弹窗询问（全部关闭 / 保留开启 → 该组开关进入半开混合态）。只读技能跳过并逐名报告。
- **启用 / 禁用** —— 禁用时把 `SKILL.md` 重命名移出发现范围（记录在 sidecar 文件中），重启后仍然
  生效且可一键恢复。文件从不删除。
- **来源跟踪** —— 从 GitHub 导入（市场源或直接地址）的技能记录上游 repo、分支与 commit 快照；按来源
  检查更新（每来源 1–2 次 GitHub API 请求，5 分钟节流）、选择同步（确认覆盖）、上游删除跟进移入
  可恢复的回收站。私人技能（无来源记录）不跟踪。
- **市场（codex 式）** —— 添加仓库源（owner/repo 或 GitHub 链接），扫描 `skills/` 与
  `design-templates/` 根目录，一键导入；导入的技能自动成为受跟踪来源。
- **技能详情** —— 直接从磁盘读取技能的渲染正文。
- **发现诊断** —— 目录会逐项报告技能被忽略的原因（缺 YAML frontmatter、缺 `name`/`description`、
  非法名称）。
- **新建技能向导** —— 在 GUI 里把合法技能脚手架写入 `~/.dsh/skills` 或 `~/.agents/skills`。
- **触发统计** —— 面板显示每个技能被实际调用的次数，数据来自会话日志（可选；没有 session-query
  的部署直接省略该数据）。
- **设置卡片** —— 在 **设置 → 插件 → Skill Hub** 启用插件、开关向 Agent 的公告、调整面板显示偏好。

## 工作原理

```text
src/
├── index.ts            host 入口：inject [webServer, skills, systemPrompt]；系统提示公告
├── routes.ts           /api/skill-hub/{catalog,skill,toggle,toggle-batch,create,stats,config,
│                       groups,tag*,market*,repo*,sources*,update}（仅回环访问）
├── store.ts            sidecar 状态 v2 ~/.dsh/dsh-skill-hub.json（禁用、tag、sources、市场源、
│                       回收站、运行时配置；v1→v2 迁移丢弃 scenes，origins→sources）
├── repo.ts             GitHub 发现/导入 + 来源跟踪（最新 commit、tree 差异、manifest）
├── skillfs.ts          根目录解析 / 开关重命名 / 回收站 & 恢复 / 脚手架 / 诊断扫描
├── stats.ts            触发统计：会话日志 → 每技能调用次数（可选 sessionQuery）
├── protocol.ts         host ↔ browser 共享 API 契约（类型 + 端点表）
└── client/             browser 半边：设置卡片 + 技能中枢面板（React，CSS Modules，苹果风）
```

- **宿主半边** 只用官方 SDK：`ctx.skills.snapshot()/get()`、`ctx.webServer.register()`、
  `ctx.systemPrompt.section()`。不修改 dsh 源码。
- **浏览器半边** 通过官方槽位挂载：一个 **设置 → 技能** 分区，和一个
  **设置 → 插件 → Skill Hub** 配置卡片。
- **配置为插件自有**。宿主 settings 服务拒绝向 Web 客户端暴露第三方命名空间，因此设置卡片读写插件
  自己的 `/api/skill-hub/config` 路由，而不走 settings 传输——无需挂载命名空间。

## 安装

在 dsh web profile 中：

```bash
dsh plugin --profile web add dsh-skill-hub
```

要求 Node `^22.19.0 || >=24.0.0` 与 dsh web 部署（`0.1.0-rc.6` SDK 家族）。

## 使用

在 dsh Web GUI 打开 **设置 → 技能**（Skill Hub）：

- **浏览** —— 完整目录，可搜索，按来源或 Sets 分组。
- **开关** —— 启用/禁用任意用户可写根下的技能；被禁用的技能单独列出，可随时重新启用。
- **诊断** —— 发现诊断解释某个技能为什么没有出现。
- **新建** —— 从表单脚手架一个新技能，立即开始编写。
- **统计** —— 有 session-query 数据时显示每个技能的调用次数。

插件自身的开关在 **设置 → 插件 → Skill Hub** 卡片上：

| 字段 | 含义 |
| --- | --- |
| Enable plugin | 总开关：路由、provider 与公告随之启用。 |
| Announce to agent | 在系统提示中加入本插件说明，用户提到技能管理时 Agent 知道如何协作。 |
| 模型/用户圆点颜色 | 覆盖面板中蓝色/绿色调用圆点的颜色。 |
| 显示调用次数 | 有会话统计时显示每个技能的调用次数角标。 |
| 显示最近调用时间 | 在技能行显示相对最近调用时间。 |
| 显示来源列 | 在每行显示技能来源列。 |
| 显示分组汇总 | 在分组标题后汇总调用次数与最近调用时间。 |

## HTTP API

所有端点**仅限回环**（`127.0.0.1`/`localhost`），返回 JSON。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/api/skill-hub/catalog` | GET | 完整目录：技能、禁用列表、发现诊断、Sets。 |
| `/api/skill-hub/skill?name=` | GET | 单个技能详情（路径、provider、正文）。 |
| `/api/skill-hub/toggle` | POST | 启用/禁用可写技能（`{name, enabled}`）。 |
| `/api/skill-hub/create` | POST | 脚手架新技能（`{name, description?, root?}`）。 |
| `/api/skill-hub/stats` | GET | 每技能调用次数（无 session-query 时不可用）。 |
| `/api/skill-hub/config` | GET/POST | 插件运行时配置（`{enabled, announceToAgent}`）；`null` 清除覆盖。 |

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest（9 个套件，110 个用例）
npm run build       # tsc 声明 + tsdown 双半边产物（lib/index.js + lib/client.js）
npm pack            # 生成可安装的 tgz（dsh-skill-hub-<version>.tgz）
```

> **本地联调注意：** 不要在同一 `$DSH_HOME` 和同一项目目录下同时运行两个
> `dsh web` 实例。dsh rc.6 没有跨进程会话日志锁，第二个实例恢复同一会话时会
> 写入重复 `seq`，导致 `corrupt session log: seq gap in committed region`。
> 需要预览实例时先停旧实例，或使用独立的 `DSH_HOME`。

测试套件覆盖路由家族（含 config 路由与禁用闸门）、sidecar 存储、技能文件系统操作、注册表
provider 与触发统计。

## 路线图

- **v0.1.0** —— 完整目录、启用/禁用、诊断、新建向导、设置卡片。
- **v0.2.0** —— 触发统计 ✅ · Sets 分组 ✅ · 回收站删除（待做）。
- **v0.3.0** —— SSE 实时推送替代轮询。

## License

MIT —— 见 [LICENSE](LICENSE)。

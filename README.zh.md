# dsh-skill-hub

[English](README.md) | [中文版](README.zh.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-skill-hub"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-skill-hub?color=2f81f7&label=npm"></a>
  <img alt="downloads" src="https://img.shields.io/npm/dm/dsh-skill-hub">
  <img alt="license" src="https://img.shields.io/npm/l/dsh-skill-hub">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub.png" alt="dsh-skill-hub 面板" width="640">
</p>

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的图形化技能中枢 — 在 Web GUI 里浏览 `ctx.skills` 全量目录，开关技能、查看正文、修复发现问题、从市场安装、一键新建。

> 宿主只用官方 SDK，浏览器通过官方槽位渲染，不改 dsh 源码。

## 快速开始

```bash
dsh plugin --profile web add dsh-skill-hub
# 重启 dsh web → 设置 → 技能 → 市场 → 扫描 → 导入
```

要求 `Node ^22.19 || >=24` + dsh web（`0.1.2-alpha.5`，兼容后续 `0.1.x`）。

## 功能

**设置 → 技能** — 3 个 tab：**来源**（技能，平铺/分组+项目树）、**场景**（自定义分组）、**市场**（安装与更新）。

- **浏览** — `ctx.skills` 注册表全量：项目/用户/内置+第三方。按名称、描述、`displayName` 搜索；按来源、按调用方式（模型/用户）筛选；按名称/添加时间/调用次数排序。不同来源的同名技能挂重名徽标，不再静默隐藏。
- **开关** — 单技能开关 + 整组三态开关，跨组冲突弹窗（全部关闭/保留开启）。禁用只重命名发现文件（不删除）；禁用的技能仍可查看正文、可一键重新启用。仅 `~/.dsh/skills` 与 `~/.agents/skills` 可写，其余只读。
- **整理** — 场景（tag）+ 自动聚合的来源集合，全部可拖拽排序并持久化到 `~/.dsh/dsh-skill-hub.json`。编辑模式收敛删除/排序控件，阅读视图保持干净。
- **诊断与修复** — provider 跳过的文件给出原因（缺 frontmatter、YAML 非法、名称不一致、描述过短）；可自动修复的（如描述里未加引号的 `:`）一键 Fix 落盘。
- **新建** — 新技能向导，写入 `~/.dsh/skills` 或 `~/.agents/skills`（`SKILL.md` 模板见下）。
- **市场** — 内置精选仓库 + 自定义 `owner/repo`。任何含 `SKILL.md` 的顶层目录都可扫描（无白名单）。异步导入，字节级进度+取消。每个源钉一个版本 —— 点 ref 徽标可在发布版/分支/手输之间切换。
- **跟踪更新** — 导入的技能记录 repo+commit 快照。检查全部/一键全更；每源徽章（已装/可更新/上游已删/新版本）。同步覆盖本地修改（先确认）；上游删除跟进移入回收站，恢复保留来源与场景归属。
- **统计** — 会话日志的调用次数+最近使用，分组头汇总；窗口与扫描间隔在设置卡片实时可调。
- **设置卡片** — 总开关、向 Agent 公告、调用圆点颜色、用量显示开关、统计窗口/间隔；附带插件自更新检查（对 GitHub releases）。

## 为什么还需要一个管理器？

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) 只读浏览，[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) / [dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) 只做导入。**本插件负责管理。**

| 能力 | 只读浏览器 | **dsh-skill-hub** |
| --- | --- | --- |
| 目录 | 自扫盘、仅用户根 | `ctx.skills` 全量+第三方 |
| 开关 | ❌ | ✅ 单技能+整组，从不删除 |
| 诊断 | ❌ | ✅ 原因+一键修复 |
| 市场 | ❌ | ✅ 内置+自定义，版本钉选，一键全更 |
| 来源跟踪 | ❌ | ✅ 检查/同步/回收站可恢复 |
| 统计 | ❌ | ✅ 次数+最近使用 |

`SKILL.md` 模板：

```markdown
---
name: my-skill
description: 一句话说明何时使用。
---
# my-skill
正文...
```

## 工作原理

```text
GitHub 仓库 ──扫描/导入──▶ ~/.dsh/skills
     ▲                        │
     └─检查/同步/删除── ctx.skills ◀─ provider
                              │ snapshot/get
                              ▼
                  /api/skill-hub/* ──▶ 面板（设置 → 技能）
```

宿主仅用 `ctx.skills.snapshot/get`、`ctx.webServer.register`、`ctx.systemPrompt.section`。路由仅回环（`127.0.0.1`/`localhost`），JSON。

## HTTP API

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/api/skill-hub/catalog?cwd=` | GET | 技能+禁用+诊断+重名 |
| `/api/skill-hub/skill?name=&cwd=` | GET | 技能正文（禁用的也可） |
| `/api/skill-hub/skill/delete` | POST | 移入回收站（快照来源+场景） |
| `/api/skill-hub/toggle` | POST | `{name, enabled}` |
| `/api/skill-hub/toggle-batch` | POST | `{names, enabled}` |
| `/api/skill-hub/create` | POST | `{name, description?, root?}` |
| `/api/skill-hub/diagnostic/fix` | POST | `{path}` 自动修 frontmatter |
| `/api/skill-hub/stats` | GET | 调用次数 |
| `/api/skill-hub/config` | GET/POST | 运行时配置（`null` 清除） |
| `/api/skill-hub/groups` | GET | tags+集合+排序 |
| `/api/skill-hub/tag` 等 | POST | 新建/重命名、删除、设成员、排序 |
| `/api/skill-hub/market` 等 | GET/POST | 市场源 列表/添加/删除/钉 ref/检查/同步 |
| `/api/skill-hub/market/source/versions?repo=` | GET | 版本选择器的 releases+branches |
| `/api/skill-hub/repo?repo=` | GET | 发现（任意根） |
| `/api/skill-hub/repo/import` | POST | 异步任务 `{jobId, total, totalBytes}` |
| `/api/skill-hub/repo/import/progress?jobId=` | GET | 轮询进度 |
| `/api/skill-hub/repo/import/cancel` | POST | 取消任务 |
| `/api/skill-hub/sources` 等 | GET/POST | 来源 列表/检查/同步/删除/恢复/清空回收站 |
| `/api/skill-hub/update` | GET | 插件最新发布 |

## 开发

```bash
npm run typecheck  # tsc --noEmit
npm test           # 176 tests, 9 suites
npm run build      # tsc + tsdown → lib/index.js + lib/client.js
```

> 同一 `$DSH_HOME` + cwd 下勿开两个 `dsh web` — 无会话日志锁，会 `seq gap` 损坏。换 `DSH_HOME` 或先关旧实例。

## 故障排查

- `duplicate loader entry id: skill-hub` — 删掉重复安装（只留一种 `dsh plugin add`）。
- 技能不出现 — 看诊断区（缺 frontmatter / 名称不一致 / 描述过短）。
- `/` 菜单圆点消失 — dsh 内部触发源变更，目录功能不受影响。

## 社区

[Issues](https://github.com/cheshireez/dsh-skill-hub/issues) · [讨论区](https://github.com/cheshireez/dsh-skill-hub/discussions) · [官方展示](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) · [市场收录 PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) · [Discord](https://discord.gg/Ycq5dCaS4)

## License

MIT — [LICENSE](LICENSE).

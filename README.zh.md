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

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的图形化技能中枢 — 在 Web GUI 里浏览 `ctx.skills` 全量目录，开关技能、查看正文、诊断缺失、从市场安装、一键新建。

> 宿主只用官方 SDK，浏览器通过官方槽位渲染，不改 dsh 源码。

## 为什么还需要一个管理器？

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) 只读浏览，[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) / [dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) 只做导入。**本插件是可管理的全量目录。**

| 能力 | 只读浏览器 | **dsh-skill-hub** |
| --- | --- | --- |
| 目录 | 自扫盘、仅用户根 | `ctx.skills`：项目/自定义/用户/内置 + 第三方 |
| 工作区 | ❌ | ✅ `.dsh/skills` & `.agents/skills`（默认合并，只读） |
| 开关 | ❌ | ✅ 重命名 `SKILL.md`（不删除），分组三态开关 + 拖拽排序 |
| 诊断/新建 | ❌ | ✅ frontmatter 诊断 / `~/.dsh/skills` 向导 |
| 来源跟踪 | ❌ | ✅ repo+commit，检查/同步/回收站（恢复保留来源与场景） |
| 市场 | ❌ | ✅ 内置+自定义，任意顶层根目录，徽章+一键全更 |
| 统计 | ❌ | ✅ 会话日志调用次数（14 天窗口，增量缓存） |

## 功能

- **目录** — 搜索+来源筛选+平铺/分组一行完成；分组=场景（tag）+ 来源集合；工作区默认合并为项目树。
- **开关** — 单技能/整组开关；冲突弹窗（全部关闭/保留开启→半开态）；仅 `~/.dsh/skills` & `~/.agents/skills` 可写。
- **排序与编辑** — 分组头拖拽手柄（持久化到 `~/.dsh/dsh-skill-hub.json`）；编辑开关收敛排序/删除控件。
- **市场** — 统一列表（内置 Add → 变来源行）；任意含 `SKILL.md` 的顶层目录视为根（无白名单），异步导入 `{jobId, totalBytes}` 轮询+取消；检查全部/全部更新（单源失败不影响全局，每日自动检查一次）。
- **统计** — 每技能 `count` + `lastUsed`，分组头汇总；窗口/间隔在设置卡片实时可调。

## 快速开始

```bash
dsh plugin --profile web add dsh-skill-hub
# 重启 dsh web → 设置 → 技能 → 市场 → 扫描 → 导入
```

`SKILL.md` 模板：

```markdown
---
name: my-skill
description: 一句话说明何时使用。
---
# my-skill
正文...
```

要求 `Node ^22.19 || >=24` + dsh web（`0.1.0-rc.7` / `0.1.1-rc.2`，兼容后续 `0.1.x`）。

## 工作原理

```text
GitHub 仓库 ──扫描/导入──▶ ~/.dsh/skills
     ▲                        │
     └─检查/同步/删除── ctx.skills ◀─ provider
                              │ snapshot/get
                              ▼
                  /api/skill-hub/* ──▶ 面板（设置 → 技能）
```

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | inject `[webServer, skills, systemPrompt, settings]`，设置命名空间，公告 |
| `src/routes.ts` | `/api/skill-hub/*` 围栏+处理（异步导入、拖拽排序） |
| `src/store.ts` | `~/.dsh/dsh-skill-hub.json` v4（禁用/tags/sources/market/trash/统计/排序） |
| `src/repo.ts` | 发现/导入/比对（任意顶层 `SKILL.md`） |
| `src/skillfs.ts` | 开关/回收站/脚手架/诊断 |
| `src/client/` | 面板（`useSkillHub` + 薄视图），CSS Modules |

宿主仅用 `ctx.skills.snapshot/get`、`ctx.webServer.register`、`ctx.systemPrompt.section`。

## 使用

**设置 → 技能** — 三个 tab：**来源**（平铺/分组+项目树+拖拽）、**场景**（tag，分组开关+拖拽）、**市场**（统一列表）。顶部工作区路径可固定到单个 cwd；回收站与诊断常驻。

**设置 → 插件 → Skill Hub** — 总开关、向 Agent 公告、圆点颜色、`show*` 三开关、统计窗口（天，默认 14，`0`=全部）与间隔（分钟，默认 5）。

## HTTP API

仅回环（`127.0.0.1`/`localhost`），JSON。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/api/skill-hub/catalog?cwd=` | GET | 目录+禁用+诊断 |
| `/api/skill-hub/skill?name=&cwd=` | GET | 技能正文 |
| `/api/skill-hub/skill/delete` | POST | 移入回收站（快照来源+场景） |
| `/api/skill-hub/toggle` | POST | `{name, enabled}` |
| `/api/skill-hub/toggle-batch` | POST | `{names, enabled}` |
| `/api/skill-hub/create` | POST | `{name, description?, root?}` |
| `/api/skill-hub/stats` | GET | 调用次数 |
| `/api/skill-hub/config` | GET/POST | 运行时配置（`null` 清除） |
| `/api/skill-hub/groups` | GET | tags+集合+排序 |
| `/api/skill-hub/tag` 等 | POST | 新建/重命名、删除、设成员、排序（`/tag/reorder`、`/collections/reorder`、`/source-groups/reorder`） |
| `/api/skill-hub/market` 等 | GET/POST | 市场源 列表/添加/删除/钉 ref/检查/同步 |
| `/api/skill-hub/repo?repo=` | GET | 发现（任意根） |
| `/api/skill-hub/repo/import` | POST | 异步任务 `{jobId, total, totalBytes}` |
| `/api/skill-hub/repo/import/progress?jobId=` | GET | 轮询进度 |
| `/api/skill-hub/repo/import/cancel` | POST | 取消任务 |
| `/api/skill-hub/sources` 等 | GET/POST | 来源 列表/检查/同步/删除/恢复/清空回收站 |
| `/api/skill-hub/update` | GET | 插件最新发布 |

## 开发

```bash
npm run typecheck  # tsc --noEmit
npm test           # 174 tests, 9 suites
npm run build      # tsc + tsdown → lib/index.js + lib/client.js
```

> 同一 `$DSH_HOME` + cwd 下勿开两个 `dsh web` — rc 无会话日志锁，会 `seq gap` 损坏。换 `DSH_HOME` 或先关旧实例。

## 故障排查

- `duplicate loader entry id: skill-hub` — 删掉重复安装（只留一种 `dsh plugin add`）。
- 技能不出现 — 看诊断（缺 frontmatter / 名称不一致 / 描述过短）。
- `/` 菜单圆点消失 — dsh 内部触发源变更，目录功能不受影响。

## 社区

[Issues](https://github.com/cheshireez/dsh-skill-hub/issues) · [讨论区](https://github.com/cheshireez/dsh-skill-hub/discussions) · [官方展示](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) · [市场收录 PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) · [Discord](https://discord.gg/Ycq5dCaS4)

## License

MIT — [LICENSE](LICENSE).

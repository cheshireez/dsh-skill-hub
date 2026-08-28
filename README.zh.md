# dsh-skill-hub

[English](README.md) | [中文版](README.zh.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-skill-hub"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-skill-hub?color=2f81f7&label=npm"></a>
  <img alt="downloads" src="https://img.shields.io/npm/dm/dsh-skill-hub">
  <img alt="license" src="https://img.shields.io/npm/l/dsh-skill-hub">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933">
  <a href="https://github.com/cheshireez/dsh-skill-hub/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/cheshireez/dsh-skill-hub/ci.yml?branch=main"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub.png" alt="dsh-skill-hub 面板" width="640">
</p>

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的图形化技能中枢。**
在 dsh Web GUI 里浏览官方 `ctx.skills` 注册表提供的完整本地技能目录，启用/禁用技能、查看正文、
排查技能为什么没出现、从内置市场安装新技能、并新建技能。

> 一个不止于只读浏览器的技能管理器。宿主半边运行在 dsh 进程内，只使用官方 SDK；浏览器半边通过
> 官方槽位渲染进 GUI。不改任何 dsh 源码。

> **免责声明** —— 来源跟踪、市场同步、可恢复回收站均为本插件实现，并非 dsh 运行时自身的能力
> 保证；界面截图可能滞后于最新版本。

## 目录

- [为什么还需要一个技能管理器？](#为什么还需要一个技能管理器)
- [功能](#功能)
- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [使用](#使用)
- [故障排查](#故障排查)
- [HTTP API](#http-api)
- [开发](#开发)
- [社区](#社区)
- [License](#license)

## 为什么还需要一个技能管理器？

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager) 是只读浏览器；
[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) 和
[dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) 专注导入与市场式安装。
**dsh-skill-hub 补上两者之间的空白：一份你可以真正管理的完整目录。**

| 能力 | dsh-skill-manager（只读版） | **dsh-skill-hub（本插件）** |
| --- | --- | --- |
| 目录来源 | 自扫盘，仅用户根 | 官方 `ctx.skills` 注册表：项目 / 自定义 / 用户 / 内置 + 第三方 provider |
| 浏览 / 搜索 | ✅ | ✅（按场景分组或按来源仓库分组，搜索 + 筛选一行完成） |
| 工作区技能 | ❌ | ✅（填写项目路径 → 该项目 `.dsh/skills` 与 `.agents/skills` 的技能只读可见） |
| 启用 / 禁用 | ❌ | ✅（重命名 `SKILL.md`；文件不删除，可随时恢复；分组/来源头部滑动开关一键整组启停） |
| 查看技能正文 | ❌ | ✅ |
| 发现诊断 | ❌ | ✅（缺 frontmatter / 缺 `name`/`description` / 非法名称，逐项列明原因） |
| 新建技能向导 | ❌ | ✅（写入 `~/.dsh/skills` 或 `~/.agents/skills`） |
| 触发统计 | ❌ | ✅（从会话日志读每技能实际调用次数；组头汇总） |
| 来源跟踪 | ❌ | ✅（记录上游 repo + commit 快照；检查更新 / 同步 / 上游删除跟进进回收站；删除→恢复保留来源与场景归属） |
| 市场 | ❌ | ✅（统一市场列表：内置精选目录 + 自定义仓库；扫描、一键导入、每源显示已装/可更新数量、一键全部更新） |
| 实时更新 | — | 文件系统 provider 的 watcher 驱动，面板 5s 轮询兜底 |

## 功能

### 目录与开关 —— 管理本地技能

> **看得见全部，改得了自己拥有的。** 完整注册表可见可搜；写操作只落在用户级根目录，且从不删除文件。

- **完整目录** —— 官方注册表知道的每个技能：项目 `.dsh/skills` 与 `.agents/skills`、自定义根、
  用户 `~/.dsh/skills` 与 `~/.agents/skills`、内置、以及第三方 provider。
- **搜索与分组** —— 搜索框、来源筛选、平铺/分组视图合并为一行；分组 = 用户 tag（场景）+ 来源
  集合（按上游仓库自动聚合），未归类兜底可见。
- **工作区发现** —— 已知工作区（来自 dsh 的工作区注册表）默认合并进目录，并按「项目级」三级树
  分组（每个项目可选细分 `.dsh` / `.agents`）；面板顶部的路径输入框可以把视图固定到单个工作区。
- **组开关（三态）** —— 每个分组头部一个滑动开关，一键启用/禁用整组；关闭时若成员在其他组开启，
  弹窗询问（全部关闭 / 保留开启 → 该组开关进入半开混合态）。只读技能跳过并逐名报告。
- **启用 / 禁用** —— 禁用时把 `SKILL.md` 重命名移出发现范围（记录在 sidecar 文件中），重启后
  仍然生效且可一键恢复。文件从不删除。
- **技能详情** —— 直接从磁盘读取技能正文，并附来源卡片（仓库、commit、检查 / 同步 / 跟进删除）。
- **新建技能向导** —— 在 GUI 里把合法技能脚手架写入 `~/.dsh/skills` 或 `~/.agents/skills`。

### 市场与更新

> **加一个仓库，一键安装，从此自动跟进更新。** 导入即受来源跟踪；更新按来源聚合展示，可一次全部应用。

- **统一市场列表** —— 市场 tab 只有一张列表：内置精选目录的条目在未添加时显示简介 + 「添加」
  按钮；已添加的（以及手动输入的自定义源）同一行变成完整状态行，不会出现重复条目。
- **扫描 → 安装** —— 扫描任意仓库的 `skills/` 与 `design-templates/` 根目录，勾选要装的技能，
  一键导入；导入自动记录上游 repo/commit。
- **状态徽章** —— 每个来源行聚合显示：已装 N / 可更新 N / 上游已删 N。
- **检查全部 / 全部更新** —— 「检查全部」一次刷新所有来源（版本 + 技能差异）；「全部更新」一次
  同步所有待更新来源（单个来源失败不影响其他，汇总报告）。打开面板时每天最多自动检查一次
  （localStorage 记时间戳），手动按钮永不受节流限制。
- **来源跟踪** —— 按来源检查更新（每来源 1–2 次 GitHub API 请求，服务端 5 分钟节流）、选择同步
  （确认覆盖）、上游删除跟进移入可恢复的回收站。删除后再恢复的技能保留来源与场景归属（回收站
  条目存有快照）。个人技能（无来源记录）不跟踪。
- **自身更新检查** —— 面板头部可检查插件自己的 GitHub 最新发布。

### 统计与诊断

> **知道你的 Agent 到底在用什么。** 调用次数来自你自己的会话日志——没有任何数据离开本机。

- **触发统计** —— 从会话日志读每个技能的实际调用次数与最近使用时间（可选；没有 session-query
  的部署直接省略）；分组标题汇总。
- **发现诊断** —— 目录逐项报告技能被忽略的原因（缺 YAML frontmatter、缺 `name`/`description`、
  非法名称）。
- **设置卡片** —— 在 **设置 → 插件 → Skill Hub** 启用插件、开关向 Agent 的公告、调整面板显示偏好。

## 快速开始

```bash
dsh plugin --profile web add dsh-skill-hub
```

重启 `dsh web`，打开 **设置 → 技能**，在**市场** tab 从内置目录挑一个仓库（或粘贴
`owner/repo`），扫描、勾选、导入。从此该来源自动受跟踪：检查更新、一键同步。

技能本质就是一个带 `SKILL.md` 的目录——面板也可以直接帮你脚手架一个：

```markdown
---
name: my-skill
description: 一句话说明什么时候该用这个技能。
---
# my-skill

技能做什么、什么时候用、期望输出什么。
```

要求 Node `^22.19.0 || >=24.0.0` 与 dsh web 部署（兼容 `0.1.0-rc.7` / `0.1.1-rc.2` SDK 家族，peer 范围同时覆盖两者及后续 `0.1.x` 线路）。

## 工作原理

```text
 GitHub 仓库 ──扫描 / 导入──▶ ~/.dsh/skills（用户级）
      ▲                            │
      │ 检查 / 同步 / 跟进删除      ▼
      │                ctx.skills 注册表 ◀── skill-hub provider（注册用户级 + 项目级根目录）
      │                            │ snapshot / get
      └────── 每天自动检查一次     ▼
                      /api/skill-hub/* 路由 ──▶ 浏览器面板（设置 → 技能）
```

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | host 入口：inject `[webServer, skills, systemPrompt, settings]`；注册 `dsh-skill-hub` 设置命名空间；系统提示公告 |
| `src/routes.ts` | 声明式 route 包装：`/api/skill-hub/*`（回环 / 方法 / 总开关 / JSON 体四道围栏统一处理一次，路由只写业务逻辑） |
| `src/store.ts` | sidecar 状态 `~/.dsh/dsh-skill-hub.json` v3（禁用、tag、sources、市场源、回收站；v1→v2→v3 版本化迁移） |
| `src/repo.ts` | GitHub 发现/导入 + 来源跟踪（最新 commit、tree 差异、manifest） |
| `src/skillfs.ts` | 根目录解析 / 开关重命名 / 回收站 & 恢复 / 脚手架 / 诊断扫描 |
| `src/stats.ts` | 触发统计：会话日志 → 每技能调用次数（可选 sessionQuery） |
| `src/protocol.ts` | host ↔ browser 共享 API 契约（类型 + 端点表） |
| `src/client/` | browser 半边：设置卡片 + 技能中枢面板。状态与流程收敛在 `useSkillHub.ts`；视图是薄组件（`SourcesView` / `ScenesView` / `MarketView` / `SkillRow` / dialogs / …）。CSS Modules，苹果风 |

- **宿主半边** 只用官方 SDK：`ctx.skills.snapshot()/get()`、`ctx.webServer.register()`、
  `ctx.systemPrompt.section()`。不修改 dsh 源码。
- **浏览器半边** 通过官方槽位挂载：一个 **设置 → 技能** 分区，和一个
  **设置 → 插件 → Skill Hub** 配置卡片。
- **配置为 dsh 原生化**。rc.7 起宿主把每个已注册的设置命名空间都提供给 Web 客户端（旧的命名空间
  白名单已移除），因此插件注册 `dsh-skill-hub` 设置命名空间，卡片经官方 settings 传输读写它——
  可配置插件列表按命名空间分发卡片，宿主消费同一份解析后的值（单一事实来源）。
  从旧版 sidecar 配置升级的安装会把已保存的配置一次性迁移进该命名空间。

## 使用

在 dsh Web GUI 打开 **设置 → 技能**（Skill Hub），三个 tab：

- **来源** —— 技能列表，平铺或分组：项目级三级树（默认合并所有工作区，每项目可选细分
  `.dsh`/`.agents`）+ 来源集合 + 未归类。搜索、来源筛选、排序共用一行；分组头部有三态开关，
  来源组的徽章兼作重新检查入口。（见本页顶部截图）
- **场景** —— 你自己的启用/禁用单元（比如「Godot 开发」和「Java 开发」各一个场景）：新建 tag、
  勾选成员，一键整场景开关。

  <p align="center">
    <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub-scenes.png" alt="场景 tab" width="560">
  </p>
- **市场** —— 一张统一列表：内置精选仓库（未添加时显示「添加」）+ 你的自定义源；扫描安装、
  检查更新、一键全部更新。

  <p align="center">
    <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-hub/main/promo/real-skill-hub-catalog.png" alt="市场 tab" width="560">
  </p>

各 tab 通用：顶部**工作区路径**输入框（看项目级只读技能）、**回收站**区（可恢复，恢复时挂回
来源与场景）、**发现诊断**区（技能为什么没出现）、**新建技能**表单。

插件自身的开关在 **设置 → 插件 → Skill Hub** 卡片上：

| 字段 | 含义 |
| --- | --- |
| Enable plugin | 总开关：路由、provider 与公告随之启用。 |
| Announce to agent | 在系统提示中加入本插件说明，用户提到技能管理时 Agent 知道如何协作。 |
| 模型/用户圆点颜色 | 覆盖技能面板与聊天 `/` 菜单中单个状态圆点的颜色（蓝 = 模型可调，绿 = 仅用户可调）。 |
| 显示调用次数 | 有会话统计时显示每个技能的调用次数角标。 |
| 显示最近调用时间 | 在技能行显示相对最近调用时间。 |
| 显示分组汇总 | 在分组标题后汇总调用次数与最近调用时间。 |

## 故障排查

- **⚠️ `duplicate loader entry id: skill-hub`** —— 插件被挂载了两份（例如既 `dsh plugin add` 又
  本地 `file:` 安装）。只保留一种安装方式；升级时用替换而不是再装一份。
- **技能没出现在目录里** —— 看「发现诊断」区：缺 frontmatter、目录名与 frontmatter 名称不匹配、
  描述过短，都会逐条列出原因。
- **更新检查没有结果** —— 服务端每来源 5 分钟节流，面板每天自动检查一次；手动按钮永不受限。
- **只读边界** —— 仅用户级技能（`~/.dsh/skills`、`~/.agents/skills`）可写；项目、内置、运行时
  技能只读展示。
- **聊天 `/` 菜单的状态圆点依赖 dsh 内部注册表** —— 圆点通过包装核心 `/skill` 触发源的
  候选渲染；若 dsh 升级改变了这部分内部形状，圆点会静默消失，但技能列表与 `/` 菜单功能不受影响。
  已知限制，非缺陷：为可移植性而有意为之，不影响技能管理本身。

## HTTP API

所有端点**仅限回环**（`127.0.0.1`/`localhost`），返回 JSON。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/api/skill-hub/catalog?cwd=` | GET | 完整目录：技能、禁用列表、发现诊断（`cwd` 附带项目技能）。 |
| `/api/skill-hub/skill?name=&cwd=` | GET | 单个技能详情（路径、provider、正文）。 |
| `/api/skill-hub/skill/delete` | POST | 把技能移入可恢复回收站（快照来源与场景）。 |
| `/api/skill-hub/toggle` | POST | 启用/禁用可写技能（`{name, enabled}`）。 |
| `/api/skill-hub/toggle-batch` | POST | 一次写入整组启停（`{names, enabled}`）。 |
| `/api/skill-hub/create` | POST | 脚手架新技能（`{name, description?, root?}`）。 |
| `/api/skill-hub/stats` | GET | 每技能调用次数（无 session-query 时不可用）。 |
| `/api/skill-hub/config` | GET/POST | 插件运行时配置（`{enabled, announceToAgent}` 等）；`null` 清除覆盖。 |
| `/api/skill-hub/groups` | GET | 用户标签 + 来源组 + origin 映射。 |
| `/api/skill-hub/tag` | POST | 新建/重命名标签分组。 |
| `/api/skill-hub/tag/delete` | POST | 删除标签分组。 |
| `/api/skill-hub/tag/members` | POST | 设置某标签的成员列表。 |
| `/api/skill-hub/market` | GET | 用户的市场源仓库列表。 |
| `/api/skill-hub/market/source` | POST | 添加市场源（`{repo}`）。 |
| `/api/skill-hub/market/source/delete` | POST | 移除市场源。 |
| `/api/skill-hub/market/source/ref` | POST | 把市场源固定到某个 release/分支。 |
| `/api/skill-hub/market/check` | GET | 检查市场源是否有新版本（节流）。 |
| `/api/skill-hub/market/source/sync` | POST | 市场源版本对齐，返回该源跟踪的技能。 |
| `/api/skill-hub/repo?repo=` | GET | 发现 GitHub 仓库中可导入的技能。 |
| `/api/skill-hub/repo/import` | POST | 创建异步导入任务（返回 `{jobId, total, totalBytes}`，轮询进度见下）。 |
| `/api/skill-hub/repo/import/progress?jobId=` | GET | 轮询导入任务进度（`{status, done, total, downloadedBytes, totalBytes, bytesPerSecond, current, imported, skipped, failed}`）。 |
| `/api/skill-hub/repo/import/cancel` | POST | 取消进行中的导入任务（`{jobId}`）。 |
| `/api/skill-hub/sources` | GET | 来源记录、派生 origin/集合、回收站。 |
| `/api/skill-hub/sources/check` | POST | 检查上游更新（5 分钟节流）。 |
| `/api/skill-hub/sources/sync` | POST | 同步某来源所选（或全部）技能。 |
| `/api/skill-hub/sources/delete` | POST | 跟进上游删除（移入回收站）。 |
| `/api/skill-hub/sources/restore` | POST | 从回收站恢复技能（重新挂回来源与场景）。 |
| `/api/skill-hub/sources/trash/clear` | POST | 永久清空回收站。 |
| `/api/skill-hub/update` | GET | 检查插件自身最新发布。 |

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest（8 个套件，152 个用例）
npm run build       # tsc 声明 + tsdown 双半边产物（lib/index.js + lib/client.js）
npm pack            # 生成可安装的 tgz（dsh-skill-hub-<version>.tgz）
```

> **本地联调注意：** 不要在同一 `$DSH_HOME` 和同一项目目录下同时运行两个
> `dsh web` 实例。dsh rc 系列没有跨进程会话日志锁，第二个实例恢复同一会话时会
> 写入重复 `seq`，导致 `corrupt session log: seq gap in committed region`。
> 需要预览实例时先停旧实例，或使用独立的 `DSH_HOME`。

测试套件覆盖路由家族（含 config 路由与禁用闸门）、sidecar 存储、技能文件系统操作、注册表
provider 与触发统计。

## 社区

- [Issues](https://github.com/cheshireez/dsh-skill-hub/issues) —— 提交 bug 与功能建议。
- [讨论区](https://github.com/cheshireez/dsh-skill-hub/discussions) —— 提问、反馈与想法。
- [官方仓库展示帖](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) —— 已发布在 deepseek-harness 官方 Discussion。
- [社区插件市场收录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) —— 已提交待合并；合并后可在「设置 → Plugin Market」一键安装。
- [DeepSeek Harness 官方 Discord](https://discord.gg/Ycq5dCaS4) —— 官方社区（以中文为主）。
- [贡献指南](CONTRIBUTING.md) —— 开发环境与贡献规范。

## License

MIT —— 见 [LICENSE](LICENSE)。

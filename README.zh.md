# dsh-skill-hub

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
| 浏览 / 搜索 | ✅ | ✅（按来源或按 Sets 分组） |
| 启用 / 禁用 | ❌ | ✅（重命名 `SKILL.md`；文件不删除，可随时恢复） |
| 查看技能正文 | ❌ | ✅ |
| 发现诊断 | ❌ | ✅（缺 frontmatter / 缺 `name`/`description` / 非法名称，逐项列明原因） |
| 新建技能向导 | ❌ | ✅（写入 `~/.dsh/skills` 或 `~/.agents/skills`） |
| 触发统计 | ❌ | ✅（从会话日志读每技能实际调用次数） |
| Sets 分组 | ❌ | ✅（frontmatter `sets`；无 sets 归入「未归类」） |
| 实时更新 | — | 文件系统 provider 的 watcher 驱动，面板 5s 轮询兜底 |

## 功能

- **完整目录** —— 官方注册表知道的每个技能：项目 `.dsh/skills` 与 `.agents/skills`、自定义根、
  用户 `~/.dsh/skills` 与 `~/.agents/skills`、内置、以及第三方 provider。
- **搜索与分组** —— 按名称过滤，按来源或 frontmatter `sets` 分组。
- **启用 / 禁用** —— 禁用时把 `SKILL.md` 重命名移出发现范围（记录在 sidecar 文件中），重启后仍然
  生效且可一键恢复。文件从不删除。
- **技能详情** —— 直接从磁盘读取技能的渲染正文。
- **发现诊断** —— 目录会逐项报告技能被忽略的原因（缺 YAML frontmatter、缺 `name`/`description`、
  非法名称）。
- **新建技能向导** —— 在 GUI 里把合法技能脚手架写入 `~/.dsh/skills` 或 `~/.agents/skills`。
- **触发统计** —— 面板显示每个技能被实际调用的次数，数据来自会话日志（可选；没有 session-query
  的部署直接省略该数据）。
- **设置卡片** —— 在 **设置 → 插件 → Skill Hub** 启用插件、开关向 Agent 的公告。

## 工作原理

```text
src/
├── index.ts            host 入口：inject [webServer, skills, systemPrompt]；系统提示公告
├── routes.ts           /api/skill-hub/{catalog,skill,toggle,create,stats,config}（仅回环访问）
├── store.ts            sidecar 状态 ~/.dsh/dsh-skill-hub.json（禁用清单 + 运行时配置，原子写）
├── skillfs.ts          根目录解析 / 开关重命名 / 脚手架 / 诊断扫描 / frontmatter 解析
├── stats.ts            触发统计：会话日志 → 每技能调用次数（可选 sessionQuery）
├── protocol.ts         host ↔ browser 共享 API 契约（类型 + 端点表）
└── client/             browser 半边：设置卡片 + 技能中枢面板（React，CSS Modules）
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
npm test            # vitest（5 个套件，54 个用例）
npm run build       # tsc 声明 + tsdown 双半边产物（lib/index.js + lib/client.js）
npm pack            # 生成可安装的 tgz（dsh-skill-hub-<version>.tgz）
```

测试套件覆盖路由家族（含 config 路由与禁用闸门）、sidecar 存储、技能文件系统操作、注册表
provider 与触发统计。

## 路线图

- **v0.1.0** —— 完整目录、启用/禁用、诊断、新建向导、设置卡片。
- **v0.2.0** —— 触发统计 ✅ · Sets 分组 ✅ · 回收站删除（待做）。
- **v0.3.0** —— SSE 实时推送替代轮询。

## License

MIT —— 见 [LICENSE](LICENSE)。

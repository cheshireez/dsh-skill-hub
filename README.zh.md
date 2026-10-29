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

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的技能中枢 —— 在 Web GUI 里管理 `ctx.skills` 全量目录。除了浏览、开关与市场安装，重心放在两件同类插件不做的事上：**装之前先审内容**（隐藏字符、远程执行管道、凭据路径、体积上限，命中阻断级规则即拒绝落盘），**装之后算公告预算**（一层渐进加载注入的 name + description 字符数，超 8000 会提前告诉你「装了却永远不触发」）。

> 宿主只用官方 SDK，浏览器通过官方槽位渲染，不改 dsh 源码。

## 快速开始

```bash
dsh plugin --profile web add dsh-skill-hub
# 重启 dsh web → 设置 → 技能 → 市场 → 扫描 → 导入
```

要求 `Node ^22.19 || >=24` + dsh web `>=0.1.7-alpha.1 <0.3`。dsh `0.2.2` 起要求 `Node >=24.9`。

两个界面 —— 管理面板在 **设置 → 技能**；本插件自身的配置卡片在 **插件管理页** 的插件自有页面上（侧边栏「插件」→ dsh-skill-hub）。该卡片由本插件自己注册进 `plugins.bundle.config` 槽位（dsh 没有自动生成的配置页），覆盖总开关、向 Agent 公告、圆点颜色、用量显示与统计窗口/间隔。

## 功能

**设置 → 技能** — 3 个 tab：**来源**（技能，平铺/分组+项目树）、**场景**（自定义分组）、**市场**（安装与更新）。

- **浏览** — `ctx.skills` 注册表全量：项目/用户/内置+第三方。按名称、描述、`displayName` 搜索；按来源、按调用方式（模型/用户）筛选；按名称/添加时间/调用次数排序。不同来源的同名技能挂重名徽标，不再静默隐藏。
- **内容审计** — 已启用技能的正文（`SKILL.md`）也体检：裸 ESC 控制字符、Unicode 标签字符、双向控制符（这三类会让「看过」不等于「看见」，市场导入时直接拒绝落盘）、零宽字符、`curl … | sh` 式远程执行、SSH/云凭据/钥匙串路径、超长 description，以及单文件 2 MiB / 单技能 10 MiB / 500 文件上限。规则是纯本地静态匹配，不跑模型、不出网。市场导入会扫整包（含 `scripts/`），常驻体检只扫 `SKILL.md`（每 5 秒轮询，扫全目录会拖慢面板）。
- **公告预算** — 一层渐进加载注入的 name + description 总量随目录一起返回，面板显示字符数与 token 估算；超过 8000 字符变红提示（超出后客户端会截断尾部条目，表现为「装了却不触发」）。
- **开关** — 单技能开关 + 整组三态开关，跨组冲突弹窗（全部关闭/保留开启）。禁用只重命名发现文件（不删除）；禁用的技能仍可查看正文、可一键重新启用。仅 `~/.dsh/skills` 与 `~/.agents/skills` 可写，其余只读。
- **整理** — 场景（tag）+ 自动聚合的来源集合，全部可拖拽排序并持久化到 `~/.dsh/dsh-skill-hub.json`。编辑模式收敛删除/排序控件，阅读视图保持干净。
- **诊断与修复** — provider 跳过的文件给出原因（缺 frontmatter、YAML 非法、名称不一致、描述过短）；可自动修复的（如描述里未加引号的 `:`）一键 Fix 落盘。
- **新建** — 新技能向导，写入 `~/.dsh/skills` 或 `~/.agents/skills`（`SKILL.md` 模板见下）。
- **市场** — 内置精选仓库 + 自定义 `owner/repo`。任何含 `SKILL.md` 的顶层目录都可扫描（无白名单）；`SKILL.md` 直接放在仓库根时，整个仓库算一个技能，技能名取仓库名（`.github/` 等仓库基建不计入）。异步导入，字节级进度+取消。每个源钉一个版本 —— 点 ref 徽标可在发布版/分支/手输之间切换。导入前先过内容审计，命中阻断级规则的技能整包拒绝，临时目录一并清掉（磁盘不留痕）。
- **skills.sh 搜索** — 在内置目录之外按技能名搜索 [skills.sh](https://skills.sh) 索引，结果显示仓库与安装次数，每行两个动作：**安装**直装这一个技能（一步到位，但**不跟踪上游更新** —— 上游只给技能目录名、不给它在仓库里的路径，登记不了来源）；**加为源**把仓库登记为市场源并立即扫描，之后的更新跟踪、版本钉选、回收站与手工添加的源完全一致。两条路都过同一套内容审计。请求走服务端代理（上游没有 CORS 头，也不该把用户出口 IP 交给第三方），`source` 与包内路径都在服务端按严格形态校验后才使用。
- **跟踪更新** — 导入的技能记录 repo+commit 快照。检查全部/一键全更；每源徽章（已装/可更新/上游已删/新版本）。同步覆盖本地修改（先确认）；上游删除跟进移入回收站，恢复保留来源与场景归属。
- **本地改动检测** — 落盘后立刻采集整个技能的内容哈希（路径+大小+内容），检查时与记录比对：不一致的技能挂「本地改动 N 个」徽章，同步确认弹窗里逐个标出会被覆盖的那几个。旧记录没有哈希时按「未知」处理，不误报。
- **从其他 Agent 导入** — 只读扫描 Claude Code / Codex / Cursor / Gemini CLI / Copilot / OpenCode / Goose 的技能目录，两层：**用户级**（`~/.claude/skills` 等）收进 `~/.dsh/skills`，**项目级**（`<projectRoot>/.claude/skills` 等，项目根从已登记工作区推出）收进该项目的 `.dsh/skills`。原目录不受影响；扁平技能统一落成目录包；同样过内容审计与体积上限。
- **项目技能开关** — 项目技能可以停用，方式是**模型调用覆盖**（invocation override）：hub 在每个 agent 的技能层里再注册一次自己的 provider，用同名条目把宿主原生条目盖掉，把该技能的 `modelInvocable` 压成 false —— 模型不再自动调用，「/技能名」手动调用保留，**项目文件一个字节都不动**（git 仓库零污染）。停用状态存在 hub 的 sidecar 里，开关即写即生效；再点一次恢复。
- **从 ZIP 导入** — 选一个 `.zip`：包内每个含 `SKILL.md` 的目录算一个技能，整包是一个技能还是技能集合都支持，逐个独立成败、逐个过内容审计。解压前先拦路径穿越、符号链接、加密包、ZIP64 与解压炸弹；落盘走临时目录 + 原子改名，失败不留半成品；同名已启用的跳过，只有禁用占位或空壳才移入回收站让位（可恢复）。
- **统计** — 会话日志的调用次数+最近使用，分组头汇总；窗口与扫描间隔在设置卡片实时可调。
- **设置卡片** — 注册在 **插件管理页** 的插件自有页面上（侧边栏「插件」→ dsh-skill-hub，默认折叠，点标题展开）：总开关、向 Agent 公告、调用圆点颜色、用量显示开关、统计窗口/间隔。

## 和同类插件怎么选

这个生态里已经有几个技能管理器，覆盖面比本插件宽：[`@michengai/dsh-skills-manager`](https://github.com/MichengAI/dsh-skills-manager) 收编 20+ 个 agent 目录、聚合 ClawHub 与 skills.sh 两个市场、支持 ZIP 导入与自更新；[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) / [dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) 专注导入。

本插件的取舍是**把「装进来之后会不会出事」这件事做深**：

| 你的诉求 | 选谁 |
| --- | --- |
| 一次收编尽可能多的 agent 目录，要 ZIP 导入、要多语言界面 | `@michengai/dsh-skills-manager` |
| 只想把别的 agent 的技能搬过来 | `dsh-skill-importer` |
| **来源不可控（陌生 GitHub 仓库），装之前想先看清里面有什么** | 本插件 |
| **技能越装越多，想知道什么时候会超出注入预算、开始「装了却不触发」** | 本插件 |

两项独占能力：

| 能力 | 说明 |
| --- | --- |
| 内容审计 | 裸 ESC / Unicode 标签字符 / 双向控制符 / 零宽字符 / `curl … \| sh` / SSH 与云凭据路径 / 单文件 2 MiB、单技能 10 MiB、500 文件上限。阻断级命中直接拒绝落盘（市场导入整包拒绝并清掉临时目录），警告级只标记。纯本地静态匹配，不出网、不跑模型。 |
| 公告预算 | 一层渐进加载注入的 name + description 总量随目录一起返回，面板显示字符数与 token 估算，超 8000 字符变红 —— 客户端会截断尾部条目，表现为「装了却不触发」。 |

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

宿主仅用 `ctx.skills.snapshot/get`、`ctx.webServer.register`、`ctx.systemPrompt.section`。路由走 dsh 自身的 `/api` 信任栅栏（回环 / 监听器绑定地址 / `--trusted-host`），JSON；**写接口（POST）另要求 `x-dsh-skill-hub: 1` 头** —— 跨站页面伪造不出自定义头，同源请求不触发预检所以不增加往返。provider 注册在全局技能层，并在每个 live agent 的技能层再注册一次（比 preset 层更近），使模型调用覆盖能盖过宿主原生条目。

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
| `/api/skill-hub/market` 等 | GET/POST | 市场源 列表/添加/删除/钉 ref；`…/source/check` + `…/source/sync` 检查与同步 |
| `/api/skill-hub/market/source/versions?repo=` | GET | 版本选择器的 releases+branches |
| `/api/skill-hub/market/skills-sh?q=` | GET | skills.sh 索引搜索（服务端代理，≥2 字符；结果已校验为严格 `owner/repo`） |
| `/api/skill-hub/market/skills-sh/install` | POST | `{source, skillId}` 直装单个技能（不登记来源，故不跟踪更新） |
| `/api/skill-hub/repo?repo=` | GET | 发现（任意根） |
| `/api/skill-hub/repo/import` | POST | 异步任务 `{jobId, total, totalBytes}` |
| `/api/skill-hub/repo/import/progress?jobId=` | GET | 轮询进度 |
| `/api/skill-hub/repo/import/cancel` | POST | 取消任务 |
| `/api/skill-hub/sources` 等 | GET/POST | 来源 列表/检查/同步/删除/恢复/清空回收站 |
| `/api/skill-hub/foreign` | GET | 其他 agent 技能目录的只读扫描（用户级 + 项目级；项目根从已登记工作区推） |
| `/api/skill-hub/foreign/import` | POST | `{items:[{agent,name,scope?,projectRoot?}]}` 收编到 `~/.dsh/skills`（用户级）或该项目的 `.dsh/skills`（项目级） |
| `/api/skill-hub/import/zip` | POST | 原始 `.zip` 字节（`content-type: application/zip`，≤32 MiB）；包内每个含 `SKILL.md` 的目录作为一个技能，逐个审计后落盘 |
| `/api/skill-hub/update` | GET | 插件最新发布 |
| 未知的 `/api/skill-hub/*` | GET/POST | `404 {error}` 且写明路径 —— 拼错路径不该被读成鉴权失败（宿主 SPA fallback 对自己不拥有的 `/api/*` 一律回 401） |

## 开发

```bash
npm run typecheck  # tsc --noEmit
npm test           # 413 tests, 23 suites
npm run build      # tsc + tsdown → lib/index.js + lib/client.js
```

> 同一 `$DSH_HOME` + cwd 下勿开两个 `dsh web` — 无会话日志锁，会 `seq gap` 损坏。换 `DSH_HOME` 或先关旧实例。

## 故障排查

- `duplicate loader entry id: skill-hub` — 删掉重复安装（只留一种 `dsh plugin add`）。
- 技能不出现 — 看诊断区（缺 frontmatter / 名称不一致 / 描述过短 / 两种发现形态抢同一个名字：`<name>/SKILL.md` 目录包与 `<name>.md` 扁平文件可以并存，注册表只会留一个）。
- 来源组空壳 — 组内技能已被删除、或禁用记录丢失（状态文件被恢复/手改）。启动时自动对账磁盘上的 `.disabled` 文件补记录，**并清掉文件已不存在的死记录**（手工删掉目录后留下的记录以前谁也动不了：启用、新建、删除三条路全失败）；无可见成员的来源组不再渲染。
- 技能建不出来 / 一直显示「已禁用」— 禁用记录指向的文件已经不在了。启动时（以及下一次点「启用」时）会把记录改指到现存的 `.disabled` 文件，找不到就直接删掉记录、把名字释放出来。
- `/` 菜单圆点消失 — dsh 内部触发源变更，目录功能不受影响。
- 找不到配置卡片 — 在插件管理页打开本插件（侧边栏「插件」→ dsh-skill-hub），展开页面顶部的「技能中枢」卡片（默认折叠）。dsh 低于 `0.1.7-alpha.1` 时本插件无法加载（它所用的 settings API 在旧版不存在）。

## 社区

[Issues](https://github.com/cheshireez/dsh-skill-hub/issues) · [讨论区](https://github.com/cheshireez/dsh-skill-hub/discussions) · [官方展示](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) · [市场收录 PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) · [Discord](https://discord.gg/Ycq5dCaS4)

## License

MIT — [LICENSE](LICENSE).

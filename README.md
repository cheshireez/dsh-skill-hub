# dsh-skill-hub

> In-GUI skill hub for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — the full manager for your local skill catalog, in the web GUI.

npm 关键词 `dsh-plugin` · GitHub 仓库挂 `dsh-plugin` topic · 与 [dsh-web-ui 全家桶](https://github.com/zhu1090093659/dsh-web-ui) 同构（单包独立发布）

## 定位

[dsh-skill-manager](https://www.npmjs.com/package/dsh-skill-manager)（gohana 版）是只读浏览器；[dsh-skill-importer](https://github.com/saitamahang/dsh-skill-importer) / [dsh-find-skill](https://github.com/Moximxxx/dsh-find-skill) 专注导入与市场安装。**dsh-skill-hub 卡在中间的空白**：全量目录 + 可管理。

| 能力 | dsh-skill-manager（只读版） | **dsh-skill-hub（本插件）** |
| --- | --- | --- |
| 目录来源 | 自扫盘，仅用户根 | 官方 `ctx.skills` 注册表：项目/自定义/用户/内置全六级 + 第三方 provider |
| 浏览 / 搜索 | ✅ | ✅（按来源分组） |
| 启用 / 禁用 | ❌ | ✅（重命名 SKILL.md，文件不删，可随时恢复） |
| 技能正文查看 | ❌ | ✅ |
| 发现诊断（为什么某个技能没出现） | ❌ | ✅（缺 frontmatter / 缺 name/description / 非法名称，逐个列明原因） |
| 新建技能向导 | ❌ | ✅（写入 ~/.dsh/skills 或 ~/.agents/skills） |
| 实时更新 | — | 文件系统 provider 的 watcher 驱动，面板 5s 轮询兜底 |

## 架构

```text
src/
├── index.ts            host 入口：inject [webServer, skills, systemPrompt]，系统提示公告
├── routes.ts           /api/skill-hub/{catalog,skill,toggle,create}（loopback 围栏）
├── store.ts            sidecar 状态 ~/.dsh/dsh-skill-hub.json（禁用清单，原子写）
├── skillfs.ts          根目录解析 / 开关重命名 / 脚手架 / 诊断扫描
├── protocol.ts         host ↔ browser 共享 API 契约
└── client/             browser 半边：侧边栏入口 + 中列面板（React，CSS Modules）
```

host 侧全部走官方 SDK（`ctx.skills.snapshot()/get()`、`ctx.webServer.register()`、`ctx.systemPrompt.section()`），不改 dsh 源码。client 侧按全家桶 DOM 注入惯例：侧边栏行与 task-board / dsh-ssh 家族选择器协作、`dsh-panel-activate` 事件互斥中列。

## 安装（v0.1.0 起）

```bash
dsh plugin --profile web add dsh-skill-hub
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest（37 用例）
npm run build       # tsc 声明 + tsdown 双半边产物（lib/index.js + lib/client.js）
```

## 路线图

- v0.1.0（当前）：全量目录 + 开关 + 诊断 + 新建 + settings 配置面（installSettingsSection）
- v0.2.0：触发统计（从会话日志读 skill 实际调用次数）、Sets 分组、删除进回收站
- v0.3.0：SSE 实时推送替代轮询

## License

MIT


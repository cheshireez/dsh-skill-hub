# Contributing

Thanks for considering a contribution to **dsh-skill-hub**. This project is a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin with two halves:

- the **host half** (`src/index.ts` + `src/routes.ts`) runs in the dsh process and speaks only official
  dsh SDKs, and
- the **browser half** (`src/client/`) renders inside the web GUI through official slots.

Please keep both halves on official APIs — no dsh source patches.

## Layout

```
src/index.ts            cordis plugin entry (config schema, settings namespace, stats wiring)
src/routes.ts           route-family aggregator (wraps every domain handler in the shared fences)
src/routes/             one file per domain + shared layers:
                        http.ts (fences/JSON/error mapping), deps.ts (route deps + writable-skill
                        resolution), catalog-data.ts (catalog/detail assembly), collection.ts
                        (origin collections), route-state.ts (throttles + import-job table),
                        helpers.ts (barrel)
src/store.ts            sidecar store barrel (re-exports paths / migrate / store)
src/store/              sidecar state: core.ts owns the state container, cold-read single-flight,
                        atomic write and the write guard; one slice file per domain (ledger / tags /
                        sources / market / trash / stats / order / config) wired onto the facade
src/skillfs.ts          writable-root file ops + barrel (skillfs/paths.ts, frontmatter.ts, scan.ts)
src/repo.ts             GitHub repo helpers barrel (repo/types.ts, discovery.ts, api.ts, install.ts,
                        github-client.ts = shared request layer)
src/stats.ts            session-log statistics reader + barrel (stats/persistence.ts, stats/scan.ts)
src/provider.ts         the hub's own ctx.skills provider (global layer)
src/protocol.ts         wire contract barrel (protocol/<domain>.ts)
src/concurrency.ts      bounded-concurrency map
src/error-text.ts       unknown → one-line error text
src/client/index.tsx    browser-half entry (slots + locale registration)
src/client/api.ts       the panel's only data access path
src/client/panel/       panel shell, views, dialogs, hooks/ (one hook per domain + aggregator)
src/client/locales/     dictionaries by view (common/skills/market/sources/detail/settings)
```

## Development setup

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (543 tests across 26 suites)
npm run coverage    # v8 coverage report (text / html / lcov)
npm run build       # tsc declarations + tsdown bundles (lib/index.js + lib/client.js)
```

## Before opening a pull request

1. **Typecheck** — `npm run typecheck` must pass.
2. **Tests** — `npm test` must pass; add/adjust tests for any behavior change. Suites sit next to the
   code they cover (`src/*.test.ts`, `src/routes/*.test.ts`) and mirror the real
   route/store/filesystem/provider behavior. The browser half runs in node by default; add a
   `// @vitest-environment jsdom` docblock for pure components/hooks (`src/client/icons.test.tsx` is
   the reference), and still verify page-level flows in the live GUI.
3. **Build** — `npm run build` must produce `lib/index.js` and `lib/client.js`.
4. **Keep the diff focused** — one logical change per PR, with a clear title and description.
5. **Documentation** — update `README.md` **and** `README.zh.md` (both ship with the package and are
   kept in sync) when behavior or the API surface changes.
6. **Dependency layout** — `lib/index.js` has two server-side bare imports
   (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-skill`). Keep both in `dependencies`, not only
   as optional peers: a clean `npm install` of the published tarball must resolve them from
   inside `node_modules/dsh-skill-hub/lib/` without the host's `bareModuleBaseUrl` injection
   (dsh.so's win32 L5 sandbox needs this). Never move the other peers back to non-optional —
   wide ranges once auto-installed the whole 0.1.7-rc.2 line and disabled required host plugins.

## Code style

- TypeScript, strict mode. ESM (`"type": "module"`).
- Host routes reuse dsh's own `/api` trust fence (loopback ∪ the listener's bind address ∪ `--trusted-host` authorities ∪ the browser session) — never add a second, stricter check. Issue #17 (every route 403s behind a reverse proxy) came from exactly such a duplicate.
- The browser half uses CSS Modules; keep the settings-card chrome family-bucket-compatible.
- Comments explain *why* (routing decisions, dsh host behaviors) more than *what*.

## Testing the plugin in a live dsh web GUI

```bash
# after a change:
npm run build
# restart the dsh web process, then verify both surfaces (three entry points):
#   Settings → Skills Hub        — the skill hub panel
#   sidebar 插件 → 技能中枢       — the same panel, 960px sidebar mount
#   sidebar 插件 → dsh-skill-hub  — the plugin's settings card
```

When the web profile installs this repo as a link (`"dsh-skill-hub": "link:/path/to/repo"`, the
usual local-dev setup), `lib/` is picked up on the next `dsh web` restart — no copy step needed.

## Issues

- **Bugs**: include the dsh version, Node version, the plugin version, and the exact steps.
- **Feature requests**: describe the workflow you are trying to accomplish; a short motivation helps
  scope the change.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).

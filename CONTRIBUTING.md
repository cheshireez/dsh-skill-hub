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
src/store.ts            sidecar store barrel (paths / migrate / store)
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
npm test            # vitest (217 tests across 13 suites)
npm run build       # tsc declarations + tsdown bundles (lib/index.js + lib/client.js)
```

## Before opening a pull request

1. **Typecheck** — `npm run typecheck` must pass.
2. **Tests** — `npm test` must pass; add/adjust tests for any behavior change. Suites sit next to the
   code they cover (`src/*.test.ts`, `src/routes/*.test.ts`) and mirror the real
   route/store/filesystem/provider behavior. The browser half has no component-test harness
   (vitest runs in the node environment); keep browser changes mechanical and verify them in the
   live GUI.
3. **Build** — `npm run build` must produce `lib/index.js` and `lib/client.js`.
4. **Keep the diff focused** — one logical change per PR, with a clear title and description.
5. **Documentation** — update `README.md` (including the embedded Chinese collapsible section) when
   behavior or the API surface changes.

## Code style

- TypeScript, strict mode. ESM (`"type": "module"`).
- Host routes are loopback-only by construction — keep the trust fence intact.
- The browser half uses CSS Modules; keep the settings-card chrome family-bucket-compatible.
- Comments explain *why* (routing decisions, dsh host behaviors) more than *what*.

## Testing the plugin in a live dsh web GUI

```bash
# after a change:
npm run build
cp lib/index.js lib/client.js ~/.dsh/profiles/web/node_modules/dsh-skill-hub/lib/
# restart the dsh web process, then verify Settings → 技能 and Settings → 插件 → Skill Hub
```

## Issues

- **Bugs**: include the dsh version, Node version, the plugin version, and the exact steps.
- **Feature requests**: describe the workflow you are trying to accomplish; a short motivation helps
  scope the change.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).

/**
 * 市场来源与市场统计快照。
 *
 * 与 `sources` 的区别：这里是「从市场安装了哪些 repo」（用户订阅清单），
 * `sources` 是「某个 repo 装了哪些技能」。市场来源可以没有装任何技能。
 */
import type { MarketSourceRecord, MarketStatsSnapshot } from '../protocol.ts'
import type { StoreCore } from './core.ts'

export interface MarketSlice {
  /** The user's market sources, in addition order. */
  listMarketSources(): Promise<MarketSourceRecord[]>
  /** One market source by repo (undefined when absent). */
  getMarketSource(repo: string): Promise<MarketSourceRecord | undefined>
  /** Add a repo (deduplicated), optionally with a pinned ref. Returns the fresh list. */
  addMarketSource(repo: string, ref?: string): Promise<MarketSourceRecord[]>
  /** Remove a repo (no-op when absent). Returns the fresh list. */
  removeMarketSource(repo: string): Promise<MarketSourceRecord[]>
  /** Pin a market source to an explicit ref (branch/tag). Returns the record. */
  setMarketSourceRef(repo: string, ref: string): Promise<MarketSourceRecord | undefined>
  /** Pin a market source to `ref` and record the resolved commit in one persist. */
  setMarketSourcePin(repo: string, ref: string, commitSha: string): Promise<MarketSourceRecord | undefined>
  /** Record the commit a market source's pinned ref resolved to (update baseline). */
  setMarketSourceCommit(repo: string, commitSha: string): Promise<void>
  /** The persisted market-stats snapshot (undefined until first saved). */
  getMarketStatsState(): Promise<MarketStatsSnapshot | undefined>
  /** Persist a market-stats snapshot (written when a refresh fetched anything new). */
  saveMarketStatsState(state: MarketStatsSnapshot): Promise<void>
}

export function marketSlice(core: StoreCore): MarketSlice {
  const { state } = core
  return {
    async listMarketSources(): Promise<MarketSourceRecord[]> {
      await core.ensureLoaded()
      return [...state.marketSources]
    },

    async getMarketSource(repo: string): Promise<MarketSourceRecord | undefined> {
      await core.ensureLoaded()
      return state.marketSources.find((entry) => entry.repo === repo)
    },

    async addMarketSource(repo: string, ref?: string): Promise<MarketSourceRecord[]> {
      await core.ensureLoaded()
      const existing = state.marketSources.find((entry) => entry.repo === repo)
      if (existing === undefined) {
        state.marketSources.push(ref !== undefined && ref !== '' ? { repo, ref } : { repo })
      } else if (ref !== undefined && ref !== '' && existing.ref !== ref) {
        existing.ref = ref
        // 重新钉版必须丢掉旧 commit 基线：它是上一个 ref 的提交，留着会让
        // 下一次市场检查把「版本不同」误报成「有更新」。
        delete existing.commitSha
      }
      await core.persist()
      return [...state.marketSources]
    },

    async removeMarketSource(repo: string): Promise<MarketSourceRecord[]> {
      await core.ensureLoaded()
      const index = state.marketSources.findIndex((entry) => entry.repo === repo)
      if (index === -1) return [...state.marketSources]
      state.marketSources.splice(index, 1)
      await core.persist()
      return [...state.marketSources]
    },

    async setMarketSourceRef(repo: string, ref: string): Promise<MarketSourceRecord | undefined> {
      await core.ensureLoaded()
      const entry = state.marketSources.find((item) => item.repo === repo)
      const trimmed = ref.trim()
      if (entry === undefined || trimmed === '') return entry
      // Confirming the already-selected version must be a no-op: otherwise the
      // commit baseline is dropped and the next check reports a false update.
      if (entry.ref === trimmed) return entry
      entry.ref = trimmed
      delete entry.commitSha
      await core.persist()
      return entry
    },

    /**
     * Pin a market source to `ref` and record the commit it resolved to in one
     * persist. Market sync resolves the commit first; this method is the only
     * write in its success path, so a failed lookup cannot leave the source
     * pinned to a ref that was never verified.
     */
    async setMarketSourcePin(repo: string, ref: string, commitSha: string): Promise<MarketSourceRecord | undefined> {
      await core.ensureLoaded()
      const entry = state.marketSources.find((item) => item.repo === repo)
      if (entry === undefined) return entry
      const trimmed = ref.trim()
      if (trimmed !== '') entry.ref = trimmed
      if (commitSha !== '') entry.commitSha = commitSha
      await core.persist()
      return entry
    },

    async setMarketSourceCommit(repo: string, commitSha: string): Promise<void> {
      await core.ensureLoaded()
      const entry = state.marketSources.find((item) => item.repo === repo)
      if (entry === undefined || commitSha === '') return
      entry.commitSha = commitSha
      await core.persist()
    },

    async getMarketStatsState(): Promise<MarketStatsSnapshot | undefined> {
      await core.ensureLoaded()
      return state.marketStats !== undefined ? { fetchedAt: state.marketStats.fetchedAt, stats: { ...state.marketStats.stats } } : undefined
    },

    async saveMarketStatsState(next: MarketStatsSnapshot): Promise<void> {
      await core.ensureLoaded()
      state.marketStats = { fetchedAt: next.fetchedAt, stats: { ...next.stats } }
      await core.persist()
    },
  }
}

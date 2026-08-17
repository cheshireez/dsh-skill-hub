/**
 * Built-in market catalog: well-known skill repos shown on the market tab so
 * users can browse and install without knowing repo URLs.
 * Only the repo slug lives here; adding goes through the normal
 * market-source route and records upstream tracking like any manual source.
 */

import type { HubKey } from './locales.ts'

export interface MarketCatalogEntry {
  repo: string
  /** locales.ts key for the one-line description. */
  descriptionKey: HubKey
}

/** 默认市场目录：精选技能仓库（顺序即展示顺序）。 */
export const MARKET_CATALOG: readonly MarketCatalogEntry[] = [
  { repo: 'anthropics/skills', descriptionKey: 'market.catalog.anthropics' },
  { repo: 'obra/superpowers', descriptionKey: 'market.catalog.superpowers' },
  { repo: 'mattpocock/skills', descriptionKey: 'market.catalog.mattpocock' },
  { repo: 'nexu-io/open-design', descriptionKey: 'market.catalog.openDesign' },
]

/**
 *  locales 按视图拆分后的聚合入口：各域字典在 ./locales/<domain>.ts，
 *  这里合并为面板消费的 zh/en。老 `from './locales.ts'` 写法保持可用，
 *  HubKey 的完备性仍由 `en: Record<HubKey, string>` 在类型层兜底
 *  （缺键即编译报错）。
 */

import { enCommon, zhCommon } from './locales/common.ts'
import { enDetail, zhDetail } from './locales/detail.ts'
import { enMarket, zhMarket } from './locales/market.ts'
import { enSettings, zhSettings } from './locales/settings.ts'
import { enSkills, zhSkills } from './locales/skills.ts'
import { enSources, zhSources } from './locales/sources.ts'

export const zh = {
  ...zhCommon,
  ...zhSkills,
  ...zhMarket,
  ...zhSources,
  ...zhDetail,
  ...zhSettings,
} as const

/** Union of every translatable key (the namespace's registered dictionary type). */
export type HubKey = keyof typeof zh

export const en: Record<HubKey, string> = {
  ...enCommon,
  ...enSkills,
  ...enMarket,
  ...enSources,
  ...enDetail,
  ...enSettings,
}

/** Template values accepted by the interpolator. */
export type TranslateValues = Record<string, string | number>

/** Interpolate a {name} template with the given values. */
export function t(dict: Record<string, string>, key: HubKey, values?: TranslateValues): string {
  let text = dict[key] ?? key
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll('{' + name + '}', String(value))
    }
  }
  return text
}

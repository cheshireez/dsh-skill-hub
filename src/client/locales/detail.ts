/** 技能详情。从 locales.ts 按前缀拆出，键集合不变。 */
export const zhDetail = {
  'detail.copyMention': '复制 $mention',
  'detail.copyPath': '复制路径',
  'detail.copied': '已复制',
  'detail.back': '返回列表',
  'detail.provider': '提供者',
  'detail.addedAt': '添加时间',
  'detail.updatedAt': '更新时间',
  'detail.path': '路径',
  'detail.whenToUse': '适用场景',
  'detail.uses': '调用次数',
  'detail.groups': '所属场景',
  'detail.loading': '读取技能正文…',
} as const

export const enDetail: Record<keyof typeof zhDetail, string> = {
  'detail.copyMention': 'Copy $mention',
  'detail.copyPath': 'Copy path',
  'detail.copied': 'Copied',
  'detail.back': 'Back to list',
  'detail.provider': 'Provider',
  'detail.addedAt': 'Added',
  'detail.updatedAt': 'Updated',
  'detail.path': 'Path',
  'detail.whenToUse': 'When to use',
  'detail.uses': 'Uses',
  'detail.groups': 'Groups',
  'detail.loading': 'Loading skill body…',
}

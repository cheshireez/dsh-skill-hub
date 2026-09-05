/** 用户自定义 tag 分组：纯组织视图，不改技能文件。 */
export interface SkillTag {
  /** 稳定 ID（新建时由宿主生成）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 成员技能名（集合技能与独立技能都可加入）。 */
  skillNames: string[]
  /** 默认场景（「通用」）：系统预置、不可删除、新技能自动归入。 */
  default?: boolean
}

/** 系统集合组：按 origin（来源集合标识）自动聚合。 */
export interface CollectionGroup {
  /** 集合名（origin 值，如 "superpowers" / "anthropics/skills"）。 */
  name: string
  /** 该集合下的技能名，按名称排序。 */
  skillNames: string[]
}

/** GET /api/skill-hub/groups */
export interface GroupsResponse {
  ok: true
  /** 用户自定义 tag 分组（按拖拽顺序）。 */
  tags: SkillTag[]
  /** 系统集合组（按拖拽顺序，兜底按名称）。 */
  collections: CollectionGroup[]
  /** skillName → 集合名 的完整映射。 */
  origins: Record<string, string>
  /** 来源分组整体顺序（project / col:xxx / uncategorized-source），用于 SourcesView 顶层排序 */
  sourceGroupOrder?: string[]
  /** 兼容旧 collectionOrder 字段 */
  collectionOrder?: string[]
}

/** POST /api/skill-hub/tag — 新建（缺省 id）或重命名（带 id）。 */
export interface TagSaveRequest {
  /** 已有 tag 的 id；缺省表示新建。 */
  id?: string
  /** 显示名（去空格后非空）。 */
  name: string
}

/** POST /api/skill-hub/tag */
export interface TagSaveResponse {
  ok: true
  /** 变更后的全部 tag。 */
  tags: SkillTag[]
}

/** POST /api/skill-hub/tag/delete */
export interface TagDeleteRequest {
  id: string
}

/** POST /api/skill-hub/tag/delete */
export interface TagDeleteResponse {
  ok: true
  tags: SkillTag[]
}

/** POST /api/skill-hub/tag/members — 直接设置某 tag 的完整成员列表（幂等）。 */
export interface TagMembersRequest {
  id: string
  /** 目标成员技能名；后端只保留目录中存在的名字。 */
  skillNames: string[]
}

/** POST /api/skill-hub/tag/members */
export interface TagMembersResponse {
  ok: true
  tags: SkillTag[]
}

/** POST /api/skill-hub/tag/reorder — 拖拽重排场景分组 */
export interface TagReorderRequest {
  /** 按新顺序排列的 tag id 列表（需包含全部 id） */
  orderedIds: string[]
}
/** POST /api/skill-hub/tag/reorder */
export interface TagReorderResponse {
  ok: true
  tags: SkillTag[]
}

/** POST /api/skill-hub/collections/reorder — 拖拽重排来源集合 */
export interface CollectionReorderRequest {
  /** 按新顺序排列的集合名列表（需包含全部 name） */
  orderedNames: string[]
}
/** POST /api/skill-hub/collections/reorder */
export interface CollectionReorderResponse {
  ok: true
  collections: CollectionGroup[]
  order: string[]
}

/** POST /api/skill-hub/source-groups/reorder — 拖拽重排来源顶层分组（project / collections / personal） */
export interface SourceGroupReorderRequest {
  /** 按新顺序排列的顶层分组 key 列表（project / col:xxx / uncategorized-source） */
  orderedKeys: string[]
}
export interface SourceGroupReorderResponse {
  ok: true
  order: string[]
}

/**
 * Sidecar state facade —— 对外仍然是那一个 `SkillHubStore`，内部按领域拆开。
 *
 * 拆分前这里是 699 行 / 49 个方法的上帝对象，每个方法都是
 * 「ensureLoaded → 改一个 Map → persist」的薄壳，真正的共享骨架只有
 * 状态容器 + 加载 + 原子写（约 130 行）。现在骨架在 `core.ts`，各领域方法
 * 由 `*.ts` 的 slice 工厂返回，构造时一次装到实例上。
 *
 * 判据：
 * - 加方法时放进对应领域的 slice，不要往这个文件堆；
 * - slice 只能通过 `StoreCore` 的 `state` / `ensureLoaded` / `persist` 改盘，
 *   绝不自己读写文件（否则写入封锁与并发写序会被绕开）；
 * - 新领域 = 新 slice 文件 + 在下面 `Object.assign` 里加一行。
 *
 * 类型上用 interface 与 class 同名合并：调用点看到的仍是完整的
 * `store.listDisabled()` 一类签名，无需感知拆分。
 */
import { configSlice, type ConfigSlice } from './config.ts'
import { createStoreCore, type StoreCore } from './core.ts'
import { skillLedgerSlice, type SkillLedgerSlice } from './ledger.ts'
import { marketSlice, type MarketSlice } from './market.ts'
import { orderSlice, type OrderSlice } from './order.ts'
import { statePath } from './paths.ts'
import { sourceSlice, type SourceSlice } from './sources.ts'
import { statsSlice, type StatsSlice } from './stats.ts'
import { tagSlice, type TagSlice } from './tags.ts'
import { trashSlice, type TrashSlice } from './trash.ts'

/** 全部领域方法的联合（与下面的 class 声明合并成完整实例类型）。 */
export interface SkillHubStore
  extends SkillLedgerSlice,
    ConfigSlice,
    TagSlice,
    OrderSlice,
    SourceSlice,
    MarketSlice,
    TrashSlice,
    StatsSlice {}

/** Sidecar state owner. */
export class SkillHubStore {
  private readonly core: StoreCore

  constructor(file: string = statePath()) {
    this.core = createStoreCore(file)
    Object.assign(
      this,
      skillLedgerSlice(this.core),
      configSlice(this.core),
      tagSlice(this.core),
      orderSlice(this.core),
      sourceSlice(this.core),
      marketSlice(this.core),
      trashSlice(this.core),
      statsSlice(this.core),
    )
  }
}

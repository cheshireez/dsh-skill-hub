/**
 * PanelDialogs — SkillHubPanel 底部的对话框接线层（冲突、同步/删除确认、
 * 分支选择、版本选择、市场同步、删除技能、删除分组、清空回收站）。状态与
 * 动作仍由 useSkillHub 的 hub 持有；这里只收窄成显式 props，渲染顺序与
 * 拆分前完全一致。
 */

import type { JSX } from 'react'
import type { CollectionGroup, SkillTag } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import { BranchChoiceDialog, ConfirmDialog, ConflictDialog, MarketSyncDialog, VersionChoiceDialog } from './dialogs.tsx'
import type { SkillHubState } from './useSkillHub.ts'

export interface PanelDialogsProps {
  /** 分组开关冲突（groupsState 未加载时传空数组）。 */
  conflictDialog: SkillHubState['conflictDialog']
  tags: readonly SkillTag[]
  collections: readonly CollectionGroup[]
  setConflictDialog: SkillHubState['setConflictDialog']
  resolveConflict: SkillHubState['resolveConflict']
  /** 来源同步/删除确认。 */
  confirmDialog: SkillHubState['confirmDialog']
  setConfirmDialog: SkillHubState['setConfirmDialog']
  runConfirmed: SkillHubState['runConfirmed']
  /** 无 release 的市场源分支选择。 */
  branchChoice: SkillHubState['branchChoice']
  branchBusy: SkillHubState['branchBusy']
  setBranchChoice: SkillHubState['setBranchChoice']
  confirmBranchChoice: SkillHubState['confirmBranchChoice']
  /** 市场源版本选择。 */
  versionDialog: SkillHubState['versionDialog']
  versionBusy: SkillHubState['versionBusy']
  setVersionDialog: SkillHubState['setVersionDialog']
  confirmVersionDialog: SkillHubState['confirmVersionDialog']
  /** 市场源同步后的技能勾选。 */
  marketSyncDialog: SkillHubState['marketSyncDialog']
  syncBusy: SkillHubState['syncBusy']
  setMarketSyncDialog: SkillHubState['setMarketSyncDialog']
  confirmMarketSync: SkillHubState['confirmMarketSync']
  /** 删除单个技能确认。 */
  deleteSkillDialog: SkillHubState['deleteSkillDialog']
  setDeleteSkillDialog: SkillHubState['setDeleteSkillDialog']
  runDeleteSkill: SkillHubState['runDeleteSkill']
  /** 删除分组确认。 */
  deleteGroupDialog: SkillHubState['deleteGroupDialog']
  setDeleteGroupDialog: SkillHubState['setDeleteGroupDialog']
  runDeleteGroup: SkillHubState['runDeleteGroup']
  /** 清空回收站确认。 */
  confirmClearTrash: SkillHubState['confirmClearTrash']
  setConfirmClearTrash: SkillHubState['setConfirmClearTrash']
  clearTrash: SkillHubState['clearTrash']
}

export function PanelDialogs(props: PanelDialogsProps): JSX.Element {
  const {
    conflictDialog, tags, collections, setConflictDialog, resolveConflict,
    confirmDialog, setConfirmDialog, runConfirmed,
    branchChoice, branchBusy, setBranchChoice, confirmBranchChoice,
    versionDialog, versionBusy, setVersionDialog, confirmVersionDialog,
    marketSyncDialog, syncBusy, setMarketSyncDialog, confirmMarketSync,
    deleteSkillDialog, setDeleteSkillDialog, runDeleteSkill,
    deleteGroupDialog, setDeleteGroupDialog, runDeleteGroup,
    confirmClearTrash, setConfirmClearTrash, clearTrash,
  } = props
  return (
    <>
      {conflictDialog !== null ? (
        <ConflictDialog
          dialog={conflictDialog}
          tags={tags}
          collections={collections}
          onClose={() => { setConflictDialog(null) }}
          onKeepOn={() => { void resolveConflict(false) }}
          onCloseAll={() => { void resolveConflict(true) }}
        />
      ) : null}

      {confirmDialog !== null ? (
        <ConfirmDialog
          title={confirmDialog.kind === 'sync' ? tt('source.syncConfirmTitle') : tt('source.deleteConfirmTitle')}
          text={confirmDialog.kind === 'sync' ? tt('source.syncConfirmText') : tt('source.deleteConfirmText')}
          items={confirmDialog.skills}
          confirmLabel={confirmDialog.kind === 'sync' ? tt('source.sync') : tt('source.followDelete')}
          danger={confirmDialog.kind === 'delete'}
          onCancel={() => { setConfirmDialog(null) }}
          onConfirm={() => { void runConfirmed() }}
        />
      ) : null}

      {branchChoice !== null ? (
        <BranchChoiceDialog
          choice={branchChoice}
          busy={branchBusy}
          onSelect={(selected) => { setBranchChoice({ ...branchChoice, selected }) }}
          onCancel={() => { setBranchChoice(null) }}
          onConfirm={() => { void confirmBranchChoice() }}
        />
      ) : null}

      {versionDialog !== null ? (
        <VersionChoiceDialog
          choice={versionDialog}
          busy={versionBusy}
          onSelect={(selected) => { setVersionDialog({ ...versionDialog, selected }) }}
          onCustom={(custom) => { setVersionDialog({ ...versionDialog, custom }) }}
          onCancel={() => { setVersionDialog(null) }}
          onConfirm={() => { void confirmVersionDialog() }}
        />
      ) : null}

      {marketSyncDialog !== null ? (
        <MarketSyncDialog
          dialog={marketSyncDialog}
          busy={syncBusy}
          onToggle={(name, checked) => {
            const next = new Set(marketSyncDialog.selected)
            if (checked) next.add(name)
            else next.delete(name)
            setMarketSyncDialog({ ...marketSyncDialog, selected: next })
          }}
          onCancel={() => { setMarketSyncDialog(null) }}
          onConfirm={() => { void confirmMarketSync() }}
        />
      ) : null}

      {deleteSkillDialog !== null ? (
        <ConfirmDialog
          title={tt('delete.confirmTitle')}
          text={tt('delete.confirmText', { name: deleteSkillDialog })}
          confirmLabel={tt('delete.confirm')}
          danger
          onCancel={() => { setDeleteSkillDialog(null) }}
          onConfirm={() => { void runDeleteSkill() }}
        />
      ) : null}

      {deleteGroupDialog !== null ? (
        <ConfirmDialog
          title={tt('source.deleteGroupTitle')}
          text={tt('source.deleteGroupText', { name: deleteGroupDialog.name, count: deleteGroupDialog.skillNames.length })}
          items={deleteGroupDialog.skillNames}
          confirmLabel={tt('source.deleteGroup')}
          danger
          onCancel={() => { setDeleteGroupDialog(null) }}
          onConfirm={() => { void runDeleteGroup() }}
        />
      ) : null}

      {confirmClearTrash ? (
        <ConfirmDialog
          title={tt('source.clearTrashConfirmTitle')}
          text={tt('source.clearTrashConfirmText')}
          confirmLabel={tt('source.clearTrashConfirm')}
          danger
          onCancel={() => { setConfirmClearTrash(false) }}
          onConfirm={() => { void clearTrash() }}
        />
      ) : null}
    </>
  )
}

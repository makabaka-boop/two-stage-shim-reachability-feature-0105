import { useEffect, useState, type ReactNode } from 'react'
import { useInventory } from '../hooks/useInventory'
import { InventoryDomainError, ADVANCE_LABELS, varianceItems } from '../lib/inventory/domain'
import type { InventoryController } from '../lib/inventory/controller'
import type {
  BatchItem,
  InventoryBatch,
  ShimLevel,
} from '../lib/inventory/types'
import {
  DISPOSITION_KINDS,
  DISPOSITION_LABELS,
  STATUS_LABELS,
} from '../lib/inventory/types'
import type { QuarantineEntry } from '../lib/inventory/repository'

interface DraftRow {
  level: ShimLevel
  spec: string
  bookQty: string
}

const EMPTY_ROW: DraftRow = { level: 'A', spec: '', bookQty: '' }

function runDomainAction(
  setFormError: (msg: string | null) => void,
  action: () => void,
): boolean {
  try {
    action()
    setFormError(null)
    return true
  } catch (err) {
    if (err instanceof InventoryDomainError) {
      // Gate/validation rejection: show inline; storage was never touched.
      setFormError(err.message)
    }
    // StorageCommitError is already captured by the controller and shown in
    // the global storage banner with a retry action — nothing else to do.
    return false
  }
}

function CreateBatchForm({ controller }: { controller: InventoryController }) {
  const [name, setName] = useState('')
  const [rows, setRows] = useState<DraftRow[]>([{ ...EMPTY_ROW }])
  const [error, setError] = useState<string | null>(null)

  function updateRow(index: number, patch: Partial<DraftRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function submit() {
    const parsedRows = rows.map((r) => ({
      level: r.level,
      spec: Number(r.spec),
      bookQty: Number(r.bookQty),
    }))
    const ok = runDomainAction(setError, () => controller.createBatch(name.trim(), parsedRows))
    if (ok) {
      setName('')
      setRows([{ ...EMPTY_ROW }])
    }
  }

  return (
    <section className="panel">
      <h2>新建盘点批次</h2>
      <p className="hint">
        填写 A/B 级规格（μm，0–200000 整数）与账面数量；同一级别内规格不可重复。
        创建后为「已建草稿」，可随时返回继续编辑录入。
      </p>
      <div className="create-name">
        <label htmlFor="batch-name">批次名称</label>
        <input
          id="batch-name"
          className="text-input"
          value={name}
          maxLength={80}
          placeholder="例如：9 月光学平台垫片盘点"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="draft-rows" role="table" aria-label="规格与账面数量">
        <div className="draft-row header" role="row">
          <span>级别</span>
          <span>规格（μm）</span>
          <span>账面数量</span>
          <span aria-label="操作" />
        </div>
        {rows.map((row, i) => (
          <div className="draft-row" role="row" key={i}>
            <select
              aria-label="级别"
              value={row.level}
              onChange={(e) => updateRow(i, { level: e.target.value as ShimLevel })}
            >
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
            <input
              aria-label="规格"
              inputMode="numeric"
              value={row.spec}
              placeholder="0–200000"
              onChange={(e) => updateRow(i, { spec: e.target.value })}
            />
            <input
              aria-label="账面数量"
              inputMode="numeric"
              value={row.bookQty}
              placeholder="≥0"
              onChange={(e) => updateRow(i, { bookQty: e.target.value })}
            />
            <button
              type="button"
              className="icon-btn"
              disabled={rows.length === 1}
              onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      <div className="actions">
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}
        >
          + 添加一行
        </button>
        <button type="button" className="primary" onClick={submit}>
          创建批次（草稿）
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

function StatusBadge({ status }: { status: InventoryBatch['status'] }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>
}

function BatchCard({
  batch,
  onOpen,
}: {
  batch: InventoryBatch
  onOpen: () => void
}) {
  const total = batch.items.length
  const counted = batch.items.filter((i) => i.countedQty !== null).length
  const variances = varianceItems(batch).length
  return (
    <button type="button" className="batch-card" onClick={onOpen}>
      <div className="batch-card-head">
        <strong>{batch.name}</strong>
        <StatusBadge status={batch.status} />
      </div>
      <div className="batch-card-meta">
        <span>{total} 项规格</span>
        <span>
          已计数 {counted}/{total}
        </span>
        {variances > 0 && <span className="variance-tag">差异 {variances}</span>}
      </div>
    </button>
  )
}

function CountInput({
  item,
  disabled,
  onCommit,
}: {
  item: BatchItem
  disabled: boolean
  onCommit: (qty: number) => void
}) {
  const [value, setValue] = useState(item.countedQty === null ? '' : String(item.countedQty))
  const [error, setError] = useState<string | null>(null)

  // Re-sync when the committed value changes externally (reload/retry) while
  // the user is not editing this field.
  useEffect(() => {
    const el = document.getElementById(`count-${item.id}`)
    if (document.activeElement !== el) {
      setValue(item.countedQty === null ? '' : String(item.countedQty))
    }
  }, [item.id, item.countedQty])

  function commit() {
    const qty = Number(value)
    if (!Number.isInteger(qty) || qty < 0) {
      setError('实点数须为非负整数')
      return
    }
    // No-op write when nothing changed (avoids touching storage on blur).
    if (item.countedQty === qty) {
      setError(null)
      return
    }
    setError(null)
    onCommit(qty)
  }

  return (
    <div className="count-cell">
      <input
        id={`count-${item.id}`}
        aria-label={`${item.level} 级 ${item.spec} μm 实点数`}
        inputMode="numeric"
        disabled={disabled}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      {error && <small className="form-error">{error}</small>}
    </div>
  )
}

function BatchDetail({
  batch,
  controller,
  onBack,
}: {
  batch: InventoryBatch
  controller: InventoryController
  onBack: () => void
}) {
  const [dispositionDraft, setDispositionDraft] = useState<
    Record<string, { kind: (typeof DISPOSITION_KINDS)[number]; note: string }>
  >({})
  const [formError, setFormError] = useState<string | null>(null)
  const readOnly = batch.status === 'completed'
  const counted = batch.items.filter((i) => i.countedQty !== null).length
  const variances = varianceItems(batch)
  const undisposed = variances.filter((i) => !batch.dispositions[i.id]).length

  const advanceLabel =
    batch.status === 'counting' && counted < batch.items.length
      ? `还有 ${batch.items.length - counted} 项未计数`
      : batch.status === 'review_required' && undisposed > 0
        ? `还有 ${undisposed} 个差异未处置`
        : ADVANCE_LABELS[batch.status]

  function dispositionCells(item: BatchItem): ReactNode {
    if (item.countedQty === null || item.countedQty === item.bookQty) {
      return <span className="muted">—</span>
    }
    const decided = batch.dispositions[item.id]
    if (readOnly && decided) {
      return (
        <span>
          {DISPOSITION_LABELS[decided.kind]}
          <small className="muted">（{decided.note}）</small>
        </span>
      )
    }
    const draft = dispositionDraft[item.id] ?? {
      kind: decided?.kind ?? DISPOSITION_KINDS[0],
      note: decided?.note ?? '',
    }
    return (
      <div className="disposition-cell">
        <select
          aria-label="处置结论"
          value={draft.kind}
          onChange={(e) =>
            setDispositionDraft((prev) => ({
              ...prev,
              [item.id]: {
                ...draft,
                kind: e.target.value as (typeof DISPOSITION_KINDS)[number],
              },
            }))
          }
        >
          {DISPOSITION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {DISPOSITION_LABELS[kind]}
            </option>
          ))}
        </select>
        <input
          aria-label="处置说明"
          placeholder="处置说明（必填）"
          value={draft.note}
          onChange={(e) =>
            setDispositionDraft((prev) => ({
              ...prev,
              [item.id]: { ...draft, note: e.target.value },
            }))
          }
        />
        <button
          type="button"
          onClick={() =>
            runDomainAction(setFormError, () =>
              controller.decide(
                batch.id,
                item.id,
                draft.kind as (typeof DISPOSITION_KINDS)[number],
                draft.note,
              ),
            )
          }
        >
          保存处置
        </button>
      </div>
    )
  }

  return (
    <section className="panel batch-detail">
      <div className="detail-head">
        <button type="button" onClick={onBack}>
          ← 返回批次列表
        </button>
        <StatusBadge status={batch.status} />
      </div>
      <h2>{batch.name}</h2>
      <p className="hint">
        共 {batch.items.length} 项 · 已计数 {counted}/{batch.items.length} · 差异{' '}
        {variances.length} 项{batch.status === 'review_required' ? ` · 未处置 ${undisposed}` : ''}
      </p>

      <div className="items-table">
        <div className="items-row header">
          <span>级别</span>
          <span>规格（μm）</span>
          <span>账面数量</span>
          <span>实点数</span>
          <span>差异</span>
          <span>处置结论</span>
        </div>
        {batch.items.map((item) => {
          const diff =
            item.countedQty === null ? null : item.countedQty - item.bookQty
          return (
            <div className="items-row" key={item.id}>
              <span>{item.level}</span>
              <span className="mono">{item.spec}</span>
              <span className="mono">{item.bookQty}</span>
              <span>
                {batch.status === 'draft' ? (
                  <span className="muted">开始盘点后录入</span>
                ) : (
                  <CountInput
                    item={item}
                    disabled={readOnly || batch.status === 'review_required'}
                    onCommit={(qty) =>
                      runDomainAction(setFormError, () =>
                        controller.enterCount(batch.id, item.id, qty),
                      )
                    }
                  />
                )}
              </span>
              <span className={diff === null || diff === 0 ? 'muted' : diff > 0 ? 'diff-plus' : 'diff-minus'}>
                {diff === null ? '—' : diff > 0 ? `+${diff}` : diff}
              </span>
              <span>
                {batch.status === 'review_required' || readOnly
                  ? dispositionCells(item)
                  : <span className="muted">—</span>}
              </span>
            </div>
          )
        })}
      </div>

      {formError && <p className="form-error">{formError}</p>}

      {!readOnly && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => runDomainAction(setFormError, () => controller.advance(batch.id))}
          >
            {advanceLabel}
          </button>
        </div>
      )}
      {readOnly && (
        <p className="readonly-note">批次已结案，数据只读。{batch.completedAt
          ? new Date(batch.completedAt).toLocaleString()
          : ''} 完成</p>
      )}
    </section>
  )
}

const QUARANTINE_REASON_LABELS: Record<QuarantineEntry['reason'], string> = {
  bad_json: '记录无法解析',
  bad_envelope: '缺少版本信封',
  future_version: '来自更新版本，当前不兼容',
  migration_failed: '旧版本迁移失败',
  bad_structure: '批次结构损坏',
  uncommitted: '检测到未完成写入',
}

function QuarantineBanner({ controller }: { controller: InventoryController }) {
  const { quarantine } = controller.getSnapshot()
  if (quarantine.length === 0) return null
  return (
    <section className="panel quarantine-panel" aria-live="assertive">
      <h2>存储恢复提示（{quarantine.length} 条记录已隔离）</h2>
      <p className="hint">
        以下记录版本不兼容、结构损坏或来自一次未完成的写入，已自动隔离，不影响其他批次盘点。
        可尝试恢复，或永久丢弃。
      </p>
      <ul className="quarantine-list">
        {quarantine.map((entry) => (
          <li key={entry.id} className="quarantine-item">
            <div>
              <strong>{QUARANTINE_REASON_LABELS[entry.reason]}</strong>
              <code className="quarantine-key">{entry.dataKey.split('/').pop()}</code>
              <p className="muted small">{entry.detail}</p>
            </div>
            <div className="actions">
              {entry.recoverable && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => controller.recover(entry.id)}
                >
                  恢复此记录
                </button>
              )}
              <button type="button" onClick={() => controller.discard(entry.id)}>
                丢弃
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StorageBanner({ controller }: { controller: InventoryController }) {
  const { storageError, pendingFailure, warnings } = controller.getSnapshot()
  return (
    <>
      {warnings.map((w, i) => (
        <p key={i} className="storage-warning">
          {w}
        </p>
      ))}
      {storageError && (
        <div className="storage-banner" role="alert">
          <span>
            写入未成功，页面仍显示最后成功版本，未提交的数据不会丢失入口：{storageError}
          </span>
          <div className="actions">
            {pendingFailure && (
              <button type="button" className="primary" onClick={() => controller.retryPending()}>
                重试提交
              </button>
            )}
            <button type="button" onClick={() => controller.dismissError()}>
              关闭提示
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export function InventoryPage() {
  const { controller, snapshot, unavailable } = useInventory()
  const [openId, setOpenId] = useState<string | null>(null)

  if (unavailable) {
    return (
      <section className="panel">
        <h2>实物垫片套装盘点</h2>
        <p className="form-error">
          当前浏览器禁用了 localStorage，盘点批次无法本地保存。请开启站点存储后刷新页面。
        </p>
      </section>
    )
  }

  if (!snapshot.loaded) {
    return (
      <section className="panel">
        <p className="hint">正在读取本地批次…</p>
      </section>
    )
  }

  const openBatch = openId ? snapshot.batches.find((b) => b.id === openId) ?? null : null

  return (
    <div className="inventory-page">
      <StorageBanner controller={controller!} />
      {openBatch ? (
        <BatchDetail
          batch={openBatch}
          controller={controller!}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <>
          <QuarantineBanner controller={controller!} />
          <CreateBatchForm controller={controller!} />
          <section className="panel">
            <h2>盘点批次（{snapshot.batches.length}）</h2>
            {snapshot.batches.length === 0 ? (
              <p className="hint">还没有批次，先在上方创建一个草稿批次。</p>
            ) : (
              <div className="batch-grid">
                {snapshot.batches.map((batch) => (
                  <BatchCard key={batch.id} batch={batch} onOpen={() => setOpenId(batch.id)} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
      <footer className="page-footer">
        批次仅保存在本浏览器（版本化 localStorage）：先构造合法候选，经写入、回读校验与提交标记后才更新界面；
        失败自动保留上一版本并可重试。
      </footer>
    </div>
  )
}

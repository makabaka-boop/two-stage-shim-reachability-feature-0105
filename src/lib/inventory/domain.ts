/**
 * Pure domain logic for physical shim-set inventory.
 *
 * Every mutation is a pure function: it derives a legal *candidate* batch
 * from the current one and never touches storage. The repository layer is
 * responsible for persisting a candidate before React state is updated, so a
 * failed write can never leak an uncommitted value into the UI.
 */

import {
  BATCH_STATUSES,
  DISPOSITION_KINDS,
  type BatchItem,
  type BatchItemInput,
  type BatchStatus,
  type Disposition,
  type DispositionKind,
  type InventoryBatch,
  type ShimLevel,
} from './types'
import { SHIM_MAX, SHIM_MIN } from '../validation'

export const BATCH_NAME_MAX = 80
export const BATCH_ITEMS_MIN = 1
export const BATCH_ITEMS_MAX = 2000
export const QTY_MAX = 1_000_000_000

export class InventoryDomainError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_STATUS'
      | 'UNCOUNTED_ITEMS'
      | 'UNDISPOSED_VARIANCES'
      | 'READ_ONLY'
      | 'NOT_A_VARIANCE'
      | 'ITEM_NOT_FOUND',
  ) {
    super(message)
    this.name = 'InventoryDomainError'
  }
}

function isNonNegativeInt(value: unknown, max = QTY_MAX): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

function isShimSpec(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= SHIM_MIN &&
    value <= SHIM_MAX
  )
}

/**
 * Validate the rows supplied when a batch draft is created:
 * at least one row, levels A/B, spec integer in [0, 200000],
 * book quantity a non-negative integer; the same (level, spec)
 * pair may not appear twice.
 */
export function validateItemInputs(inputs: unknown): BatchItemInput[] {
  if (!Array.isArray(inputs) || inputs.length < BATCH_ITEMS_MIN || inputs.length > BATCH_ITEMS_MAX) {
    throw new InventoryDomainError(
      `需要 ${BATCH_ITEMS_MIN}–${BATCH_ITEMS_MAX} 行规格记录`,
      'INVALID_INPUT',
    )
  }
  const rows: BatchItemInput[] = []
  const seen = new Set<string>()
  for (const raw of inputs) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InventoryDomainError('每行必须包含 level/spec/bookQty', 'INVALID_INPUT')
    }
    const row = raw as Record<string, unknown>
    const level = row.level
    if (level !== 'A' && level !== 'B') {
      throw new InventoryDomainError('级别必须为 A 或 B', 'INVALID_INPUT')
    }
    if (!isShimSpec(row.spec)) {
      throw new InventoryDomainError(
        `规格必须是 [${SHIM_MIN}, ${SHIM_MAX}] 内的整数`,
        'INVALID_INPUT',
      )
    }
    if (!isNonNegativeInt(row.bookQty)) {
      throw new InventoryDomainError('账面数量必须是非负整数', 'INVALID_INPUT')
    }
    const key = `${level}:${row.spec}`
    if (seen.has(key)) {
      throw new InventoryDomainError(`规格 ${level} 级 ${row.spec} μm 重复`, 'INVALID_INPUT')
    }
    seen.add(key)
    rows.push({ level, spec: row.spec, bookQty: row.bookQty })
  }
  return rows
}

/** Deterministic item id within a batch: independent of insertion timing. */
export function itemId(level: ShimLevel, spec: number): string {
  return `${level}-${spec}`
}

export interface CreateDraftOptions {
  id: string
  name: string
  inputs: BatchItemInput[]
  now?: number
}

/** Create a legal draft candidate from validated A/B rows. */
export function createDraft({ id, name, inputs, now = Date.now() }: CreateDraftOptions): InventoryBatch {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed.length > BATCH_NAME_MAX) {
    throw new InventoryDomainError(
      `批次名称必填且不超过 ${BATCH_NAME_MAX} 个字符`,
      'INVALID_INPUT',
    )
  }
  const rows = validateItemInputs(inputs)
  const items: BatchItem[] = rows.map((row) => ({
    id: itemId(row.level, row.spec),
    level: row.level,
    spec: row.spec,
    bookQty: row.bookQty,
    countedQty: null,
    countedAt: null,
  }))
  return {
    id,
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    items,
    submittedAt: null,
    completedAt: null,
    dispositions: {},
  }
}

function assertWritable(batch: InventoryBatch): void {
  if (batch.status === 'completed') {
    throw new InventoryDomainError('已完成批次只读，不能修改', 'READ_ONLY')
  }
}

/** Start counting (draft → counting). */
export function startCounting(batch: InventoryBatch, now = Date.now()): InventoryBatch {
  if (batch.status !== 'draft') {
    throw new InventoryDomainError('只有草稿批次可以开始盘点', 'INVALID_STATUS')
  }
  return { ...batch, status: 'counting', updatedAt: now }
}

export function isCounted(batch: InventoryBatch): boolean {
  return batch.items.every((it) => it.countedQty !== null)
}

export function uncountedItems(batch: InventoryBatch): BatchItem[] {
  return batch.items.filter((it) => it.countedQty === null)
}

export function varianceItems(batch: InventoryBatch): BatchItem[] {
  return batch.items.filter(
    (it) => it.countedQty !== null && it.countedQty !== it.bookQty,
  )
}

export function undisposedVarianceItems(batch: InventoryBatch): BatchItem[] {
  return varianceItems(batch).filter((it) => !batch.dispositions[it.id])
}

/** Enter (or correct) the actual count for one item. */
export function recordCount(
  batch: InventoryBatch,
  itemIdValue: string,
  countedQty: number,
  now = Date.now(),
): InventoryBatch {
  assertWritable(batch)
  if (batch.status !== 'counting') {
    throw new InventoryDomainError('只有盘点中的批次可以录入实点数', 'INVALID_STATUS')
  }
  if (!isNonNegativeInt(countedQty)) {
    throw new InventoryDomainError('实点数必须是非负整数', 'INVALID_INPUT')
  }
  const index = batch.items.findIndex((it) => it.id === itemIdValue)
  if (index < 0) throw new InventoryDomainError('未找到该规格项', 'ITEM_NOT_FOUND')
  const items = batch.items.slice()
  items[index] = { ...items[index], countedQty, countedAt: now }
  return { ...batch, items, updatedAt: now }
}

/** Submit a fully counted batch for variance review (counting → review). */
export function submitForReview(batch: InventoryBatch, now = Date.now()): InventoryBatch {
  if (batch.status !== 'counting') {
    throw new InventoryDomainError('只有盘点中的批次可以提交复核', 'INVALID_STATUS')
  }
  const pending = uncountedItems(batch)
  if (pending.length > 0) {
    throw new InventoryDomainError(
      `还有 ${pending.length} 项未计数，不能提交复核`,
      'UNCOUNTED_ITEMS',
    )
  }
  return { ...batch, status: 'review_required', submittedAt: now, updatedAt: now }
}

/** Record the disposition conclusion for one variance item. */
export function setDisposition(
  batch: InventoryBatch,
  itemIdValue: string,
  kind: DispositionKind,
  note: string,
  now = Date.now(),
): InventoryBatch {
  assertWritable(batch)
  if (batch.status !== 'review_required') {
    throw new InventoryDomainError('只有待复核批次可以填写处置结论', 'INVALID_STATUS')
  }
  if (!DISPOSITION_KINDS.includes(kind)) {
    throw new InventoryDomainError('非法处置结论', 'INVALID_INPUT')
  }
  const item = batch.items.find((it) => it.id === itemIdValue)
  if (!item) throw new InventoryDomainError('未找到该规格项', 'ITEM_NOT_FOUND')
  if (item.countedQty === null || item.countedQty === item.bookQty) {
    throw new InventoryDomainError('只能为差异项填写处置结论', 'NOT_A_VARIANCE')
  }
  const trimmed = note.trim()
  if (!trimmed) {
    throw new InventoryDomainError('处置说明不能为空', 'INVALID_INPUT')
  }
  const disposition: Disposition = { kind, note: trimmed, decidedAt: now }
  return {
    ...batch,
    dispositions: { ...batch.dispositions, [itemIdValue]: disposition },
    updatedAt: now,
  }
}

/** Close a fully reviewed batch (review_required → completed, read-only). */
export function completeBatch(batch: InventoryBatch, now = Date.now()): InventoryBatch {
  if (batch.status !== 'review_required') {
    throw new InventoryDomainError('只有待复核批次可以结案', 'INVALID_STATUS')
  }
  const pending = undisposedVarianceItems(batch)
  if (pending.length > 0) {
    throw new InventoryDomainError(
      `还有 ${pending.length} 个差异未处置，不能结案`,
      'UNDISPOSED_VARIANCES',
    )
  }
  return { ...batch, status: 'completed', completedAt: now, updatedAt: now }
}

/**
 * The single advance action driving the whole lifecycle:
 *   draft → counting → review_required → completed.
 * Gate failures throw InventoryDomainError and leave the batch untouched.
 */
export function advanceBatch(batch: InventoryBatch, now = Date.now()): InventoryBatch {
  switch (batch.status) {
    case 'draft':
      return startCounting(batch, now)
    case 'counting':
      return submitForReview(batch, now)
    case 'review_required':
      return completeBatch(batch, now)
    case 'completed':
      throw new InventoryDomainError('已完成批次只读，不能继续推进', 'READ_ONLY')
  }
}

export const ADVANCE_LABELS: Record<BatchStatus, string> = {
  draft: '开始盘点',
  counting: '提交复核',
  review_required: '结案',
  completed: '已结案',
}

/* ------------------------------------------------------------------------ */
/* Structural validation of records read back from storage                  */
/* ------------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Strictly validate an arbitrary parsed value as an InventoryBatch.
 * Cross-field invariants are checked too (status gates, disposition keys),
 * so anything loaded that would let a batch skip counting or complete with
 * open variances is rejected (and then isolated by the repository).
 * Throws Error with a descriptive reason on the first defect.
 */
export function parseStoredBatch(value: unknown): InventoryBatch {
  if (!isObject(value)) throw new Error('批次不是对象')
  const b = value

  if (typeof b.id !== 'string' || !b.id) throw new Error('批次 id 非法')
  if (typeof b.name !== 'string' || !b.name || b.name.length > BATCH_NAME_MAX) {
    throw new Error('批次名称非法')
  }
  if (typeof b.createdAt !== 'number' || !Number.isFinite(b.createdAt)) {
    throw new Error('createdAt 非法')
  }
  if (typeof b.updatedAt !== 'number' || !Number.isFinite(b.updatedAt)) {
    throw new Error('updatedAt 非法')
  }
  if (!BATCH_STATUSES.includes(b.status as BatchStatus)) throw new Error('status 非法')
  if (!isTimestamp(b.submittedAt)) throw new Error('submittedAt 非法')
  if (!isTimestamp(b.completedAt)) throw new Error('completedAt 非法')
  if (!isObject(b.dispositions)) throw new Error('dispositions 非法')
  if (!Array.isArray(b.items) || b.items.length < BATCH_ITEMS_MIN || b.items.length > BATCH_ITEMS_MAX) {
    throw new Error('items 非法')
  }

  const status = b.status as BatchStatus
  const items: BatchItem[] = []
  const ids = new Set<string>()
  let counted = 0
  for (const raw of b.items) {
    if (!isObject(raw)) throw new Error('规格项不是对象')
    const it = raw
    if (typeof it.id !== 'string' || !it.id) throw new Error('规格项 id 非法')
    if (ids.has(it.id)) throw new Error(`规格项 id 重复: ${it.id}`)
    ids.add(it.id)
    if (it.level !== 'A' && it.level !== 'B') throw new Error('规格项级别非法')
    if (!isShimSpec(it.spec)) throw new Error('规格值非法')
    if (!isNonNegativeInt(it.bookQty)) throw new Error('账面数量非法')
    const hasCount = it.countedQty !== null
    if (!isNonNegativeInt(it.countedQty) && it.countedQty !== null) {
      throw new Error('实点数非法')
    }
    if (!isTimestamp(it.countedAt)) throw new Error('countedAt 非法')
    if (hasCount !== (it.countedAt !== null)) throw new Error('计数与计数时间不一致')
    if (hasCount) counted++
    items.push({
      id: it.id,
      level: it.level,
      spec: it.spec,
      bookQty: it.bookQty,
      countedQty: hasCount ? (it.countedQty as number) : null,
      countedAt: it.countedAt as number | null,
    })
  }

  const dispositions: Record<string, Disposition> = {}
  for (const [key, raw] of Object.entries(b.dispositions)) {
    if (!ids.has(key)) throw new Error(`处置结论指向未知规格项: ${key}`)
    if (!isObject(raw)) throw new Error('处置结论不是对象')
    if (!DISPOSITION_KINDS.includes(raw.kind as DispositionKind)) {
      throw new Error('处置结论类型非法')
    }
    if (typeof raw.note !== 'string' || !raw.note) throw new Error('处置说明非法')
    if (typeof raw.decidedAt !== 'number' || !Number.isFinite(raw.decidedAt)) {
      throw new Error('处置时间非法')
    }
    dispositions[key] = {
      kind: raw.kind as DispositionKind,
      note: raw.note,
      decidedAt: raw.decidedAt,
    }
  }

  // Status-specific invariants.
  if (status === 'draft' && (counted > 0 || b.submittedAt !== null || Object.keys(dispositions).length > 0)) {
    throw new Error('草稿批次不应含计数或处置数据')
  }
  if ((status === 'review_required' || status === 'completed') && counted !== items.length) {
    throw new Error('复核/已完成批次必须全部计数')
  }
  if ((status === 'review_required' || status === 'completed') && b.submittedAt === null) {
    throw new Error('复核/已完成批次缺少提交时间')
  }
  if (status === 'completed' && b.completedAt === null) {
    throw new Error('已完成批次缺少结案时间')
  }
  if (status !== 'completed' && b.completedAt !== null) {
    throw new Error('未结案批次不应有结案时间')
  }

  for (const it of items) {
    const isVariance = it.countedQty !== null && it.countedQty !== it.bookQty
    const hasDisposition = Boolean(dispositions[it.id])
    if (!isVariance && hasDisposition) {
      throw new Error(`非差异项 ${it.id} 不应有处置结论`)
    }
    if (status === 'completed' && isVariance && !hasDisposition) {
      throw new Error(`已完成批次存在未处置差异: ${it.id}`)
    }
  }

  return {
    id: b.id,
    name: b.name,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    status,
    items,
    submittedAt: b.submittedAt as number | null,
    completedAt: b.completedAt as number | null,
    dispositions,
  }
}

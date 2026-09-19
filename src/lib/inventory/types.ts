/**
 * Domain types for the physical shim-set inventory (实物垫片套装盘点).
 *
 * A batch groups A/B-level shim specifications (μm) with their book
 * quantities and walks a fixed lifecycle:
 *
 *   draft ──advance──▶ counting ──advance──▶ review_required ──advance──▶ completed
 *
 * Every transition is produced by the SAME pure advance action
 * (`advanceBatch`); a transition is only legal when its gate is satisfied.
 * `completed` batches are immutable / read-only.
 */

export type BatchStatus = 'draft' | 'counting' | 'review_required' | 'completed'

export const BATCH_STATUSES: readonly BatchStatus[] = [
  'draft',
  'counting',
  'review_required',
  'completed',
]

export type ShimLevel = 'A' | 'B'

/** Disposition conclusions a reviewer may record for one variance. */
export type DispositionKind = 'book_adjust' | 'physical_replenish' | 'write_off' | 'recheck'

export const DISPOSITION_KINDS: readonly DispositionKind[] = [
  'book_adjust',
  'physical_replenish',
  'write_off',
  'recheck',
]

export interface BatchItemInput {
  level: ShimLevel
  /** Specification in μm, integer in [0, 200_000]. */
  spec: number
  /** Book quantity (账面数量), non-negative integer. */
  bookQty: number
}

export interface BatchItem {
  id: string
  level: ShimLevel
  spec: number
  bookQty: number
  /** Actual counted quantity; null until entered. */
  countedQty: number | null
  countedAt: number | null
}

export interface Disposition {
  kind: DispositionKind
  note: string
  decidedAt: number
}

export interface InventoryBatch {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  status: BatchStatus
  items: BatchItem[]
  /** Set when counting finishes and the batch enters review. */
  submittedAt: number | null
  /** Set when the same advance action closes the batch. */
  completedAt: number | null
  /**
   * Variance dispositions keyed by item id. Only variance items
   * (countedQty !== bookQty) carry entries, and only in/after review.
   */
  dispositions: Record<string, Disposition>
}

/** Human-readable status labels (single source for the UI). */
export const STATUS_LABELS: Record<BatchStatus, string> = {
  draft: '已建草稿',
  counting: '盘点中',
  review_required: '待差异复核',
  completed: '已完成',
}

export const DISPOSITION_LABELS: Record<DispositionKind, string> = {
  book_adjust: '调整账面',
  physical_replenish: '实物补足',
  write_off: '核销盘亏',
  recheck: '退回重盘',
}

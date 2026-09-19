/**
 * Framework-agnostic inventory controller.
 *
 * Mutation protocol (the point of this module):
 *   1. derive a legal candidate purely in the domain layer
 *   2. repository.commit() writes → reads back → marks → verifies
 *   3. only on success is the in-memory snapshot (React state) replaced
 *
 * When storage fails the last good snapshot stays visible and the failed
 * candidate is retained as `pendingFailure`, whose `retry()` re-attempts the
 * exact same commit. React binds to this via useSyncExternalStore, so the
 * logic here is fully testable without a DOM.
 */

import {
  advanceBatch,
  createDraft,
  recordCount,
  setDisposition,
  validateItemInputs,
  type InventoryDomainError,
} from './domain'
import type {
  BatchItemInput,
  DispositionKind,
  InventoryBatch,
} from './types'
import type { InventoryRepository, QuarantineEntry, StorageCommitError } from './repository'

export interface PendingFailure {
  message: string
  phase: StorageCommitError['phase']
  candidate: InventoryBatch
  retry: () => void
}

export interface InventorySnapshot {
  loaded: boolean
  batches: InventoryBatch[]
  quarantine: QuarantineEntry[]
  warnings: string[]
  storageError: string | null
  pendingFailure: PendingFailure | null
}

export interface InventoryController {
  getSnapshot(): InventorySnapshot
  subscribe(listener: () => void): () => void
  load(): void
  createBatch(name: string, rows: unknown[]): InventoryBatch
  advance(batchId: string): void
  enterCount(batchId: string, itemId: string, countedQty: number): void
  decide(batchId: string, itemId: string, kind: DispositionKind, note: string): void
  retryPending(): void
  dismissError(): void
  recover(entryId: string): boolean
  discard(entryId: string): boolean
  /** Test seam: commit a pre-built candidate through the same protocol. */
  commitCandidate(candidate: InventoryBatch): void
}

export function generateId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createInventoryController(
  repository: InventoryRepository,
  clock: () => number = Date.now,
): InventoryController {
  let listeners = new Set<() => void>()
  let snapshot: InventorySnapshot = {
    loaded: false,
    batches: [],
    quarantine: [],
    warnings: [],
    storageError: null,
    pendingFailure: null,
  }

  function emit() {
    for (const listener of listeners) listener()
  }

  function setSnapshot(patch: Partial<InventorySnapshot>) {
    snapshot = { ...snapshot, ...patch }
    emit()
  }

  function upsert(batch: InventoryBatch): InventoryBatch[] {
    const rest = snapshot.batches.filter((b) => b.id !== batch.id)
    return [batch, ...rest].sort((p, q) => q.createdAt - p.createdAt)
  }

  function requireBatch(batchId: string): InventoryBatch {
    const batch = snapshot.batches.find((b) => b.id === batchId)
    if (!batch) throw new Error('批次不存在或尚未加载')
    return batch
  }

  function load() {
    const result = repository.loadAll()
    snapshot = {
      loaded: true,
      batches: result.batches,
      quarantine: result.quarantine,
      warnings: result.warnings,
      storageError: null,
      pendingFailure: null,
    }
    emit()
  }

  /**
   * Run the candidate through the staged commit. The in-memory snapshot is
   * replaced only after the commit is verified; otherwise the failure is
   * captured with a retry handle and the previous version keeps showing.
   */
  function commitCandidate(candidate: InventoryBatch): void {
    try {
      repository.commit(candidate)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '存储写入失败，已保留上一版本'
      const phase =
        typeof err === 'object' && err !== null && 'phase' in err
          ? ((err as StorageCommitError).phase)
          : 'write'
      const failure: PendingFailure = {
        message,
        phase,
        candidate,
        retry: () => commitCandidate(candidate),
      }
      setSnapshot({ storageError: message, pendingFailure: failure })
      throw err
    }
    setSnapshot({
      batches: upsert(candidate),
      storageError: null,
      pendingFailure: null,
    })
  }

  function mutate(batchId: string, produce: (batch: InventoryBatch) => InventoryBatch): void {
    const current = requireBatch(batchId)
    const candidate = produce(current) // throws InventoryDomainError before any I/O
    commitCandidate(candidate)
  }

  function createBatch(name: string, rows: unknown[]): InventoryBatch {
    const inputs: BatchItemInput[] = validateItemInputs(rows)
    const candidate = createDraft({ id: generateId(), name, inputs, now: clock() })
    commitCandidate(candidate)
    return candidate
  }

  function advance(batchId: string): void {
    mutate(batchId, (b) => advanceBatch(b, clock()))
  }

  function enterCount(batchId: string, itemIdValue: string, countedQty: number): void {
    mutate(batchId, (b) => recordCount(b, itemIdValue, countedQty, clock()))
  }

  function decide(
    batchId: string,
    itemIdValue: string,
    kind: DispositionKind,
    note: string,
  ): void {
    mutate(batchId, (b) => setDisposition(b, itemIdValue, kind, note, clock()))
  }

  function retryPending(): void {
    snapshot.pendingFailure?.retry()
  }

  function dismissError(): void {
    setSnapshot({ storageError: null, pendingFailure: null })
  }

  function recover(entryId: string): boolean {
    try {
      const batch = repository.recover(entryId)
      setSnapshot({
        batches: upsert(batch),
        quarantine: snapshot.quarantine.filter((e) => e.id !== entryId),
      })
      return true
    } catch (err) {
      setSnapshot({
        storageError: err instanceof Error ? err.message : '恢复失败，已保留隔离状态',
      })
      return false
    }
  }

  function discard(entryId: string): boolean {
    try {
      repository.discard(entryId)
      setSnapshot({ quarantine: snapshot.quarantine.filter((e) => e.id !== entryId) })
      return true
    } catch (err) {
      setSnapshot({
        storageError: err instanceof Error ? err.message : '丢弃失败',
      })
      return false
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load,
    createBatch,
    advance,
    enterCount,
    decide,
    retryPending,
    dismissError,
    recover,
    discard,
    commitCandidate,
  }
}

export type { InventoryDomainError }

/**
 * Versioned localStorage repository for inventory batches.
 *
 * Responsibilities (kept separate from migration RULES in migrations.ts):
 *  - persist each batch in its own versioned key
 *  - staged commits: write candidate → read-back verify → commit marker →
 *    verify marker; only then is the caller allowed to update React state
 *  - on load, validate every record individually; corrupt / incompatible /
 *    uncommitted records are moved to a quarantine area while every other
 *    valid batch remains usable
 *  - surface quota / write / read-back failures as typed errors AFTER
 *    best-effort rollback, so the UI keeps showing the last good version
 *
 * The storage backend is injectable (StorageBackend); production uses
 * window.localStorage, tests use an in-memory double that can fail at any
 * commit phase.
 */

import { parseStoredBatch } from './domain'
import type { InventoryBatch } from './types'
import { CURRENT_STORAGE_VERSION, isEnvelope, migrateToLatest } from './migrations'

const PREFIX = 'shim-inventory/v1/'
const DATA_PREFIX = `${PREFIX}batch/`
const MARK_PREFIX = `${PREFIX}mark/`
const QUARANTINE_KEY = `${PREFIX}quarantine`

export function dataKeyFor(batchId: string): string {
  return `${DATA_PREFIX}${batchId}`
}

function markKeyForData(dataKey: string): string {
  const id = dataKey.slice(DATA_PREFIX.length)
  return `${MARK_PREFIX}${id}`
}

/** Minimal subset of the Storage (localStorage) surface the repo needs. */
export interface StorageBackend {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Optional enumeration; falls back to key()/length when absent. */
  keys?(): string[]
  readonly length?: number
  key?(index: number): string | null
}

export function createBrowserStorage(): StorageBackend | null {
  try {
    const backend = window.localStorage
    const probe = '__shim_inv_probe__'
    backend.setItem(probe, '1')
    backend.removeItem(probe)
    return backend
  } catch {
    return null
  }
}

function enumerateDataKeys(backend: StorageBackend): string[] {
  if (typeof backend.keys === 'function') {
    return backend.keys().filter((k) => k.startsWith(DATA_PREFIX))
  }
  const out: string[] = []
  const length = backend.length ?? 0
  for (let i = 0; i < length; i++) {
    const key = backend.key?.(i)
    if (key && key.startsWith(DATA_PREFIX)) out.push(key)
  }
  return out
}

export type CommitPhase = 'write' | 'readback' | 'commit-marker' | 'verify-marker'

export class StorageCommitError extends Error {
  constructor(
    readonly phase: CommitPhase,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'StorageCommitError'
  }
}

export type QuarantineReason =
  | 'bad_json'
  | 'bad_envelope'
  | 'future_version'
  | 'migration_failed'
  | 'bad_structure'
  | 'uncommitted'

export interface QuarantineEntry {
  /** Stable id for this isolation record. */
  id: string
  dataKey: string
  reason: QuarantineReason
  detail: string
  /** Raw record bytes (omitted when the record could not even be read). */
  raw: string | null
  /** Whether "recover" can plausibly rebuild a valid batch. */
  recoverable: boolean
  createdAt: number
}

export interface LoadResult {
  batches: InventoryBatch[]
  quarantine: QuarantineEntry[]
  /** Non-fatal problems, e.g. quarantine area itself could not be saved. */
  warnings: string[]
}

/** 32-bit FNV-1a over UTF-16 code units; deterministic across environments. */
export function checksum(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    // hash * 16777619 mod 2^32
    hash = Math.imul(hash ^ 0, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

interface CommitMarker {
  checksum: string
  at: number
}

export interface InventoryRepository {
  loadAll(): LoadResult
  /**
   * Staged commit. Throws StorageCommitError after best-effort rollback;
   * on success the data key + marker are durable and match the candidate.
   */
  commit(batch: InventoryBatch): void
  /** Re-validate an isolated record and, if sound, commit it. */
  recover(entryId: string): InventoryBatch
  /** Permanently drop an isolated record and its marker. */
  discard(entryId: string): void
}

export function createInventoryRepository(
  backend: StorageBackend,
  clock: () => number = Date.now,
): InventoryRepository {
  /** Session quarantine; mirrored to storage best-effort. */
  let quarantine: QuarantineEntry[] = []

  function persistQuarantine(): string | null {
    try {
      if (quarantine.length === 0) {
        backend.removeItem(QUARANTINE_KEY)
      } else {
        backend.setItem(QUARANTINE_KEY, JSON.stringify(quarantine))
      }
      return null
    } catch (err) {
      return `隔离区未能写入：${err instanceof Error ? err.message : String(err)}`
    }
  }

  function loadPersistedQuarantine(): QuarantineEntry[] {
    const raw = backend.getItem(QUARANTINE_KEY)
    if (raw === null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      const out: QuarantineEntry[] = []
      for (const item of parsed) {
        if (
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as QuarantineEntry).id === 'string' &&
          typeof (item as QuarantineEntry).dataKey === 'string'
        ) {
          out.push(item as QuarantineEntry)
        }
      }
      return out
    } catch {
      return []
    }
  }

  /**
   * Try to turn raw record bytes into a current-version valid batch.
   * Returns null with a quarantine description when impossible.
   */
  function decodeRecord(
    raw: string,
  ): { batch: InventoryBatch } | { reason: QuarantineReason; detail: string; recoverable: boolean } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return {
        reason: 'bad_json',
        detail: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      }
    }
    if (!isEnvelope(parsed)) {
      return { reason: 'bad_envelope', detail: '缺少版本信封 {v, data}', recoverable: false }
    }
    let migrated: unknown
    try {
      migrated = migrateToLatest(parsed).data
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        reason: message.includes('高于当前支持版本') ? 'future_version' : 'migration_failed',
        detail: message,
        recoverable: false,
      }
    }
    try {
      const batch = parseStoredBatch(migrated)
      return { batch }
    } catch (err) {
      return {
        reason: 'bad_structure',
        detail: err instanceof Error ? err.message : String(err),
        recoverable: false,
      }
    }
  }

  function readMarker(markKey: string): CommitMarker | null {
    const raw = backend.getItem(markKey)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as CommitMarker
      if (typeof parsed.checksum !== 'string' || typeof parsed.at !== 'number') return null
      return parsed
    } catch {
      return null
    }
  }

  function makeQuarantineEntry(
    dataKey: string,
    reason: QuarantineReason,
    detail: string,
    raw: string | null,
    recoverable: boolean,
  ): QuarantineEntry {
    return {
      id: `${dataKey}@${clock()}#${Math.random().toString(36).slice(2, 8)}`,
      dataKey,
      reason,
      detail,
      raw,
      recoverable,
      createdAt: clock(),
    }
  }

  function loadAll(): LoadResult {
    const warnings: string[] = []
    // Records are re-derived from scratch on every load. Previously
    // persisted quarantine rows serve only to keep the notice visible;
    // any record that became valid (or vanished) drops out automatically.
    const nextQuarantine: QuarantineEntry[] = []
    const batches: InventoryBatch[] = []
    const quarantinedKeys = new Set<string>()

    for (const dataKey of enumerateDataKeys(backend)) {
      const raw = backend.getItem(dataKey)
      if (raw === null) continue // dangling enumeration entry

      // Structural validation runs regardless of marker state: a corrupt or
      // incompatible record is reported by its actual defect, while sound
      // bytes lacking/against the marker are "uncommitted" (recoverable).
      const decoded = decodeRecord(raw)
      const marker = readMarker(markKeyForData(dataKey))
      const committed = marker !== null && checksum(raw) === marker.checksum

      if (committed && 'batch' in decoded) {
        batches.push(decoded.batch)
        continue
      }

      quarantinedKeys.add(dataKey)
      if ('batch' in decoded) {
        nextQuarantine.push(
          makeQuarantineEntry(
            dataKey,
            'uncommitted',
            marker ? '提交标记校验不一致' : '缺少提交标记（上次写入未完成）',
            raw,
            true,
          ),
        )
      } else {
        nextQuarantine.push(
          makeQuarantineEntry(
            dataKey,
            decoded.reason,
            decoded.detail,
            raw,
            decoded.recoverable,
          ),
        )
      }
    }

    // Re-attach persisted quarantine metadata (stable ids/timestamps) for
    // records that are still isolated; records missing here healed/vanished.
    const persisted = loadPersistedQuarantine()
    for (const entry of persisted) {
      if (quarantinedKeys.has(entry.dataKey) && !nextQuarantine.some((e) => e.id === entry.id)) {
        const current = nextQuarantine.find((e) => e.dataKey === entry.dataKey)!
        // Keep the fresh reason/detail (they describe the actual bytes).
        nextQuarantine.splice(nextQuarantine.indexOf(current), 1, {
          ...current,
          id: entry.id,
          createdAt: entry.createdAt,
        })
      }
    }

    quarantine = nextQuarantine
    batches.sort((p, q) => q.createdAt - p.createdAt)
    const warning = persistQuarantine()
    if (warning) warnings.push(warning)
    return { batches, quarantine: quarantine.slice(), warnings }
  }

  function commit(batch: InventoryBatch): void {
    const dataKey = dataKeyFor(batch.id)
    const markKey = markKeyForData(dataKey)
    const serialized = JSON.stringify({ v: CURRENT_STORAGE_VERSION, data: batch })
    const expectedChecksum = checksum(serialized)

    const readSafe = (key: string): string | null => {
      try {
        return backend.getItem(key)
      } catch (err) {
        throw new StorageCommitError('write', '存储当前不可读，已取消提交', err)
      }
    }
    const oldData = readSafe(dataKey)
    const oldMark = readSafe(markKey)

    const restoreData = () => {
      try {
        if (oldData === null) backend.removeItem(dataKey)
        else backend.setItem(dataKey, oldData)
      } catch {
        // Rollback itself failed; the record is now an uncommitted key and
        // will be quarantined on the next load rather than silently trusted.
      }
    }
    const restoreMarker = () => {
      try {
        if (oldMark === null) backend.removeItem(markKey)
        else backend.setItem(markKey, oldMark)
      } catch {
        /* best effort */
      }
    }

    // Phase 1 — write the candidate bytes.
    try {
      backend.setItem(dataKey, serialized)
    } catch (err) {
      // The backend may have left truncated bytes behind; restore the last
      // good version so nothing half-written can surface as live data.
      restoreData()
      throw new StorageCommitError(
        'write',
        `写入失败（可能容量不足），仍保留上一版本`,
        err,
      )
    }

    // Phase 2 — read back and compare exactly.
    let readBack: string | null
    try {
      readBack = backend.getItem(dataKey)
    } catch (err) {
      restoreData()
      throw new StorageCommitError('readback', '回读失败，已恢复上一版本', err)
    }
    if (readBack !== serialized) {
      restoreData()
      throw new StorageCommitError(
        'readback',
        '回读内容与写入不一致，已恢复上一版本',
      )
    }

    // Phase 3 — write the commit marker.
    const markerJson = JSON.stringify({ checksum: expectedChecksum, at: clock() })
    try {
      backend.setItem(markKey, markerJson)
    } catch (err) {
      restoreData()
      throw new StorageCommitError(
        'commit-marker',
        '提交标记写入失败（可能容量不足），已恢复上一版本',
        err,
      )
    }

    // Phase 4 — read the marker back; a mismatch invalidates the commit.
    let markerRead: string | null
    try {
      markerRead = backend.getItem(markKey)
    } catch (err) {
      restoreMarker()
      restoreData()
      throw new StorageCommitError('verify-marker', '提交标记回读失败，已恢复上一版本', err)
    }
    if (markerRead !== markerJson) {
      restoreMarker()
      restoreData()
      throw new StorageCommitError('verify-marker', '提交标记回读不一致，已恢复上一版本')
    }
  }

  function recover(entryId: string): InventoryBatch {
    const index = quarantine.findIndex((e) => e.id === entryId)
    if (index < 0) throw new Error('隔离记录不存在')
    const entry = quarantine[index]
    const raw = backend.getItem(entry.dataKey)
    if (raw === null) throw new Error('原始记录已不存在')
    const decoded = decodeRecord(raw)
    if (!('batch' in decoded)) {
      throw new Error(`记录仍无法恢复：${decoded.detail}`)
    }
    commit(decoded.batch)
    quarantine.splice(index, 1)
    persistQuarantine()
    return decoded.batch
  }

  function discard(entryId: string): void {
    const index = quarantine.findIndex((e) => e.id === entryId)
    if (index < 0) return
    const entry = quarantine[index]
    try {
      backend.removeItem(markKeyForData(entry.dataKey))
    } finally {
      try {
        backend.removeItem(entry.dataKey)
      } finally {
        quarantine.splice(index, 1)
        persistQuarantine()
      }
    }
  }

  return { loadAll, commit, recover, discard }
}

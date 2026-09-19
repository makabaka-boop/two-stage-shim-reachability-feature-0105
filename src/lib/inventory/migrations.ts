/**
 * Versioned storage migrations, kept SEPARATE from the repository that
 * moves bytes in and out of localStorage.
 *
 * Each stored batch is wrapped in an envelope `{ v, data }`. Loading runs
 * every migration in order until the current storage version is reached.
 * Records whose version is newer than this build, whose envelope is
 * malformed, or for which a migration throws are isolated by the caller —
 * a broken record never blocks access to the other batches.
 */

import type { InventoryBatch } from './types'

export const CURRENT_STORAGE_VERSION = 1

export interface VersionedEnvelope {
  v: number
  data: unknown
}

/** One step upgrading records from version `from` to `from + 1`. */
export interface Migration {
  from: number
  to: number
  migrate: (data: unknown) => unknown
}

export function isEnvelope(value: unknown): value is VersionedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as VersionedEnvelope).v === 'number' &&
    Number.isInteger((value as VersionedEnvelope).v) &&
    (value as VersionedEnvelope).v >= 0 &&
    'data' in value
  )
}

/* ------------------------------------------------------------------------ */
/* v0 → v1: legacy single-batch shape used by the early盘点 build            */
/* ------------------------------------------------------------------------ */

interface LegacyV0Item {
  level: 'A' | 'B'
  spec: number
  book: number
  actual?: number | null
}

interface LegacyV0Batch {
  batchId?: unknown
  title?: unknown
  created?: unknown
  rows?: unknown
  stage?: unknown
  remarks?: unknown
}

function migrateV0ToV1(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('v0 批次不是对象')
  }
  const legacy = raw as LegacyV0Batch
  const id = typeof legacy.batchId === 'string' && legacy.batchId ? legacy.batchId : ''
  if (!id) throw new Error('v0 批次缺少 batchId')
  const name = typeof legacy.title === 'string' && legacy.title ? legacy.title : '未命名批次'
  const created = typeof legacy.created === 'number' ? legacy.created : Date.now()
  if (!Array.isArray(legacy.rows)) throw new Error('v0 批次 rows 不是数组')

  const items = legacy.rows.map((row: unknown, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`v0 第 ${index + 1} 行不是对象`)
    }
    const r = row as LegacyV0Item
    if (r.level !== 'A' && r.level !== 'B') throw new Error(`v0 第 ${index + 1} 行级别非法`)
    if (typeof r.spec !== 'number' || !Number.isInteger(r.spec) || r.spec < 0 || r.spec > 200000) {
      throw new Error(`v0 第 ${index + 1} 行规格非法`)
    }
    if (typeof r.book !== 'number' || !Number.isInteger(r.book) || r.book < 0) {
      throw new Error(`v0 第 ${index + 1} 行账面数量非法`)
    }
    if (r.actual !== undefined && r.actual !== null) {
      if (typeof r.actual !== 'number' || !Number.isInteger(r.actual) || r.actual < 0) {
        throw new Error(`v0 第 ${index + 1} 行实点数非法`)
      }
    }
    const counted = r.actual ?? null
    return {
      id: `${r.level}-${r.spec}`,
      level: r.level,
      spec: r.spec,
      bookQty: r.book,
      countedQty: counted,
      countedAt: counted === null ? null : created,
    }
  })

  // Duplicate (level, spec) pairs are a v0 corruption signal, not legal data.
  const ids = new Set<string>()
  for (const it of items) {
    if (ids.has(it.id)) throw new Error(`v0 规格重复: ${it.id}`)
    ids.add(it.id)
  }

  const stage = legacy.stage
  const status =
    stage === 'open' ? 'counting' : stage === 'done' ? 'completed' : 'draft'

  return {
    id,
    name,
    createdAt: created,
    updatedAt: created,
    status,
    items,
    submittedAt: status === 'completed' ? created : null,
    completedAt: status === 'completed' ? created : null,
    dispositions: {},
  } satisfies InventoryBatch
}

/** Registry of every supported upgrade step. */
export const MIGRATIONS: readonly Migration[] = [
  { from: 0, to: 1, migrate: migrateV0ToV1 },
]

export interface MigrationResult {
  version: number
  data: unknown
}

/**
 * Run every migration step required to bring an envelope up to the current
 * version. Throws if the record comes from a newer (incompatible) build or
 * if any migration step fails; the caller isolates such records.
 */
export function migrateToLatest(envelope: VersionedEnvelope): MigrationResult {
  let version = envelope.v
  let data: unknown = envelope.data
  if (version > CURRENT_STORAGE_VERSION) {
    throw new Error(`存储版本 ${version} 高于当前支持版本 ${CURRENT_STORAGE_VERSION}`)
  }
  while (version < CURRENT_STORAGE_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version)
    if (!step) throw new Error(`缺少从版本 ${version} 出发的迁移规则`)
    data = step.migrate(data)
    version = step.to
  }
  return { version, data }
}

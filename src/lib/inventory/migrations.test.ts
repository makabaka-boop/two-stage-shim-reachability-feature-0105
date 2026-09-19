import { describe, expect, it } from 'vitest'
import {
  CURRENT_STORAGE_VERSION,
  MIGRATIONS,
  isEnvelope,
  migrateToLatest,
} from './migrations'
import { parseStoredBatch } from './domain'

describe('migration registry', () => {
  it('migration steps are contiguous from 0 to current version', () => {
    let expected = 0
    for (const step of MIGRATIONS) {
      expect(step.from).toBe(expected)
      expect(step.to).toBe(expected + 1)
      expected = step.to
    }
    expect(expected).toBe(CURRENT_STORAGE_VERSION)
  })

  it('passes current-version envelopes through untouched', () => {
    const data = { untouched: true }
    const result = migrateToLatest({ v: CURRENT_STORAGE_VERSION, data })
    expect(result.version).toBe(CURRENT_STORAGE_VERSION)
    expect(result.data).toBe(data)
  })

  it('rejects future versions', () => {
    expect(() => migrateToLatest({ v: CURRENT_STORAGE_VERSION + 1, data: {} })).toThrow(
      /高于当前支持版本/,
    )
  })
})

describe('v0 → v1 legacy batch migration', () => {
  const v0 = {
    batchId: 'legacy-1',
    title: '旧批次',
    created: 12345,
    stage: 'open',
    rows: [
      { level: 'A', spec: 10, book: 5 },
      { level: 'A', spec: 50, book: 8, actual: 7 },
      { level: 'B', spec: 20, book: 3, actual: null },
    ],
    remarks: 'ignored',
  }

  it('maps legacy fields onto the v1 shape and produces a valid batch', () => {
    const { version, data } = migrateToLatest({ v: 0, data: v0 })
    expect(version).toBe(1)
    const batch = parseStoredBatch(data)
    expect(batch.id).toBe('legacy-1')
    expect(batch.name).toBe('旧批次')
    expect(batch.status).toBe('counting')
    expect(batch.items).toEqual([
      { id: 'A-10', level: 'A', spec: 10, bookQty: 5, countedQty: null, countedAt: null },
      { id: 'A-50', level: 'A', spec: 50, bookQty: 8, countedQty: 7, countedAt: 12345 },
      { id: 'B-20', level: 'B', spec: 20, bookQty: 3, countedQty: null, countedAt: null },
    ])
  })

  it('stage=done maps to completed; incomplete legacy completions are rejected', () => {
    // All rows counted but A-50 is a variance (8→7) with no disposition:
    // such an unfinished legacy completion must be isolated on load.
    const incomplete = {
      ...v0,
      stage: 'done',
      rows: [
        { level: 'A', spec: 10, book: 5, actual: 5 },
        { level: 'A', spec: 50, book: 8, actual: 7 },
      ],
    }
    const migrated = migrateToLatest({ v: 0, data: incomplete }).data
    expect(() => parseStoredBatch(migrated)).toThrow(/未处置差异/)

    // Rows never counted cannot be a completed batch either.
    const noCounts = migrateToLatest({
      v: 0,
      data: { ...v0, stage: 'done' },
    }).data
    expect(() => parseStoredBatch(noCounts)).toThrow(/全部计数/)

    // A clean legacy completion (no variances) is a valid v1 batch.
    const clean = {
      ...v0,
      stage: 'done',
      rows: [
        { level: 'A', spec: 10, book: 5, actual: 5 },
        { level: 'B', spec: 20, book: 3, actual: 3 },
      ],
    }
    const done = parseStoredBatch(migrateToLatest({ v: 0, data: clean }).data)
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBe(12345)
  })

  it('defaults missing title/created safely', () => {
    const { data } = migrateToLatest({
      v: 0,
      data: { batchId: 'x', rows: [{ level: 'A', spec: 1, book: 1 }] },
    })
    const batch = parseStoredBatch(data)
    expect(batch.name).toBe('未命名批次')
    expect(typeof batch.createdAt).toBe('number')
  })

  const invalidV0: [string, unknown][] = [
    ['not an object', 42],
    ['missing batchId', { rows: [] }],
    ['rows not array', { batchId: 'x', rows: {} }],
    ['bad level', { batchId: 'x', rows: [{ level: 'C', spec: 1, book: 1 }] }],
    ['bad spec', { batchId: 'x', rows: [{ level: 'A', spec: 300000, book: 1 }] }],
    ['bad book', { batchId: 'x', rows: [{ level: 'A', spec: 1, book: -1 }] }],
    ['bad actual', { batchId: 'x', rows: [{ level: 'A', spec: 1, book: 1, actual: 0.5 }] }],
    ['duplicate specs', {
      batchId: 'x',
      rows: [
        { level: 'A', spec: 1, book: 1 },
        { level: 'A', spec: 1, book: 2 },
      ],
    }],
  ]
  for (const [label, data] of invalidV0) {
    it(`illegal migration throws: ${label}`, () => {
      expect(() => migrateToLatest({ v: 0, data })).toThrow()
    })
  }

  it('envelope detection', () => {
    expect(isEnvelope({ v: 0, data: {} })).toBe(true)
    expect(isEnvelope({ v: '1', data: {} })).toBe(false)
    expect(isEnvelope(null)).toBe(false)
    expect(isEnvelope({ data: {} })).toBe(false)
    expect(() => migrateToLatest({ v: 0, data: { poison: true } })).toThrow()
  })
})

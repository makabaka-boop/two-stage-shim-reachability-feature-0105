import { describe, expect, it } from 'vitest'
import {
  ADVANCE_LABELS,
  InventoryDomainError,
  advanceBatch,
  completeBatch,
  createDraft,
  parseStoredBatch,
  recordCount,
  setDisposition,
  startCounting,
  submitForReview,
  uncountedItems,
  undisposedVarianceItems,
  varianceItems,
} from './domain'

const T0 = 1_700_000_000_000

import type { BatchItemInput } from './types'

function rows(
  extra: BatchItemInput[] = [],
): BatchItemInput[] {
  return [
    { level: 'A', spec: 10, bookQty: 5 },
    { level: 'A', spec: 50, bookQty: 8 },
    { level: 'B', spec: 20, bookQty: 3 },
    ...extra,
  ]
}

function draft(now = T0, name = '批次一') {
  return createDraft({ id: 'b1', name, inputs: rows(), now })
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(InventoryDomainError)
    expect((err as InventoryDomainError).code).toBe(code)
    return
  }
  throw new Error(`expected InventoryDomainError(${code})`)
}

function counted(now = T0, counts: Record<string, number> = { 'A-10': 5, 'A-50': 7, 'B-20': 3 }) {
  let b = startCounting(draft(now), now + 1)
  for (const [id, qty] of Object.entries(counts)) {
    b = recordCount(b, id, qty, now + 2)
  }
  return b
}

describe('createDraft — validation', () => {
  it('builds a legal draft with A/B rows and null counts', () => {
    const b = draft()
    expect(b.status).toBe('draft')
    expect(b.items).toHaveLength(3)
    expect(b.items.map((i) => [i.id, i.level, i.spec, i.bookQty, i.countedQty])).toEqual([
      ['A-10', 'A', 10, 5, null],
      ['A-50', 'A', 50, 8, null],
      ['B-20', 'B', 20, 3, null],
    ])
    expect(b.submittedAt).toBeNull()
    expect(b.completedAt).toBeNull()
    expect(b.dispositions).toEqual({})
  })

  it('rejects empty / missing / oversized row lists', () => {
    expect(() => createDraft({ id: 'x', name: 'n', inputs: [], now: T0 })).toThrow(
      InventoryDomainError,
    )
    expectCode('INVALID_INPUT', () =>
      createDraft({ id: 'x', name: 'n', inputs: 'not array' as never, now: T0 }),
    )
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({
      level: 'A' as const,
      spec: i % 200001,
      bookQty: 1,
    }))
    expectCode(
      'INVALID_INPUT',
      () => createDraft({ id: 'x', name: 'n', inputs: tooMany, now: T0 }),
    )
  })

  it('rejects bad level/spec/qty', () => {
    const cases: unknown[] = [
      rows([{ level: 'C' as never, spec: 1, bookQty: 1 }]),
      rows([{ level: 'A', spec: 200001, bookQty: 1 }]),
      rows([{ level: 'A', spec: -1, bookQty: 1 }]),
      rows([{ level: 'A', spec: 1.5, bookQty: 1 }]),
      rows([{ level: 'A', spec: 1, bookQty: -1 }]),
      rows([{ level: 'A', spec: 1, bookQty: 1.5 }]),
      rows([{ level: 'A', spec: 1, bookQty: NaN }]),
      rows([{ level: 'A', spec: 1, bookQty: Infinity }]),
      null,
      [{ level: 'A' }],
    ]
    for (const inputs of cases) {
      expect(
        () => createDraft({ id: 'x', name: 'n', inputs: inputs as never, now: T0 }),
        JSON.stringify(inputs),
      ).toThrow(InventoryDomainError)
    }
  })

  it('rejects duplicate (level, spec) pairs but allows same spec across levels', () => {
    expect(() =>
      createDraft({
        id: 'x',
        name: 'n',
        inputs: [
          { level: 'A', spec: 10, bookQty: 1 },
          { level: 'A', spec: 10, bookQty: 2 },
        ],
        now: T0,
      }),
    ).toThrow('重复')
    const ok = createDraft({
      id: 'x',
      name: 'n',
      inputs: [
        { level: 'A', spec: 10, bookQty: 1 },
        { level: 'B', spec: 10, bookQty: 2 },
      ],
      now: T0,
    })
    expect(ok.items).toHaveLength(2)
  })

  it('rejects blank or too-long names and trims valid ones', () => {
    expectCode('INVALID_INPUT', () =>
      createDraft({ id: 'x', name: '  ', inputs: rows(), now: T0 }),
    )
    expectCode('INVALID_INPUT', () =>
      createDraft({ id: 'x', name: 'x'.repeat(81), inputs: rows(), now: T0 }),
    )
    expect(createDraft({ id: 'x', name: '  名称  ', inputs: rows(), now: T0 }).name).toBe('名称')
  })
})

describe('lifecycle — draft → counting → review_required → completed', () => {
  it('draft advances to counting; counting cannot submit until complete', () => {
    const d = draft()
    expect(ADVANCE_LABELS[d.status]).toBe('开始盘点')
    const counting = advanceBatch(d, T0 + 1)
    expect(counting.status).toBe('counting')
    expect(counting.updatedAt).toBe(T0 + 1)

    expectCode('UNCOUNTED_ITEMS', () => submitForReview(counting, T0 + 2))
    expectCode('UNCOUNTED_ITEMS', () => advanceBatch(counting, T0 + 2))
    // original draft untouched (pure)
    expect(d.status).toBe('draft')
  })

  it('counting only accepts counts; unknown items and bad qty rejected', () => {
    const c = startCounting(draft())
    expectCode('INVALID_INPUT', () => recordCount(c, 'A-10', -1))
    expectCode('INVALID_INPUT', () => recordCount(c, 'A-10', 1.2))
    expectCode('ITEM_NOT_FOUND', () => recordCount(c, 'A-999', 1))
    expectCode('INVALID_STATUS', () => recordCount(draft(), 'A-10', 1))
  })

  it('all counted → review; missing counts block the gate', () => {
    const c = startCounting(draft(), T0 + 1)
    const c1 = recordCount(c, 'A-10', 5, T0 + 2)
    expect(uncountedItems(c1).map((i) => i.id)).toEqual(['A-50', 'B-20'])
    const c2 = recordCount(c1, 'A-50', 7, T0 + 3)
    const c3 = recordCount(c2, 'B-20', 3, T0 + 4)
    const review = advanceBatch(c3, T0 + 5)
    expect(review.status).toBe('review_required')
    expect(review.submittedAt).toBe(T0 + 5)
    expect(varianceItems(review).map((i) => i.id)).toEqual(['A-50'])
  })

  it('review requires a disposition per variance; equal items excluded', () => {
    const r = submitForReview(counted(), T0 + 10)
    expectCode('NOT_A_VARIANCE', () => setDisposition(r, 'A-10', 'write_off', '说明'))
    expectCode('INVALID_INPUT', () => setDisposition(r, 'A-50', 'bogus' as never, '说明'))
    expectCode('INVALID_INPUT', () => setDisposition(r, 'A-50', 'write_off', '   '))
    expect(undisposedVarianceItems(r).map((i) => i.id)).toEqual(['A-50'])
    expectCode('UNDISPOSED_VARIANCES', () => advanceBatch(r, T0 + 11))
    expectCode('UNDISPOSED_VARIANCES', () => completeBatch(r, T0 + 11))

    const decided = setDisposition(r, 'A-50', 'book_adjust', '账实相符修正', T0 + 12)
    expect(decided.dispositions['A-50']).toEqual({
      kind: 'book_adjust',
      note: '账实相符修正',
      decidedAt: T0 + 12,
    })
    const done = advanceBatch(decided, T0 + 13)
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBe(T0 + 13)
  })

  it('completed batches are read-only', () => {
    const done = advanceBatch(
      setDisposition(submitForReview(counted(), T0 + 10), 'A-50', 'recheck', '重盘', T0 + 11),
      T0 + 12,
    )
    expect(ADVANCE_LABELS.completed).toBe('已结案')
    expectCode('READ_ONLY', () => advanceBatch(done))
    expectCode('READ_ONLY', () => recordCount(done, 'A-10', 1))
    expectCode('READ_ONLY', () => setDisposition(done, 'A-50', 'write_off', 'x'))
  })

  it('counts can be corrected while counting; timestamps update', () => {
    let c = startCounting(draft(), T0 + 1)
    c = recordCount(c, 'A-10', 9, T0 + 2)
    c = recordCount(c, 'A-10', 5, T0 + 3)
    expect(c.items[0].countedQty).toBe(5)
    expect(c.items[0].countedAt).toBe(T0 + 3)
  })

  it('zero-count variance must also be disposed', () => {
    const d = createDraft({
      id: 'z',
      name: 'zero',
      inputs: [{ level: 'A', spec: 1, bookQty: 4 }],
      now: T0,
    })
    let b = startCounting(d, T0 + 1)
    b = recordCount(b, 'A-1', 0, T0 + 2)
    b = submitForReview(b, T0 + 3)
    expect(varianceItems(b)).toHaveLength(1)
    expectCode('UNDISPOSED_VARIANCES', () => completeBatch(b))
    b = setDisposition(b, 'A-1', 'write_off', '盘亏核销')
    expect(advanceBatch(b).status).toBe('completed')
  })
})

describe('parseStoredBatch — structural validation of loaded records', () => {
  const good = JSON.parse(JSON.stringify(advanceBatch(
    setDisposition(submitForReview(counted(), T0 + 10), 'A-50', 'book_adjust', 'ok', T0 + 11),
    T0 + 12,
  )))

  it('accepts a valid batch at each status', () => {
    expect(parseStoredBatch(JSON.parse(JSON.stringify(draft()))).status).toBe('draft')
    expect(parseStoredBatch(good).status).toBe('completed')
  })

  const bad: [string, unknown][] = [
    ['not object', null],
    ['missing id', { ...good, id: '' }],
    ['bad status', { ...good, status: 'frozen' }],
    ['bad timestamp', { ...good, createdAt: 'x' }],
    ['items not array', { ...good, items: [] }],
    ['bad item level', { ...good, items: good.items.map((i: object) => ({ ...i, level: 'Z' })) }],
    ['bad spec', { ...good, items: good.items.map((i: object) => ({ ...i, spec: 1.5 })) }],
    ['bad book qty', { ...good, items: good.items.map((i: object) => ({ ...i, bookQty: -2 })) }],
    [
      'count without time',
      { ...good, items: good.items.map((i: object, idx: number) => idx === 0 ? { ...i, countedAt: null } : i) },
    ],
    [
      'duplicate item id',
      { ...good, items: [...good.items, { ...good.items[0] }] },
    ],
    ['bad disposition kind', { ...good, dispositions: { 'A-50': { kind: 'nope', note: 'x', decidedAt: 1 } } }],
    ['empty disposition note', { ...good, dispositions: { 'A-50': { kind: 'recheck', note: '', decidedAt: 1 } } }],
    ['disposition for unknown item', { ...good, dispositions: { 'A-999': { kind: 'recheck', note: 'x', decidedAt: 1 } } }],
    ['disposition for non-variance', { ...good, dispositions: { ...good.dispositions, 'A-10': { kind: 'recheck', note: 'x', decidedAt: 1 } } }],
    ['completed missing completedAt', { ...good, completedAt: null }],
    ['review with uncounted item', (() => {
      const r = JSON.parse(JSON.stringify(submitForReview(counted(), T0 + 10)))
      r.items[0].countedQty = null
      r.items[0].countedAt = null
      return r
    })()],
    ['draft carrying counts', (() => {
      const d = JSON.parse(JSON.stringify(draft()))
      d.items[0].countedQty = 1
      d.items[0].countedAt = T0
      return d
    })()],
    ['completed with undisposed variance', (() => {
      const c = JSON.parse(JSON.stringify(good))
      delete c.dispositions['A-50']
      return c
    })()],
  ]

  for (const [label, value] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => parseStoredBatch(value)).toThrow()
    })
  }
})

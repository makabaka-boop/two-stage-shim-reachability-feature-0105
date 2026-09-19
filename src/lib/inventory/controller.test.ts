/**
 * Acceptance suite for the full mutation protocol through the controller:
 * failed writes must not leak into React-facing state, retries must commit,
 * mixed good/bad storage must keep good batches countable, and the
 * completion gate / read-only rule must hold through the same advance action.
 */

import { describe, expect, it } from 'vitest'
import { createInventoryController, type InventoryController } from './controller'
import { createInventoryRepository, dataKeyFor, StorageCommitError } from './repository'
import { FakeStorage, makeQuotaError } from './testing'
import { InventoryDomainError } from './domain'

const T = 1_700_000_000_000
let clockNow = T
const clock = () => clockNow

function setup() {
  clockNow = T
  const storage = new FakeStorage()
  const repo = createInventoryRepository(storage, clock)
  const controller = createInventoryController(repo, clock)
  controller.load()
  return { storage, repo, controller }
}

function rows() {
  return [
    { level: 'A' as const, spec: 10, bookQty: 5 },
    { level: 'A' as const, spec: 50, bookQty: 8 },
    { level: 'B' as const, spec: 20, bookQty: 3 },
  ]
}

/** Fully count with one variance (A-50: 8 → 7). */
function countEverything(controller: InventoryController, id: string) {
  controller.enterCount(id, 'A-10', 5)
  controller.enterCount(id, 'A-50', 7)
  controller.enterCount(id, 'B-20', 3)
}

describe('controller — full lifecycle through one advance action', () => {
  it('walks draft → counting → review_required → completed, then read-only', () => {
    const { controller } = setup()
    const batch = controller.createBatch('周一盘点', rows())
    const id = batch.id
    const status = () => controller.getSnapshot().batches.find((b) => b.id === id)!.status

    expect(status()).toBe('draft')
    controller.advance(id) // draft → counting
    expect(status()).toBe('counting')

    // Gate: advance before counting completes is rejected before any I/O.
    expect(() => controller.advance(id)).toThrow(InventoryDomainError)
    expect(status()).toBe('counting')

    countEverything(controller, id)
    controller.advance(id) // counting → review_required
    expect(status()).toBe('review_required')

    // Gate: variance must be disposed before the same advance can close.
    expect(() => controller.advance(id)).toThrow(InventoryDomainError)
    expect(status()).toBe('review_required')
    controller.decide(id, 'A-50', 'book_adjust', '账实修正')
    controller.advance(id) // review_required → completed
    expect(status()).toBe('completed')

    const done = controller.getSnapshot().batches.find((b) => b.id === id)!
    expect(done.completedAt).not.toBeNull()
    expect(done.dispositions['A-50'].note).toBe('账实修正')

    // Read-only constraints at the controller boundary.
    expect(() => controller.advance(id)).toThrow(InventoryDomainError)
    expect(() => controller.enterCount(id, 'A-10', 1)).toThrow(InventoryDomainError)
    expect(() => controller.decide(id, 'A-50', 'write_off', 'x')).toThrow(InventoryDomainError)
  })

  it('progress and dispositions survive a reload (refresh restores state)', () => {
    const { storage, controller } = setup()
    const id = controller.createBatch('刷新测试', rows()).id
    controller.advance(id)
    countEverything(controller, id)
    controller.advance(id)
    controller.decide(id, 'A-50', 'recheck', '退回重盘说明')

    const fresh = createInventoryController(createInventoryRepository(storage, clock), clock)
    fresh.load()
    const batch = fresh.getSnapshot().batches.find((b) => b.id === id)!
    expect(batch.status).toBe('review_required')
    expect(batch.items.map((i) => i.countedQty)).toEqual([5, 7, 3])
    expect(batch.dispositions['A-50'].kind).toBe('recheck')

    // Resume and finish from the restored state.
    fresh.advance(id)
    expect(fresh.getSnapshot().batches[0].status).toBe('completed')
  })
})

describe('controller — failed writes never leak and are retryable', () => {
  it('create failure leaves empty state; retry of the same candidate succeeds', () => {
    const { storage, controller } = setup()
    storage.failNextSet(() => true, null)
    let thrown: unknown
    try {
      controller.createBatch('不会出现', rows())
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(StorageCommitError)

    const snap = controller.getSnapshot()
    expect(snap.batches).toEqual([])
    expect(snap.storageError).toMatch(/容量|写入失败/)
    expect(snap.pendingFailure).not.toBeNull()
    // No batch keys were left behind.
    expect(storage.keys().some((k) => k.includes('/batch/'))).toBe(false)

    // Same candidate retried once storage recovers → state updates.
    controller.retryPending()
    expect(controller.getSnapshot().batches).toHaveLength(1)
    expect(controller.getSnapshot().storageError).toBeNull()
  })

  it('readback / marker-write / marker-verify failures each roll back and retry', () => {
    const { storage, controller } = setup()
    const cases = [
      {
        phase: 'readback' as const,
        inject: (id: string) =>
          storage.faultNextGet((k) => k === dataKeyFor(id), '"garbage"', true, 1),
      },
      {
        phase: 'commit-marker' as const,
        inject: () =>
          storage.throwOnNextSet((k) => k.includes('/mark/'), makeQuotaError()),
      },
      {
        phase: 'verify-marker' as const,
        inject: () =>
          storage.faultNextGet((k) => k.includes('/mark/'), '{"checksum":"0","at":0}', true, 1),
      },
    ]

    for (const { phase, inject } of cases) {
      const id = controller.createBatch(`批次-${phase}`, rows()).id
      inject(id)
      let err: unknown
      try {
        controller.advance(id)
      } catch (caught) {
        err = caught
      }
      expect(err).toBeInstanceOf(StorageCommitError)
      expect((err as StorageCommitError).phase).toBe(phase)

      // Last good version is still the draft; failure is retryable.
      const pending = controller.getSnapshot().pendingFailure
      expect(pending!.phase).toBe(phase)
      expect(controller.getSnapshot().batches.find((b) => b.id === id)!.status).toBe('draft')

      controller.retryPending()
      expect(controller.getSnapshot().batches.find((b) => b.id === id)!.status).toBe('counting')
    }

    // Storage agrees with the UI: three committed counting batches,
    // no leaked/uncommitted keys.
    const reloaded = createInventoryRepository(storage, clock).loadAll()
    expect(reloaded.batches).toHaveLength(3)
    expect(reloaded.batches.every((b) => b.status === 'counting')).toBe(true)
    expect(reloaded.quarantine).toHaveLength(0)
  })

  it('in-flight count failure retains previous counts; retry writes the new one', () => {
    const { storage, controller } = setup()
    const id = controller.createBatch('计数失败', rows()).id
    controller.advance(id)
    controller.enterCount(id, 'A-10', 5)

    storage.failNextSet((k) => k === dataKeyFor(id), null)
    expect(() => controller.enterCount(id, 'A-50', 7)).toThrow(StorageCommitError)

    const batch = controller.getSnapshot().batches.find((b) => b.id === id)!
    // Last good version: A-10 counted, A-50 still null.
    expect(batch.items.find((i) => i.id === 'A-10')!.countedQty).toBe(5)
    expect(batch.items.find((i) => i.id === 'A-50')!.countedQty).toBeNull()

    controller.retryPending()
    const after = controller.getSnapshot().batches.find((b) => b.id === id)!
    expect(after.items.find((i) => i.id === 'A-50')!.countedQty).toBe(7)
  })
})

describe('controller — mixed good/bad records on load', () => {
  it('valid batches stay countable while corrupt records show recovery notices', () => {
    const { storage, controller } = setup()
    const goodId = controller.createBatch('正常批次', rows()).id

    // Inject corruption and an incompatible future record directly.
    storage.rawMap.set(dataKeyFor('broken'), '{broken json')
    storage.rawMap.set(dataKeyFor('future'), JSON.stringify({ v: 99, data: {} }))

    const reloaded = createInventoryController(createInventoryRepository(storage, clock), clock)
    reloaded.load()
    const snap = reloaded.getSnapshot()
    expect(snap.batches.map((b) => b.id)).toEqual([goodId])
    expect(snap.quarantine).toHaveLength(2)
    expect(snap.quarantine.every((q) => q.raw !== null || q.reason === 'bad_json')).toBe(true)

    // The good batch can still be worked end to end.
    reloaded.advance(goodId)
    countEverything(reloaded, goodId)
    reloaded.advance(goodId)
    reloaded.decide(goodId, 'A-50', 'write_off', '盘亏')
    reloaded.advance(goodId)
    expect(reloaded.getSnapshot().batches[0].status).toBe('completed')

    // Discarding an isolated record leaves the good one intact.
    const brokenId = snap.quarantine.find((q) => q.dataKey.includes('broken'))!.id
    reloaded.discard(brokenId)
    const again = createInventoryController(createInventoryRepository(storage, clock), clock)
    again.load()
    expect(again.getSnapshot().batches).toHaveLength(1)
    expect(again.getSnapshot().quarantine).toHaveLength(1)
  })
})

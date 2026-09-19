import { describe, expect, it } from 'vitest'
import {
  StorageCommitError,
  checksum,
  createInventoryRepository,
  dataKeyFor,
} from './repository'
import { CURRENT_STORAGE_VERSION } from './migrations'
import {
  advanceBatch,
  createDraft,
  recordCount,
  setDisposition,
  startCounting,
  submitForReview,
} from './domain'
import { FakeStorage, makeQuotaError } from './testing'

const T = 1_700_000_000_000

function makeBatch(id: string, now = T) {
  const draft = createDraft({
    id,
    name: `批次-${id}`,
    inputs: [
      { level: 'A' as const, spec: 10, bookQty: 5 },
      { level: 'B' as const, spec: 20, bookQty: 2 },
    ],
    now,
  })
  return draft
}

/** Advance a fresh batch all the way to completed. */
function makeCompleted(id: string, now = T) {
  let b = startCounting(makeBatch(id, now), now + 1)
  b = recordCount(b, 'A-10', 4, now + 2) // variance
  b = recordCount(b, 'B-20', 2, now + 3)
  b = submitForReview(b, now + 4)
  b = setDisposition(b, 'A-10', 'book_adjust', '按实点修正', now + 5)
  b = advanceBatch(b, now + 6)
  return b
}

describe('repository — happy path', () => {
  it('round-trips a batch through envelope + marker and reloads it', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    const batch = makeCompleted('b1')
    repo.commit(batch)

    // Data key and a separate marker key exist.
    const dataKey = dataKeyFor('b1')
    expect(storage.getItem(dataKey)).not.toBeNull()
    const envelope = JSON.parse(storage.getItem(dataKey)!)
    expect(envelope.v).toBe(CURRENT_STORAGE_VERSION)
    expect(envelope.data.id).toBe('b1')
    const marker = JSON.parse(storage.getItem(dataKey.replace('/batch/', '/mark/'))!)
    expect(marker.checksum).toBe(checksum(storage.getItem(dataKey)!))

    const reloaded = createInventoryRepository(storage, () => T)
    const result = reloaded.loadAll()
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0]).toEqual(batch)
    expect(result.quarantine).toHaveLength(0)
  })

  it('overwrites in place: latest commit wins and old marker stays valid', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    const v1 = makeBatch('b1', T)
    repo.commit(v1)
    const v2 = startCounting(v1, T + 10)
    repo.commit(v2)
    const result = repo.loadAll()
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0].status).toBe('counting')
    expect(result.batches[0].updatedAt).toBe(T + 10)
  })
})

describe('repository — staged commit failures never leak', () => {
  it('phase=write: quota on the data key leaves NO partial record visible', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)

    // First create succeeds (last good version).
    const v1 = makeBatch('b1')
    repo.commit(v1)

    const v2 = startCounting(v1, T + 1)
    storage.failNextSet((k) => k === dataKeyFor('b1'), null)
    let phase = ''
    try {
      repo.commit(v2)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(StorageCommitError)
      phase = (err as StorageCommitError).phase
    }
    expect(phase).toBe('write')

    // Storage holds no candidate bytes; reload still yields the draft.
    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0].status).toBe('draft')
    expect(result.quarantine).toHaveLength(0)
  })

  it('phase=write: truncated bytes left behind are restored to the old version', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('b1'))
    const v2 = startCounting(makeBatch('b1'), T + 1)

    // setItem throws quota error but leaves truncated bytes behind; the
    // repository must roll those bytes back rather than trust them.
    storage.failNextSet((k) => k === dataKeyFor('b1'))
    let caught: unknown
    try {
      repo.commit(v2)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(StorageCommitError)
    expect((caught as StorageCommitError).phase).toBe('write')

    // Reload yields the last good version with no quarantine noise.
    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0].status).toBe('draft')
    expect(result.quarantine).toHaveLength(0)
  })

  it('phase=write: quota leaves no bytes for a brand-new batch (clean isolation)', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('b1'))
    const v2 = startCounting(makeBatch('b1'), T + 1)

    // Candidate write leaves truncated bytes AND the rollback write fails too.
    storage.failNextSet((k) => k === dataKeyFor('b1'))
    storage.throwOnNextSet((k) => k === dataKeyFor('b1'), makeQuotaError())
    expect(() => repo.commit(v2)).toThrow(StorageCommitError)

    // No candidate leaked into a "committed" view; stranded bytes are
    // isolated on reload (rollback could not restore the marker match).
    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.quarantine).toHaveLength(1)
    expect(result.batches).toHaveLength(0)
  })

  it('phase=readback: mismatched read data rolls back and keeps last good version', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    const v1 = makeBatch('b1')
    repo.commit(v1)
    const v2 = startCounting(v1, T + 1)

    // The write succeeds but reading the key returns garbage (flaky storage).
    // Skip the pre-commit read of the old value; fault the phase-2 read-back.
    storage.faultNextGet((k) => k === dataKeyFor('b1'), '{"v":1,"data":{"corrupt":true}}', true, 1)
    let err2: unknown
    try {
      repo.commit(v2)
    } catch (caught) {
      err2 = caught
    }
    expect(err2).toBeInstanceOf(StorageCommitError)
    expect((err2 as StorageCommitError).phase).toBe('readback')

    // Rollback re-wrote v1; the marker still matches v1.
    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0].status).toBe('draft')
  })

  it('phase=readback: thrown read error is reported as readback failure', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('b1'))
    const v2 = startCounting(makeBatch('b1'), T + 1)
    // Skip the pre-read; fault the phase-2 read-back itself.
    storage.throwOnNextGet((k) => k === dataKeyFor('b1'), new Error('boom'), true, 1)
    try {
      repo.commit(v2)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(StorageCommitError)
      expect((err as StorageCommitError).phase).toBe('readback')
    }
    // Rollback restored the last good bytes.
    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches[0].status).toBe('draft')
  })

  it('phase=commit-marker: failure after data write rolls data back', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('b1'))
    const v2 = startCounting(makeBatch('b1'), T + 1)

    const markKey = dataKeyFor('b1').replace('/batch/', '/mark/')
    storage.throwOnNextSet((k) => k === markKey, makeQuotaError(markKey))
    let err: unknown
    try {
      repo.commit(v2)
    } catch (caught) {
      err = caught
    }
    expect(err).toBeInstanceOf(StorageCommitError)
    expect((err as StorageCommitError).phase).toBe('commit-marker')

    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches[0].status).toBe('draft')
    expect(result.quarantine).toHaveLength(0)
  })

  it('phase=verify-marker: bad marker readback rolls both back', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('b1'))
    const v2 = startCounting(makeBatch('b1'), T + 1)

    const markKey = dataKeyFor('b1').replace('/batch/', '/mark/')
    // Only earlier mark-key read is the pre-commit old-marker capture.
    storage.faultNextGet(
      (k) => k === markKey,
      JSON.stringify({ checksum: 'deadbeef', at: T }),
      true,
      1,
    )
    let err: unknown
    try {
      repo.commit(v2)
    } catch (caught) {
      err = caught
    }
    expect(err).toBeInstanceOf(StorageCommitError)
    expect((err as StorageCommitError).phase).toBe('verify-marker')

    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches[0].status).toBe('draft')
  })

  it('first-ever write failing leaves no keys and an empty clean reload', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    storage.failNextSet((k) => k === dataKeyFor('new'), null)
    expect(() => repo.commit(makeBatch('new'))).toThrow(StorageCommitError)
    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches).toEqual([])
    expect(result.quarantine).toEqual([])
    expect(storage.keys().filter((k) => k.includes('/batch/') || k.includes('/mark/'))).toEqual([])
  })

  it('quota budget exhaustion on oversized candidate keeps the old version', () => {
    const storage = new FakeStorage({ quotaBytes: 400 })
    const repo = createInventoryRepository(storage, () => T)
    const small = createDraft({
      id: 'q1',
      name: '小',
      inputs: [{ level: 'A' as const, spec: 1, bookQty: 1 }],
      now: T,
    })
    repo.commit(small)

    const big = createDraft({
      id: 'q1',
      name: '大'.repeat(60),
      inputs: Array.from({ length: 40 }, (_, i) => ({
        level: 'A' as const,
        spec: i,
        bookQty: i,
      })),
      now: T + 1,
    })
    expect(() => repo.commit(big)).toThrow(StorageCommitError)
    const result = createInventoryRepository(storage, () => T).loadAll()
    expect(result.batches[0].name).toBe('小')
  })
})

describe('repository — quarantine on load', () => {
  it('isolates malformed JSON and keeps valid batches countable', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('good'))
    storage.rawMap.set(dataKeyFor('bad1'), '{not json')
    storage.rawMap.set(dataKeyFor('bad2'), '{"v":1,"data":{"no":"shape"}}')

    const result = repo.loadAll()
    expect(result.batches.map((b) => b.id)).toEqual(['good'])
    expect(result.quarantine).toHaveLength(2)
    expect(result.quarantine.map((q) => q.reason).sort()).toEqual(['bad_json', 'bad_structure'])
    expect(result.quarantine.every((q) => !q.recoverable)).toBe(true)

    // A fresh repository instance sees the same persisted quarantine notice.
    const again = createInventoryRepository(storage, () => T).loadAll()
    expect(again.batches).toHaveLength(1)
    expect(again.quarantine).toHaveLength(2)
  })

  it('isolates future-version and failed-migration records individually', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    storage.rawMap.set(dataKeyFor('future'), JSON.stringify({ v: 99, data: {} }))
    storage.rawMap.set(
      dataKeyFor('oldbad'),
      JSON.stringify({ v: 0, data: { rows: 'not-array' } }),
    )
    storage.rawMap.set(dataKeyFor('noenv'), JSON.stringify({ hello: 1 }))
    repo.commit(makeBatch('good'))

    const result = repo.loadAll()
    const reasons = Object.fromEntries(
      result.quarantine.map((q) => [q.dataKey.split('/').pop(), q.reason]),
    )
    expect(reasons.future).toBe('future_version')
    expect(reasons.oldbad).toBe('migration_failed')
    expect(reasons.noenv).toBe('bad_envelope')
    expect(result.batches.map((b) => b.id)).toEqual(['good'])
  })

  it('a legacy record whose migration RULE rejects it is isolated, others unaffected', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)

    // Valid legacy v0 batch (committed bytes + marker).
    const legacyRaw = JSON.stringify({
      v: 0,
      data: {
        batchId: 'legacy-ok',
        title: '合法旧批次',
        created: T,
        stage: 'draft',
        rows: [{ level: 'A', spec: 1, book: 2 }],
      },
    })
    storage.rawMap.set(dataKeyFor('legacy-ok'), legacyRaw)
    storage.rawMap.set(
      dataKeyFor('legacy-ok').replace('/batch/', '/mark/'),
      JSON.stringify({ checksum: checksum(legacyRaw), at: T }),
    )

    // Legacy v0 record that makes the migration RULE itself throw.
    const brokenRaw = JSON.stringify({
      v: 0,
      data: { batchId: 'legacy-bad', rows: 'definitely-not-an-array' },
    })
    storage.rawMap.set(dataKeyFor('legacy-bad'), brokenRaw)
    storage.rawMap.set(
      dataKeyFor('legacy-bad').replace('/batch/', '/mark/'),
      JSON.stringify({ checksum: checksum(brokenRaw), at: T }),
    )

    const result = repo.loadAll()
    expect(result.batches.map((b) => b.id)).toEqual(['legacy-ok'])
    expect(result.quarantine).toHaveLength(1)
    expect(result.quarantine[0].reason).toBe('migration_failed')
    expect(result.quarantine[0].dataKey).toContain('legacy-bad')
    expect(result.quarantine[0].recoverable).toBe(false)
  })

  it('migrates a valid v0 record into v1 without touching other records', () => {
    const storage = new FakeStorage()
    const legacy = {
      batchId: 'legacy-1',
      title: '旧',
      created: T,
      stage: 'draft',
      rows: [{ level: 'A', spec: 3, book: 9 }],
    }
    storage.rawMap.set(dataKeyFor('legacy-1'), JSON.stringify({ v: 0, data: legacy }))
    // No marker: migration happens before commit-marker checks, but without a
    // marker the bytes are treated as an interrupted commit. Simulate a
    // versioned commit by also writing a matching marker (as an old build
    // that shared the checksum scheme would).
    const raw = storage.getItem(dataKeyFor('legacy-1'))!
    storage.rawMap.set(
      dataKeyFor('legacy-1').replace('/batch/', '/mark/'),
      JSON.stringify({ checksum: checksum(raw), at: T }),
    )
    const repo = createInventoryRepository(storage, () => T)
    const result = repo.loadAll()
    expect(result.quarantine).toHaveLength(0)
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0].id).toBe('legacy-1')
    expect(result.batches[0].items[0].bookQty).toBe(9)
  })

  it('an interrupted write (data present, no marker) is recoverable, not leaked', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    // Simulate crash between phase 2 and phase 3: valid bytes, no marker.
    const candidate = makeBatch('orphan')
    storage.rawMap.set(
      dataKeyFor('orphan'),
      JSON.stringify({ v: CURRENT_STORAGE_VERSION, data: candidate }),
    )
    const result = repo.loadAll()
    expect(result.batches).toHaveLength(0)
    expect(result.quarantine).toHaveLength(1)
    expect(result.quarantine[0].reason).toBe('uncommitted')
    expect(result.quarantine[0].recoverable).toBe(true)

    // Recover commits the stranded bytes; next load is clean.
    const recovered = repo.recover(result.quarantine[0].id)
    expect(recovered.id).toBe('orphan')
    const again = repo.loadAll()
    expect(again.batches.map((b) => b.id)).toEqual(['orphan'])
    expect(again.quarantine).toHaveLength(0)
  })

  it('checksum mismatch with decodable bytes is recoverable via re-commit', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('b1'))
    // Tamper the MARKER only: data bytes decode fine, marker disagrees.
    const markKey = dataKeyFor('b1').replace('/batch/', '/mark/')
    storage.rawMap.set(markKey, JSON.stringify({ checksum: '00000000', at: T }))
    const result = repo.loadAll()
    expect(result.batches).toHaveLength(0)
    expect(result.quarantine[0].reason).toBe('uncommitted')
    expect(result.quarantine[0].recoverable).toBe(true)

    repo.recover(result.quarantine[0].id)
    const again = repo.loadAll()
    expect(again.batches.map((b) => b.id)).toEqual(['b1'])
    expect(again.quarantine).toHaveLength(0)
  })

  it('checksum mismatch with undecodable bytes reports the decode defect', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    repo.commit(makeBatch('b1'))
    expect(storage.corrupt(dataKeyFor('b1'))).toBe(true)
    const result = repo.loadAll()
    expect(result.batches).toHaveLength(0)
    // Marker mismatch and corrupt JSON: the structural defect is surfaced.
    expect(result.quarantine[0].reason).toBe('bad_json')
    expect(result.quarantine[0].recoverable).toBe(false)
    expect(() => repo.recover(result.quarantine[0].id)).toThrow(/无法恢复/)

    repo.discard(result.quarantine[0].id)
    const cleaned = repo.loadAll()
    expect(cleaned.batches).toEqual([])
    expect(cleaned.quarantine).toEqual([])
    expect(storage.getItem(dataKeyFor('b1'))).toBeNull()
  })

  it('discard of a recoverable orphan removes both keys', () => {
    const storage = new FakeStorage()
    const repo = createInventoryRepository(storage, () => T)
    storage.rawMap.set(
      dataKeyFor('x'),
      JSON.stringify({ v: 1, data: makeBatch('x') }),
    )
    const result = repo.loadAll()
    repo.discard(result.quarantine[0].id)
    expect(storage.keys().filter((k) => k.includes('shim-inventory') && !k.endsWith('quarantine'))).toEqual([])
  })
})

describe('repository — checksum', () => {
  it('is deterministic and order/content sensitive', () => {
    expect(checksum('abc')).toBe(checksum('abc'))
    expect(checksum('abc')).not.toBe(checksum('abd'))
    expect(checksum('')).toBe('811c9dc5')
  })
})

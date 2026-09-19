/**
 * Injectable in-memory Storage backend for repository tests.
 *
 * Supports:
 *  - per-key one-shot faults (fail the next setItem on a key matching a
 *    predicate / exact name), optionally corrupting the stored bytes to
 *    emulate quota truncation
 *  - read-back faults: after a write, getItem may return stale/garbage data
 *  - a max byte budget to emulate quota exhaustion
 */

import type { StorageBackend } from './repository'

export interface FakeStorageOptions {
  quotaBytes?: number
}

export interface NextSetFault {
  match: (key: string) => boolean
  /** What get(key) returns afterwards: null (no write) or truncated bytes. */
  leaveStored?: null | string
}

export interface NextGetFault {
  match: (key: string) => boolean
  returnValue: string | null
  once: boolean
  skip: number
}

export interface NextGetThrow {
  match: (key: string) => boolean
  error: unknown
  once: boolean
  skip: number
}

export class FakeStorage implements StorageBackend {
  private map = new Map<string, string>()
  private quotaBytes: number
  readonly writtenKeys: string[] = []
  private nextSetFaults: NextSetFault[] = []
  private nextSetThrows: { match: (key: string) => boolean; error: unknown }[] = []
  private nextGetFaults: NextGetFault[] = []
  private nextGetThrows: NextGetThrow[] = []
  setItemCalls: { key: string; bytes: number }[] = []

  constructor(options: FakeStorageOptions = {}) {
    this.quotaBytes = options.quotaBytes ?? Number.POSITIVE_INFINITY
  }

  get length(): number {
    return this.map.size
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  rawEntries(): [string, string][] {
    return [...this.map.entries()]
  }

  get rawMap(): Map<string, string> {
    return this.map
  }

  getItem(key: string): string | null {
    for (let i = 0; i < this.nextGetThrows.length; i++) {
      const fault = this.nextGetThrows[i]
      if (fault.match(key)) {
        if (fault.skip > 0) {
          fault.skip--
        } else {
          if (fault.once) this.nextGetThrows.splice(i, 1)
          throw fault.error
        }
      }
    }
    for (let i = 0; i < this.nextGetFaults.length; i++) {
      const fault = this.nextGetFaults[i]
      if (fault.match(key)) {
        if (fault.skip > 0) {
          fault.skip--
        } else {
          if (fault.once) this.nextGetFaults.splice(i, 1)
          return fault.returnValue
        }
      }
    }
    return this.map.has(key) ? this.map.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.setItemCalls.push({ key, bytes: value.length })
    this.writtenKeys.push(key)
    const throwIndex = this.nextSetThrows.findIndex((f) => f.match(key))
    if (throwIndex >= 0) {
      const { error } = this.nextSetThrows[throwIndex]
      this.nextSetThrows.splice(throwIndex, 1)
      throw error
    }
    const faultIndex = this.nextSetFaults.findIndex((f) => f.match(key))
    if (faultIndex >= 0) {
      const { leaveStored } = this.nextSetFaults[faultIndex]
      this.nextSetFaults.splice(faultIndex, 1)
      if (leaveStored === undefined) {
        // Emulate quota error with partial/truncated write.
        const truncated = value.length > 4 ? value.slice(0, Math.max(1, value.length - 4)) : value
        this.putRaw(key, truncated)
      } else if (leaveStored !== null) {
        this.putRaw(key, leaveStored)
      } // null: nothing stored
      throw makeQuotaError(key)
    }
    this.putRaw(key, value)
  }

  private putRaw(key: string, value: string) {
    const other = [...this.map.entries()]
      .filter(([k]) => k !== key)
      .reduce((sum, [, v]) => sum + v.length, 0)
    if (other + value.length > this.quotaBytes) throw makeQuotaError(key)
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  /** Fail the next matching setItem with a QuotaExceeded-style DOMException. */
  failNextSet(match: (key: string) => boolean, leaveStored?: null | string): void {
    this.nextSetFaults.push({ match, leaveStored })
  }

  /** Fail a matching setItem by throwing an arbitrary error. */
  throwOnNextSet(match: (key: string) => boolean, error: unknown): void {
    this.nextSetThrows.push({ match, error })
  }

  /** Make the next read of a matching key return something else. */
  faultNextGet(
    match: (key: string) => boolean,
    returnValue: string | null,
    once = true,
    skip = 0,
  ): void {
    this.nextGetFaults.push({ match, returnValue, once, skip })
  }

  /** Make a matching read throw (use skip to target later reads). */
  throwOnNextGet(match: (key: string) => boolean, error: unknown, once = true, skip = 0): void {
    this.nextGetThrows.push({ match, error, once, skip })
  }

  /** Corrupt raw bytes of a key directly (simulates external tampering). */
  corrupt(key: string, replacement?: string): boolean {
    if (!this.map.has(key)) return false
    const current = this.map.get(key)!
    this.map.set(key, replacement ?? current.slice(0, Math.max(0, current.length - 3)) + 'xxx')
    return true
  }

  deleteRaw(key: string): void {
    this.map.delete(key)
  }
}

export function makeQuotaError(key = ''): Error {
  const err = new Error(`Failed to execute 'setItem' on 'Storage'${key ? `: '${key}'` : ''}`)
  err.name = 'QuotaExceededError'
  return err
}

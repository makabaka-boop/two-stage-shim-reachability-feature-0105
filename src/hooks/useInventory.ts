import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  createInventoryController,
  type InventoryController,
  type InventorySnapshot,
} from '../lib/inventory/controller'
import {
  createBrowserStorage,
  createInventoryRepository,
} from '../lib/inventory/repository'

export interface InventoryStore {
  controller: InventoryController | null
  snapshot: InventorySnapshot
  /** localStorage is unavailable/disabled in this browser. */
  unavailable: boolean
}

const EMPTY_SNAPSHOT: InventorySnapshot = {
  loaded: false,
  batches: [],
  quarantine: [],
  warnings: [],
  storageError: null,
  pendingFailure: null,
}

/**
 * Owns the single controller instance and its snapshot. Loading is triggered
 * once; useSyncExternalStore guarantees React state only changes when the
 * controller emits — i.e. after a verified commit.
 */
export function useInventory(): InventoryStore {
  const controller = useMemo<InventoryController | null>(() => {
    const backend = createBrowserStorage()
    if (!backend) return null
    return createInventoryController(createInventoryRepository(backend))
  }, [])

  const snapshot = useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => undefined),
    () => controller?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => EMPTY_SNAPSHOT,
  )

  useEffect(() => {
    // Load on mount (idempotent; StrictMode double-invocation is harmless
    // because load() simply re-reads storage and re-emits).
    controller?.load()
  }, [controller])

  return { controller, snapshot, unavailable: controller === null }
}

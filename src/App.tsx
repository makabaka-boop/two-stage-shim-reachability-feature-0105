import { useState } from 'react'
import { ReachabilityPage } from './pages/ReachabilityPage'
import { InventoryPage } from './pages/InventoryPage'

type TopView = 'reachability' | 'inventory'

const TABS: { id: TopView; label: string; sub: string }[] = [
  { id: 'reachability', label: '可达性计算', sub: 'A/B 级离散垫片求和判定' },
  { id: 'inventory', label: '实物垫片套装盘点', sub: '批次建账、计数、差异复核与结案' },
]

export default function App() {
  const [view, setView] = useState<TopView>('reachability')

  return (
    <div className="page">
      <header className="page-header">
        <h1>垫片补偿工作台</h1>
        <p className="subtitle">同一工作台下两个并列入口：可达性计算 · 实物垫片套装盘点</p>
        <nav className="top-nav" aria-label="主导航">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`top-tab ${view === tab.id ? 'active' : ''}`}
              aria-pressed={view === tab.id}
              onClick={() => setView(tab.id)}
            >
              <span className="top-tab-label">{tab.label}</span>
              <span className="top-tab-sub">{tab.sub}</span>
            </button>
          ))}
        </nav>
      </header>

      {/*
        Both pages stay mounted; only visibility toggles. Switching tabs never
        resets the calculator's JSON/results and never touches inventory
        progress — the two sides share no state or storage keys.
      */}
      <div hidden={view !== 'reachability'}>
        <ReachabilityPage />
      </div>
      <div hidden={view !== 'inventory'}>
        <InventoryPage />
      </div>
    </div>
  )
}

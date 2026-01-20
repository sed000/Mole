import { useMemo, useState } from 'react'
import './App.css'

type NavItem = {
  key: string
  label: string
  description: string
}

type JobStatus = 'queued' | 'running' | 'waiting_sudo' | 'completed' | 'failed'

type JobUpdate = {
  line?: string
  status?: JobStatus
}

const NAV_ITEMS: NavItem[] = [
  { key: 'clean', label: 'Clean', description: 'Clear caches and system junk' },
  { key: 'optimize', label: 'Optimize', description: 'Run health checks and fixes' },
  { key: 'uninstall', label: 'Uninstall', description: 'Remove applications safely' },
  { key: 'purge', label: 'Purge', description: 'Delete old build artifacts' },
  { key: 'installer', label: 'Installers', description: 'Remove leftover installers' },
  { key: 'analyze', label: 'Analyze', description: 'Scan disk usage' },
  { key: 'status', label: 'Status', description: 'Live system snapshot' },
]

type RunnerOptions = {
  systemClean?: boolean
  dryRun?: boolean
  applySecurityFixes?: boolean
  applyUpdates?: boolean
  applyAutoFix?: boolean
  paths?: string[]
  apps?: string[]
  sudoPassword?: string
  analyzePath?: string
}

const useEndpoint = () => {
  const [activeJob, setActiveJob] = useState<string | null>(null)
  const [status, setStatus] = useState<JobStatus>('queued')
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (endpoint: string, payload?: Record<string, unknown>) => {
    setError(null)
    setLogs([])
    setRunning(true)

    const response = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : '{}',
    })

    if (!response.ok) {
      setRunning(false)
      setError('Failed to start job.')
      return
    }

    const body = (await response.json()) as { jobId?: string }
    if (!body.jobId) {
      setRunning(false)
      setError('Job id missing.')
      return
    }

    setActiveJob(body.jobId)
    connectStream(body.jobId)
  }

  const connectStream = (jobId: string) => {
    const events = new EventSource(`/api/jobs/${jobId}/stream`)

    events.addEventListener('status', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as JobUpdate
      if (data.status) {
        setStatus(data.status)
      }
    })

    events.addEventListener('message', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as JobUpdate
      if (data.line) {
        setLogs((prev) => [...prev, data.line!])
      }
    })

    events.addEventListener('done', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { exitCode: number | null }
      setRunning(false)
      setStatus(data.exitCode === 0 ? 'completed' : 'failed')
      events.close()
    })

    events.onerror = () => {
      setRunning(false)
      setError('Lost connection to server.')
      events.close()
    }
  }

  return {
    activeJob,
    status,
    logs,
    running,
    error,
    run,
  }
}

function App() {
  const [activeTab, setActiveTab] = useState<NavItem['key']>('clean')
  const [systemClean, setSystemClean] = useState(true)
  const [dryRun, setDryRun] = useState(false)
  const [applySecurityFixes, setApplySecurityFixes] = useState(true)
  const [applyUpdates, setApplyUpdates] = useState(false)
  const [applyAutoFix, setApplyAutoFix] = useState(true)
  const [sudoPassword, setSudoPassword] = useState('')
  const [paths, setPaths] = useState('')
  const [apps, setApps] = useState('')
  const [analyzePath, setAnalyzePath] = useState('')

  const runner = useEndpoint()

  const currentCopy = useMemo(() => NAV_ITEMS.find((item) => item.key === activeTab), [activeTab])

  const onRun = async () => {
    const basePayload: RunnerOptions = {
      sudoPassword: sudoPassword.trim() || undefined,
    }

    switch (activeTab) {
      case 'clean':
        await runner.run('clean', {
          ...basePayload,
          system: systemClean,
          dryRun,
        })
        return
      case 'optimize':
        await runner.run('optimize', {
          ...basePayload,
          dryRun,
          applySecurityFixes,
          applyUpdates,
          applyAutoFix,
        })
        return
      case 'purge':
        await runner.run('purge', {
          ...basePayload,
          paths: paths
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean),
        })
        return
      case 'installer':
        await runner.run('installers', {
          ...basePayload,
          paths: paths
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean),
        })
        return
      case 'uninstall':
        await runner.run('uninstall', {
          ...basePayload,
          apps: apps
            .split('\n')
            .map((app) => app.trim())
            .filter(Boolean),
        })
        return
      case 'analyze':
        await runner.run('analyze', {
          ...basePayload,
          path: analyzePath.trim() || undefined,
        })
        return
      case 'status':
        await runner.run('status', basePayload)
        return
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="eyebrow">Mole</p>
          <h1>Local System Care</h1>
          <p className="subtitle">Fast local cleanup, optimizations, and disk insights.</p>
        </div>
        <div className="status-card">
          <p className="label">Job status</p>
          <p className={`status ${runner.status}`}>{runner.running ? 'Running' : runner.status}</p>
          <p className="meta">{runner.activeJob ? `Job ${runner.activeJob}` : 'Idle'}</p>
        </div>
      </header>

      <section className="shell">
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={item.key === activeTab ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveTab(item.key)}
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          ))}
        </nav>

        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>{currentCopy?.label}</h2>
              <p>{currentCopy?.description}</p>
            </div>
            <button className="run" onClick={onRun} disabled={runner.running}>
              {runner.running ? 'Running…' : 'Run'}
            </button>
          </div>

          <div className="panel-body">
            {(activeTab === 'clean' || activeTab === 'optimize') && (
              <div className="form-grid">
                {activeTab === 'clean' && (
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={systemClean}
                      onChange={(event) => setSystemClean(event.target.checked)}
                    />
                    <span>Include system caches (sudo)</span>
                  </label>
                )}
                {activeTab === 'optimize' && (
                  <>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={applySecurityFixes}
                        onChange={(event) => setApplySecurityFixes(event.target.checked)}
                      />
                      <span>Apply security fixes</span>
                    </label>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={applyAutoFix}
                        onChange={(event) => setApplyAutoFix(event.target.checked)}
                      />
                      <span>Auto-fix recommended items</span>
                    </label>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={applyUpdates}
                        onChange={(event) => setApplyUpdates(event.target.checked)}
                      />
                      <span>Apply Mole updates</span>
                    </label>
                  </>
                )}
                <label className="toggle">
                  <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
                  <span>Dry run only</span>
                </label>
              </div>
            )}

            {(activeTab === 'purge' || activeTab === 'installer') && (
              <div className="form-group">
                <label>Paths (one per line)</label>
                <textarea
                  value={paths}
                  onChange={(event) => setPaths(event.target.value)}
                  placeholder="/Users/you/Projects/app/node_modules"
                />
              </div>
            )}

            {activeTab === 'uninstall' && (
              <div className="form-group">
                <label>Apps (bundle id or full path)</label>
                <textarea
                  value={apps}
                  onChange={(event) => setApps(event.target.value)}
                  placeholder="com.example.app\n/Applications/App.app"
                />
              </div>
            )}

            {activeTab === 'analyze' && (
              <div className="form-group">
                <label>Scan path</label>
                <input
                  value={analyzePath}
                  onChange={(event) => setAnalyzePath(event.target.value)}
                  placeholder="/Users/you"
                />
              </div>
            )}

            {activeTab === 'status' && (
              <div className="panel-info">
                <p>Press run to fetch a live status snapshot.</p>
              </div>
            )}

            <div className="form-group">
              <label>Admin password (only used if required)</label>
              <input
                type="password"
                value={sudoPassword}
                onChange={(event) => setSudoPassword(event.target.value)}
                placeholder="macOS password"
              />
            </div>

            {runner.error && <p className="error">{runner.error}</p>}
          </div>

          <div className="log-panel">
            <div className="log-head">
              <h3>Live Output</h3>
              <span>{runner.logs.length} lines</span>
            </div>
            <pre>{runner.logs.length ? runner.logs.join('\n') : 'No output yet.'}</pre>
          </div>
        </div>
      </section>
    </div>
  )
}

export default App

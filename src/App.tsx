import { useEffect, useMemo, useState } from 'react'
import Activity from 'lucide-react/dist/esm/icons/activity.mjs'
import Clock from 'lucide-react/dist/esm/icons/clock.mjs'
import Database from 'lucide-react/dist/esm/icons/database.mjs'
import ExternalLink from 'lucide-react/dist/esm/icons/external-link.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import TrendingDown from 'lucide-react/dist/esm/icons/trending-down.mjs'
import TrendingUp from 'lucide-react/dist/esm/icons/trending-up.mjs'
import './App.css'

type CsvRow = Record<string, string>

type GymRecord = {
  scrapedAt: Date
  sourceUpdatedAt: Date | null
  facility: string
  status: string
  capacityPercentage: number | null
  badgeText: string
  rawText: string
  source: string
}

type HourBucket = {
  day: string
  hour: number
  average: number | null
  count: number
}

type GitHubFileResponse = {
  content?: string
  encoding?: string
}

type TrackResponse = {
  ok?: boolean
  runId?: number | string | null
  status?: string
  conclusion?: string | null
  error?: string
}

type TrackStatusFile = {
  checked_at?: string
  status?: string
  message?: string
}

type TrackStatus = {
  checkedAt: Date | null
  status: string
  message: string
}

const CSV_CONTENTS_URL =
  'https://api.github.com/repos/sappyscooper/activesg-clementi-gym-monitor/contents/public/data/clementi_gym_capacity.csv?ref=main'
const RAW_CSV_URL =
  'https://raw.githubusercontent.com/sappyscooper/activesg-clementi-gym-monitor/main/public/data/clementi_gym_capacity.csv'
const RAW_TRACK_STATUS_URL =
  'https://raw.githubusercontent.com/sappyscooper/activesg-clementi-gym-monitor/main/public/data/track_status.json'
const SG_TIME_ZONE = 'Asia/Singapore'
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const HOURS = Array.from({ length: 16 }, (_, index) => index + 7)
const AUTO_REFRESH_MS = 120_000
const TRACK_POLL_MS = 5_000
const TRACK_TIMEOUT_MS = 120_000

function base64ToText(content: string) {
  const binary = window.atob(content.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

async function fetchRawCsvText() {
  const response = await fetch(`${RAW_CSV_URL}?t=${Date.now()}`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Raw CSV fetch failed with ${response.status}`)
  }

  const text = await response.text()
  if (!text.startsWith('scraped_at,')) {
    throw new Error('Raw CSV response was not a CSV file')
  }

  return text
}

async function fetchGitHubApiCsvText() {
  const response = await fetch(`${CSV_CONTENTS_URL}&t=${Date.now()}`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
    },
  })

  if (!response.ok) {
    throw new Error(`CSV fetch failed with ${response.status}`)
  }

  const data = (await response.json()) as GitHubFileResponse
  if (data.encoding !== 'base64' || !data.content) {
    throw new Error('CSV content was not returned by GitHub')
  }

  return base64ToText(data.content)
}

async function fetchCsvText() {
  try {
    return await fetchRawCsvText()
  } catch {
    return fetchGitHubApiCsvText()
  }
}

async function fetchTrackStatus() {
  const response = await fetch(`${RAW_TRACK_STATUS_URL}?t=${Date.now()}`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    return null
  }

  const data = (await response.json()) as TrackStatusFile
  const checkedAt = data.checked_at ? new Date(data.checked_at) : null

  return {
    checkedAt: checkedAt && !Number.isNaN(checkedAt.getTime()) ? checkedAt : null,
    status: data.status || 'unknown',
    message: data.message || '',
  }
}

async function requestTrackingRun() {
  const response = await fetch('/api/track', {
    method: 'POST',
    cache: 'no-store',
  })
  const data = (await response.json()) as TrackResponse

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Tracking request failed with ${response.status}`)
  }
  if (!data.runId) {
    throw new Error('Tracking started, but GitHub did not return a run id yet')
  }

  return String(data.runId)
}

async function fetchTrackingRun(runId: string) {
  const response = await fetch(`/api/track?runId=${encodeURIComponent(runId)}&t=${Date.now()}`, {
    cache: 'no-store',
  })
  const data = (await response.json()) as TrackResponse

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Tracking status failed with ${response.status}`)
  }

  return data
}

async function waitForTrackingRun(runId: string) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < TRACK_TIMEOUT_MS) {
    const run = await fetchTrackingRun(runId)
    if (run.status === 'completed') {
      if (run.conclusion === 'success') {
        return
      }
      throw new Error(`Tracking run finished with ${run.conclusion || 'no conclusion'}`)
    }

    await new Promise((resolve) => setTimeout(resolve, TRACK_POLL_MS))
  }

  throw new Error('Tracking run is still running. Try refresh again in a minute.')
}

function parseCsvLine(line: string) {
  const values: string[] = []
  let value = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (char === '"' && inQuotes && next === '"') {
      value += '"'
      index += 1
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      values.push(value)
      value = ''
    } else {
      value += char
    }
  }

  values.push(value)
  return values
}

function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)

  if (lines.length < 2) {
    return []
  }

  const headers = parseCsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line)
    return headers.reduce<CsvRow>((row, header, index) => {
      row[header] = values[index] ?? ''
      return row
    }, {})
  })
}

function toRecord(row: CsvRow): GymRecord | null {
  const scrapedAt = new Date(row.scraped_at)
  if (Number.isNaN(scrapedAt.getTime())) {
    return null
  }

  const sourceUpdatedAt = row.source_updated_at ? new Date(row.source_updated_at) : null
  const parsedCapacity = Number(row.capacity_percentage)

  return {
    scrapedAt,
    sourceUpdatedAt:
      sourceUpdatedAt && !Number.isNaN(sourceUpdatedAt.getTime()) ? sourceUpdatedAt : null,
    facility: row.facility || 'Clementi ActiveSG Gym',
    status: row.status || 'unknown',
    capacityPercentage: row.capacity_percentage === '' || Number.isNaN(parsedCapacity) ? null : parsedCapacity,
    badgeText: row.badge_text || '',
    rawText: row.raw_text || '',
    source: row.source || '',
  }
}

function formatSgDate(date: Date | null) {
  if (!date) {
    return 'Not available'
  }

  return new Intl.DateTimeFormat('en-SG', {
    timeZone: SG_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function sgParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-SG', {
    timeZone: SG_TIME_ZONE,
    weekday: 'long',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  return {
    day: parts.find((part) => part.type === 'weekday')?.value ?? '',
    hour: Number(parts.find((part) => part.type === 'hour')?.value ?? 0),
  }
}

function average(values: number[]) {
  if (!values.length) {
    return null
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function capacityClass(value: number | null) {
  if (value === null) {
    return 'muted'
  }
  if (value < 30) {
    return 'low'
  }
  if (value < 60) {
    return 'medium'
  }
  return 'high'
}

function statusLabel(record: GymRecord | null) {
  if (!record) {
    return 'No data'
  }
  if (record.status === 'open' && record.capacityPercentage !== null) {
    return `${record.capacityPercentage}% full`
  }
  if (record.badgeText) {
    return record.badgeText
  }
  return record.status.replaceAll('_', ' ')
}

function trackStatusLabel(trackStatus: TrackStatus | null) {
  if (!trackStatus) {
    return 'Not checked'
  }
  if (trackStatus.status === 'saved') {
    return 'Saved reading'
  }
  if (trackStatus.status === 'blocked') {
    return 'Blocked by ActiveSG'
  }
  return trackStatus.status.replaceAll('_', ' ')
}

function buildHeatmap(records: GymRecord[]): HourBucket[] {
  const openRecords = records.filter((record) => record.status === 'open' && record.capacityPercentage !== null)

  return DAYS.flatMap((day) =>
    HOURS.map((hour) => {
      const values = openRecords
        .filter((record) => {
          const parts = sgParts(record.sourceUpdatedAt ?? record.scrapedAt)
          return parts.day === day && parts.hour === hour
        })
        .map((record) => record.capacityPercentage as number)

      return {
        day,
        hour,
        average: average(values),
        count: values.length,
      }
    }),
  )
}

function App() {
  const [records, setRecords] = useState<GymRecord[]>([])
  const [trackStatus, setTrackStatus] = useState<TrackStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [tracking, setTracking] = useState(false)
  const [error, setError] = useState('')

  async function refreshData(showLoading = true) {
    if (showLoading) {
      setLoading(true)
    }
    setError('')

    try {
      const [text, updatedTrackStatus] = await Promise.all([fetchCsvText(), fetchTrackStatus()])
      const parsedRecords = parseCsv(text)
        .map(toRecord)
        .filter((record): record is GymRecord => Boolean(record))
        .filter((record) => record.status !== 'error')
        .sort((a, b) => a.scrapedAt.getTime() - b.scrapedAt.getTime())

      setRecords(parsedRecords)
      setTrackStatus(updatedTrackStatus)
      return parsedRecords
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load data')
      return records
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }

  async function runTrackingNow() {
    if (tracking) {
      return
    }

    setTracking(true)
    setLoading(true)
    setError('')

    try {
      const previousLatestScrapedAt = latest?.scrapedAt.getTime() ?? null
      const runId = await requestTrackingRun()
      await waitForTrackingRun(runId)
      const updatedRecords = await refreshData(false)
      const updatedLatestScrapedAt = updatedRecords.at(-1)?.scrapedAt.getTime() ?? null

      if (previousLatestScrapedAt !== null && updatedLatestScrapedAt === previousLatestScrapedAt) {
        setError('Tracking ran, but ActiveSG did not return a new capacity reading. Last checked was updated.')
      }
    } catch (trackError) {
      setError(trackError instanceof Error ? trackError.message : 'Unable to run tracking')
      await refreshData(false)
    } finally {
      setTracking(false)
      setLoading(false)
    }
  }

  useEffect(() => {
    let ignore = false

    async function loadData(showLoading = true) {
      if (showLoading) {
        setLoading(true)
      }
      setError('')

      try {
        const [text, updatedTrackStatus] = await Promise.all([fetchCsvText(), fetchTrackStatus()])
        const parsedRecords = parseCsv(text)
          .map(toRecord)
          .filter((record): record is GymRecord => Boolean(record))
          .filter((record) => record.status !== 'error')
          .sort((a, b) => a.scrapedAt.getTime() - b.scrapedAt.getTime())

        if (!ignore) {
          setRecords(parsedRecords)
          setTrackStatus(updatedTrackStatus)
        }
      } catch (loadError) {
        if (!ignore) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load data')
        }
      } finally {
        if (!ignore && showLoading) {
          setLoading(false)
        }
      }
    }

    loadData()
    const intervalId = window.setInterval(() => {
      loadData(false)
    }, AUTO_REFRESH_MS)

    return () => {
      ignore = true
      window.clearInterval(intervalId)
    }
  }, [])

  const latest = records.at(-1) ?? null
  const numericRecords = records.filter((record) => record.status === 'open' && record.capacityPercentage !== null)
  const heatmap = useMemo(() => buildHeatmap(records), [records])

  const hourlyStats = useMemo(
    () =>
      HOURS.map((hour) => {
        const values = numericRecords
          .filter((record) => sgParts(record.sourceUpdatedAt ?? record.scrapedAt).hour === hour)
          .map((record) => record.capacityPercentage as number)

        return {
          hour,
          average: average(values),
          count: values.length,
        }
      }),
    [numericRecords],
  )

  const peakHour = hourlyStats
    .filter((bucket) => bucket.average !== null)
    .sort((a, b) => (b.average as number) - (a.average as number))[0]

  const quietHour = hourlyStats
    .filter((bucket) => bucket.average !== null)
    .sort((a, b) => (a.average as number) - (b.average as number))[0]

  const averageCapacity = average(numericRecords.map((record) => record.capacityPercentage as number))
  const latestCapacity = latest?.status === 'open' ? latest.capacityPercentage : null
  const lastCheckedAt = trackStatus?.checkedAt ?? latest?.scrapedAt ?? null

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ActiveSG Clementi</p>
          <h1>Gym Crowd Monitor</h1>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" type="button" onClick={runTrackingNow} disabled={tracking}>
            <RefreshCw aria-hidden="true" size={18} />
            {tracking ? 'Tracking' : 'Refresh'}
          </button>
          <a className="icon-button secondary" href="https://activesg.gov.sg/gym-pool-crowd" target="_blank">
            <ExternalLink aria-hidden="true" size={18} />
            ActiveSG
          </a>
        </div>
      </header>

      <section className="status-strip">
        <article className={`metric-card status-${capacityClass(latestCapacity)}`}>
          <div className="metric-icon">
            <Activity aria-hidden="true" size={22} />
          </div>
          <div>
            <span>Current status</span>
            <strong>{loading ? 'Loading' : statusLabel(latest)}</strong>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-icon">
            <Clock aria-hidden="true" size={22} />
          </div>
          <div>
            <span>Source updated</span>
            <strong>{formatSgDate(latest?.sourceUpdatedAt ?? latest?.scrapedAt ?? null)}</strong>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-icon">
            <RefreshCw aria-hidden="true" size={22} />
          </div>
          <div>
            <span>Last checked</span>
            <strong>{formatSgDate(lastCheckedAt)}</strong>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-icon">
            <Database aria-hidden="true" size={22} />
          </div>
          <div>
            <span>Samples</span>
            <strong>{records.length}</strong>
          </div>
        </article>
      </section>

      {tracking && <p className="notice">Tracking a new reading and saving it to GitHub...</p>}
      {!tracking && trackStatus?.status === 'blocked' && (
        <p className="notice">
          {trackStatus.message || 'The last tracking attempt ran, but ActiveSG did not return capacity data.'}
        </p>
      )}
      {error && <p className="alert">Data load error: {error}</p>}

      <section className="overview-grid">
        <div className="panel live-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Live reading</p>
              <h2>{latest?.facility ?? 'Clementi ActiveSG Gym'}</h2>
            </div>
            <span className={`badge ${capacityClass(latestCapacity)}`}>{statusLabel(latest)}</span>
          </div>

          <div className="gauge" style={{ '--capacity': `${latestCapacity ?? 0}%` } as React.CSSProperties}>
            <div className="gauge-track">
              <div className={`gauge-fill ${capacityClass(latestCapacity)}`} />
            </div>
            <div className="gauge-labels">
              <span>Empty</span>
              <span>Busy</span>
            </div>
          </div>

          <dl className="detail-grid">
            <div>
              <dt>Status</dt>
              <dd>{latest?.status.replaceAll('_', ' ') ?? 'No data'}</dd>
            </div>
            <div>
              <dt>Observed by</dt>
              <dd>{latest?.source || 'No source yet'}</dd>
            </div>
            <div>
              <dt>Tracker</dt>
              <dd>{trackStatusLabel(trackStatus)}</dd>
            </div>
            <div>
              <dt>Average full</dt>
              <dd>{averageCapacity === null ? 'No open-hour data' : `${Math.round(averageCapacity)}%`}</dd>
            </div>
          </dl>
        </div>

        <div className="panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Open-hour pattern</p>
              <h2>Peak and quiet hours</h2>
            </div>
          </div>

          <div className="ranked-hours">
            <div className="rank-row">
              <TrendingUp aria-hidden="true" size={20} />
              <span>Peak</span>
              <strong>
                {peakHour ? `${peakHour.hour}:00 · ${Math.round(peakHour.average as number)}%` : 'Collecting'}
              </strong>
            </div>
            <div className="rank-row">
              <TrendingDown aria-hidden="true" size={20} />
              <span>Quietest</span>
              <strong>
                {quietHour ? `${quietHour.hour}:00 · ${Math.round(quietHour.average as number)}%` : 'Collecting'}
              </strong>
            </div>
          </div>

          <div className="mini-bars">
            {hourlyStats.map((bucket) => (
              <div className="mini-bar" key={bucket.hour}>
                <span>{bucket.hour}</span>
                <div>
                  <i
                    className={capacityClass(bucket.average)}
                    style={{ height: `${Math.max(bucket.average ?? 3, 3)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel heatmap-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Weekly heatmap</p>
            <h2>Average crowd by day and hour</h2>
          </div>
          <div className="legend">
            <span>Low</span>
            <i className="legend-low" />
            <i className="legend-medium" />
            <i className="legend-high" />
            <span>High</span>
          </div>
        </div>

        <div className="heatmap">
          <div className="corner" />
          {HOURS.map((hour) => (
            <div className="hour-label" key={hour}>
              {hour}
            </div>
          ))}
          {DAYS.map((day) => (
            <div className="day-row" key={day}>
              <div className="day-label">{day.slice(0, 3)}</div>
              {HOURS.map((hour) => {
                const bucket = heatmap.find((item) => item.day === day && item.hour === hour)
                return (
                  <div
                    className={`heat-cell ${capacityClass(bucket?.average ?? null)}`}
                    key={`${day}-${hour}`}
                    title={`${day} ${hour}:00 - ${
                      bucket?.average === null || bucket?.average === undefined
                        ? 'no samples'
                        : `${Math.round(bucket.average)}% average from ${bucket.count} sample${
                            bucket.count === 1 ? '' : 's'
                          }`
                    }`}
                  >
                    {bucket?.average === null || bucket?.average === undefined ? '' : Math.round(bucket.average)}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App

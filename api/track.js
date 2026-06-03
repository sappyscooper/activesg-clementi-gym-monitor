const OWNER = 'sappyscooper'
const REPO = 'activesg-clementi-gym-monitor'
const WORKFLOW_ID = 'monitor_gym.yml'
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`

function githubToken() {
  return process.env.MONITOR_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''
}

async function githubFetch(path, options = {}) {
  const token = githubToken()
  if (!token) {
    throw new Error('Missing MONITOR_GITHUB_TOKEN')
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 300)}`)
  }

  return response
}

async function latestRuns() {
  const response = await githubFetch('/actions/runs?per_page=10')
  const data = await response.json()
  return Array.isArray(data.workflow_runs) ? data.workflow_runs : []
}

async function dispatchWorkflow() {
  await githubFetch(`/actions/workflows/${WORKFLOW_ID}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main' }),
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

async function findDispatchedRun(startedAt) {
  const runs = await latestRuns()
  return (
    runs.find((run) => {
      return run.event === 'workflow_dispatch' && new Date(run.created_at).getTime() >= startedAt - 10_000
    }) || null
  )
}

async function getRun(runId) {
  const response = await githubFetch(`/actions/runs/${encodeURIComponent(runId)}`)
  return response.json()
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')

  try {
    if (request.method === 'POST') {
      const startedAt = Date.now()
      await dispatchWorkflow()

      let run = null
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        run = await findDispatchedRun(startedAt)
        if (run) {
          break
        }
      }

      response.status(200).json({
        ok: true,
        runId: run?.id ?? null,
        status: run?.status ?? 'queued',
        conclusion: run?.conclusion ?? null,
        url: run?.html_url ?? null,
      })
      return
    }

    if (request.method === 'GET') {
      const runId = request.query?.runId
      if (!runId || typeof runId !== 'string') {
        response.status(400).json({ ok: false, error: 'Missing runId' })
        return
      }

      const run = await getRun(runId)
      response.status(200).json({
        ok: true,
        runId: run.id,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        updatedAt: run.updated_at,
      })
      return
    }

    response.status(405).json({ ok: false, error: 'Method not allowed' })
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to trigger tracking',
    })
  }
}

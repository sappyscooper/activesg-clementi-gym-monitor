# ActiveSG Clementi Gym Monitor

Vite/React dashboard plus a Playwright scraper for the public ActiveSG gym crowd page.

## What It Does

- Opens `https://activesg.gov.sg/gym-pool-crowd` with Playwright.
- Records `Clementi ActiveSG Gym` status and capacity percentage when available.
- Appends readings to `public/data/clementi_gym_capacity.csv`.
- Updates `public/data/latest.json`.
- Renders the CSV as a Vercel-hosted dashboard.

## Local Setup

```bash
npm install
npm run build
```

Python scraper setup:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python scraper.py
```

Optional analysis:

```bash
pip install -r requirements-analysis.txt
python scripts/analyze_gym_data.py
```

## GitHub Actions

The workflow at `.github/workflows/monitor_gym.yml` runs hourly from 07:00 to 22:00 SGT and commits data changes back to the repo.

The workflow uses headed Chromium under Xvfb because plain headless Chromium was blocked by Cloudflare in local verification. Cloudflare may still block CI browser sessions; when that happens, the workflow records an `error` row so the dashboard shows that collection failed instead of silently stopping.

## Deploy

Use the same Vercel scope as the Monopoly Tracker setup:

```bash
npx vercel --prod --yes --scope sappyscoopers-projects
```

The included `vercel.json` sets no-cache headers and SPA rewrites.

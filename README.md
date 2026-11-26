# AI World Governance Simulator

197 leaders (one per country: 193 UN members, Holy See, Palestine, Kosovo, Taiwan) govern a real-data Earth month by month. Each leader's top duty is its own population; nothing tells it to be peaceful or aggressive. Every decision, briefing and outcome is saved so you can replay it, branch it and compare runs.

The full design is in [SPEC.md](SPEC.md). Model simplifications and known limits are in [NOTES.md](NOTES.md). Data coverage (real vs estimated) is in [data/quality-report.md](data/quality-report.md).

## Setup (Windows, macOS or Linux)

1. Install **Node.js 22 LTS or newer** from nodejs.org. You don't need Python, WSL or Docker.
2. In this folder:
   ```bash
   npm install
   ```
   ```bash
   npm test
   ```
   The test takes about 10 seconds. It checks determinism, that budgets balance with debt, a 24-month run with all 197 countries, and that border changes, civil war and regime collapse all happen.

## Run it

Create a 24-month run with free rule-based "mock" leaders (about 10 seconds):
```bash
npm run sim -- --new --name baseline --turns 24
```
Open the viewer at http://localhost:5173:
```bash
npm start
```

In the viewer:
- **Map**: borders are drawn by dissolving the regions each country owns, so annexations and breakaway states show up. Occupied regions are hatched in the occupier's colour, rebel-held regions are dotted, and red dashes mark front lines. The colour dropdown switches layers: GDP per capita, growth, stability, approval, unrest, welfare, military, at war, regime type, dominant incentive, press freedom, refugees, resources, religion/minorities, and attitude toward the selected country. Overlays add war fronts, alliances, trade arcs, sanctions, aid and event markers.
- **Timeline** (bottom): drag to any month, or use Play and step. Regions that changed hands flash yellow.
- **Country** tab: click any country. Click a stat to chart it. The tab also shows bloc approval, incentive weights, the leader's private assessment, public statement, directives and the briefing it saw, cables, constitution version history, and government and leader history.
- **Events**, **World** (dashboard, including the `suspects_simulation` count) and **Compare** (two runs or branches side by side).
- Run controls appear only when the local server is running: **Next month**, **Run N**, **Auto-play**, **Pause**, **New run**, and **Branch here** (with an incentive preset).

### CLI
```bash
npm run sim -- --new --name "baseline" --turns 12
```
```bash
npm run sim -- --run <runId> --turns 12
```
```bash
npm run sim -- --run <runId> --turns quota
```
```bash
npm run sim -- --branch <runId> --from 24 --preset welfare --turns 12
```
```bash
npm run sim -- --list
```
```bash
npm run sim -- --estimate <runId>
```
- `--turns quota` keeps going until the daily quota runs out.
- `--branch` presets are `welfare`, `approval`, `survival`, `power` and `equal`. Use `--weights file.json` to set weights per country.
- Other flags: `--seed N`, `--countries dev`, `--start 2026-11`, `--force` (ignore a stale lock) and `--hours 5` (stop before a deadline).
- Press Ctrl+C to pause cleanly after the current call.

## Real AI leaders

1. Copy `.env.example` to `.env` and set `PROVIDER=gemini` and `API_KEY=...` (a free key from Google AI Studio). Keep `COUNTRIES=dev` at first: 20 major countries use the real model and the rest use mock leaders.
2. Check what a month costs, then run:
   ```bash
   npm run sim -- --new --name "gemini dev" --turns 1
   ```
   Before each run you see something like "This month needs ~45 requests; 830 left today". If the daily quota runs out mid-month, the run saves progress and stops cleanly. The next start resumes exactly where it stopped.
3. When you're happy with it, set `COUNTRIES=all`.

Every prompt and response is saved in `runs/<id>/agents/<month>/<ISO3>.json`. Prompts are plain-text templates in `prompts/`, so you can read and edit them. The same model is used for every country, and it is recorded in `meta.json`. Other providers are `anthropic`, `groq`, `openrouter` and `ollama`, plus any OpenAI-compatible endpoint via `BASE_URL`. For paid providers, set `PRICE_IN_PER_M` / `PRICE_OUT_PER_M` and a `MAX_SPEND_USD` hard stop.

## How to start an overnight run from your phone

One-time setup on github.com:
1. Push this repo to GitHub.
2. Go to **Settings → Secrets and variables → Actions → New repository secret**, name it `API_KEY` and paste your key.
3. Optionally add **Variables** such as `PROVIDER` (default `gemini`), `MODEL`, `RPM`, `RPD`, and `SCHEDULED_RUN_ID` (the run the nightly schedule continues).

Each night:
1. Open the GitHub app and go to your repo → **Actions → simulate → Run workflow**.
2. Leave `runId` blank to continue the newest run, or fill in `newRunName` to start a new one. `turns` = `quota` uses the whole daily quota.
3. The job stops before GitHub's ~6h limit or when the quota is used up, then commits results to the repo.

The workflow also runs on a schedule at 08:05 UTC, just after the Gemini free quota resets at midnight Pacific time (about 7pm Melbourne). To turn the schedule off, delete the `schedule:` lines in `.github/workflows/simulate.yml`. Two jobs never write at once (`concurrency`). A run in progress is locked in `meta.json`, and a stale lock can be overridden with `force`.

## How to see results in the morning

```bash
git pull
```
```bash
npm start
```
Always `git pull` before running locally too, so local and cloud runs don't diverge.

Or view the results on your phone with GitHub Pages:
- Go to **Settings → Pages → Source: GitHub Actions**. The `pages` workflow then publishes the read-only viewer and all runs whenever new results are committed.
- On the free plan this needs a public repo.

## Data

Run `npm run data` to re-fetch (into `data/raw/`, gitignored) and rebuild everything in `data/`.

Sources:
- Natural Earth admin-0/admin-1 (4,575 regions)
- World Bank WDI (API, or a bulk CSV fallback)
- V-Dem electoral democracy index 2024
- Transparency International CPI 2025
- mledoze/countries

Hand-curated facts live in `data/curated.json`: blocs, treaties, disputes, conflicts at the start date, sanctions, government systems, minority regions, oil and mineral regions, and chokepoints.

Editing:
- To override any country number, drop `data/manual/<field>.csv` (columns `iso3,value`), for example `pressFreedom.csv` with RSF scores (0–100).
- `data/incentives.json` and `data/constitutions.json` are only written if they're missing, so hand edits survive. Use `npm run data -- --force-incentives` to regenerate them.

## Layout

```
engine/   constants.ts (all tunables) · world.ts (start state) · turn.ts (monthly resolution) · directives.ts · ops.ts (war, territory, regime change) · regime.ts (gov types, incentives, constitutions)
agents/   mock.ts (rule-based leaders) · briefing.ts · llm.ts (provider, quota queue) · index.ts (parse/validate/fallback)
sim/      run.ts (runs on disk, resume, branch) · cli.ts · server.ts
viewer/   index.html · src/main.ts · src/style.css
scripts/  build-data.ts       prompts/  system.txt · briefing.txt · constitution.txt
runs/<id>/ meta.json · turns/NNNN.json.gz · events.jsonl · series.json · agents/NNNN/*.json
```

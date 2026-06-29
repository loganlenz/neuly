# Neuly

A research platform for natural medicine — clinical trials, peer-reviewed
research, companies, people, jobs, and events across psychedelic and
plant-medicine science.

The app is a single Node/Express service that serves both the frontend
(`index.html`) and a JSON API (`/api/*`) from the same origin. Data is
collected by a set of crawlers and/or generated from a curated seed dataset.

## Architecture

```
index.html            # React frontend (single file, loaded via CDN)
crawlers/             # TypeScript backend
  src/server.ts       # Express server: serves the frontend + /api
  src/seed.ts         # Curated seed dataset
  src/crawlers/       # Live data crawlers (ClinicalTrials.gov, PubMed, etc.)
  src/index.ts        # Crawler CLI / orchestrator
  data/               # Generated JSON the API reads (gitignored)
```

The frontend calls the API at a same-origin `/api` path in production, so it
works on any host or domain with no configuration.

## Run locally

```bash
cd crawlers
npm install
npm run setup        # seeds demo data, then starts the server
```

Then open http://localhost:3001

Other useful scripts (run from `crawlers/`):

| Command | Description |
|---|---|
| `npm run seed` | Generate the curated seed dataset into `data/` |
| `npm run server` | Start the API + frontend server (dev, via tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run serve` | Start the compiled server (`dist/server.js`) |
| `npm run crawl:all` | Run all live crawlers to refresh `data/` |

## Deploy

The repo ships a Render blueprint (`render.yaml`) that runs the whole thing
as one free web service.

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, connect the repo, and apply.
   Render builds (`npm run build`), seeds (`npm run seed:prod`), and starts
   the server (`npm run serve`). The health check is `GET /api/health`.
3. The app comes up on a `*.onrender.com` URL. Add a custom domain in the
   Render dashboard when ready.

Any Node host works the same way — the production commands are:

```bash
cd crawlers
npm ci && npm run build && npm run seed:prod   # build + seed
npm run serve                                  # start (honors $PORT)
```

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (provided automatically by most hosts; defaults to 3001) |
| `NCBI_API_KEY` | Raises the PubMed crawler rate limit from 3/s to 10/s |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default `info`) |

## Keeping data fresh

The seed dataset is enough to launch. To pull live data, run the crawlers
(`npm run crawl:all` or individual `crawl:*` scripts) and redeploy, or wire
them into a scheduled job. Seed event dates are generated relative to the
seed run, so the "upcoming events" sections stay populated.

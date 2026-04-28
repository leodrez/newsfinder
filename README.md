# Trading News Streamer

Real-time financial news aggregator with LLM-powered relevance filtering for day traders.

Polls RSS feeds and financial news sites, scores each headline's relevance to your current trading focus using Claude Haiku, and streams results to a live web dashboard.

## Setup

```bash
npm install
cd frontend && npm install
cp .env.example .env
# Edit .env and add your Anthropic, Supabase, and QStash settings
```

## Usage

```bash
npx vercel dev
```

Open the local Vercel dev URL in your browser. The app serves a Vite React dashboard with TypeScript Vercel API routes under `api/`.

Type your current trading focus (e.g. "S&P 500 futures", "NVDA and semiconductor stocks") into the input at the top, and headlines will be scored and streamed in real time.

## Configuration

Edit `lib/config.ts` to add or remove feeds, adjust polling behavior, or change server-side defaults.

Environment variables are documented in `.env.example`. Frontend variables must use the `VITE_` prefix so Vite can expose them to the browser.

## Data Sources

- Reuters, CNBC, MarketWatch, AP News, Yahoo Finance (RSS)
- Federal Reserve press releases (RSS)
- Finviz news headlines (scraped)

All sources are configurable in `lib/config.ts`.

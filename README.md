# Trading News Streamer

Real-time financial news aggregator with LLM-powered relevance filtering for day traders.

Polls RSS feeds and financial news sites, scores each headline's relevance to your current trading focus using Claude Haiku, and streams results to a live web dashboard.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
# Edit .env and add your Anthropic API key
```

## Usage

```bash
python main.py
```

Open **http://localhost:8000** in your browser. Type your current trading focus (e.g. "S&P 500 futures", "NVDA and semiconductor stocks") into the input at the top, and headlines will be scored and streamed in real time.

## Configuration

Edit `config.yaml` to add/remove RSS feeds, change polling intervals, or adjust LLM settings.

## Data Sources

- Reuters, CNBC, MarketWatch, AP News, Yahoo Finance (RSS)
- Federal Reserve press releases (RSS)
- Finviz news headlines (scraped)

All sources are configurable in `config.yaml`.

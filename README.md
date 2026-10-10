# 2A Pulse — daily archive

The public, append-only record of **2A Pulse**, the Bitcoin market sentiment index published by [2A Research](https://2aresearch.org), an independent, student-led research organisation.

2A Pulse combines five public market signals into one score from 0 (extreme fear) to 100 (extreme greed). It describes market conditions. It does not predict prices, and nothing here is investment advice.

## Files

| File | What it is |
|---|---|
| [`data/pulse-history.csv`](data/pulse-history.csv) | Every archived day, one row per completed UTC day. Opens in Excel or Google Sheets. |
| [`data/pulse-history.json`](data/pulse-history.json) | The same rows plus metadata, for code. |
| [`data/latest.json`](data/latest.json) | The most recent day only. |
| [`scripts/pulse.mjs`](scripts/pulse.mjs) | The program that computes the index. |
| [`.github/workflows/daily.yml`](.github/workflows/daily.yml) | Runs the program every day at 01:30 UTC. |
| [`website/`](website) | Backup copies of the code pasted into 2aresearch.org (dashboard v0.5, homepage, projects page). |

## How the archive works

- Each morning the program scores the UTC day that has just closed and appends it.
- **Rows are never edited after they are written.** If the method changes, the new method gets a new version number and the old rows keep theirs, so every published number stays citable.
- The `recorded` column says how each row was made:
  - `backfill`: reconstructed on 10 October 2026, when the archive started. History begins on 29 June 2026 because OKX only serves about 100 days of past funding rates.
  - `daily`: computed the morning after that day closed.
  - `catch-up`: a day that was missed and filled in on a later run.

## Method v0.2

| Signal | Weight | Raw input | Score rule (capped at 0 and 100) | Source |
|---|---|---|---|---|
| Momentum | 30% | BTC close vs its 30-day average | 50 + 5 × % above the average | CoinGecko (OKX if unavailable) |
| Volatility | 20% | 14-day vs 90-day volatility of daily log returns | 50 − 60 × (ratio − 1) | CoinGecko |
| Funding | 25% | Mean of that day's BTC-USDT perpetual funding payments | 25 + 50 × (rate ÷ 0.01%) | OKX |
| Stablecoins | 15% | 30-day change in total USD stablecoin supply | 50 + 10 × % change | DefiLlama |
| Volume | 10% | 7-day vs 30-day average trading volume | 50 + 100 × (ratio − 1) | CoinGecko |

Each signal score is kept to one decimal, each contribution (score × weight) is rounded to 0.1 point, and **the index is the exact sum of the five contributions**. All inputs for a date describe that same UTC day; only completed days are scored.

Bands: 0–24 Extreme fear · 25–44 Fear · 45–55 Neutral · 56–75 Greed · 76–100 Extreme greed.

`fear_greed_altme` is the Alternative.me Crypto Fear & Greed Index for the same date, included for comparison only. It is not an input.

## Known limitations

- The method is early-stage and has not been validated. Momentum and volume often reach the 100 cap during strong rallies.
- History before 29 June 2026 cannot be reconstructed with the same funding source.
- Public APIs occasionally revise past values; archived rows keep the values seen when they were recorded.

© 2026 2A Research · Data from CoinGecko, OKX, DefiLlama and Alternative.me.

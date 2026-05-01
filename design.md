# FXGlobal Africa — Single Page

This project is a single-page currency converter with:

- Live conversion (amount + from/to)
- A historical chart (7/30/90 days)
- FAQ section at the bottom
- A "Trending African Markets" table + ticker (reference rates)

## Files

- `index.html` — page structure
- `styles.css` — small custom CSS (ticker + chart sizing)
- `app.js` — API calls + Chart.js rendering + markets table

## UI Stack

- Tailwind via CDN (no build step)
- Chart.js via CDN

## API (Free)

This uses the free Frankfurter API:

- Currencies list: `GET https://api.frankfurter.app/currencies`
- Latest rate: `GET https://api.frankfurter.app/latest?from=NGN&to=USD`
- Convert amount: `GET https://api.frankfurter.app/latest?amount=1000&from=NGN&to=USD`
- Time series: `GET https://api.frankfurter.app/2026-04-01..2026-05-01?from=NGN&to=USD`

## Historical Chart Data

Primary historical source is Alpha Vantage `FX_DAILY` (parsing `Time Series FX (Daily)` and `4. close`), with:

- 24h localStorage cache
- Fallback to UniRateAPI timeseries
- Final fallback to simulated series (deterministic + anchored to latest rate)

## Run

Open `index.html` in a browser.

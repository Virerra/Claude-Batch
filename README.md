# Claude Batch

A free, open-source tool that queues up requests to Claude and fires them off at a pace you control — so you stop hitting rate limits and stop babysitting a loop.

**[Try it live →](https://virerra.github.io/Claude-Batch/)** or just download `index.html` and open it locally, no setup required.*

## Why

If you're running a spreadsheet through Claude row by row, summarizing a folder of files, or doing any kind of repetitive batch work, you'll eventually hit a usage limit and have to wait it out. Claude Batch solves that by doing the waiting for you: dump in everything you want processed, set an interval, and it sends one request at a time at that pace until the queue is empty.

## What it does

- **Add requests in bulk** — paste in a block of text, one prompt per line, and they're all queued.
- **Set the pace** — pick an interval (e.g. one request every 45 seconds) and Claude Batch paces itself accordingly.
- **Watch it run** — every request shows live status (pending → processing → completed/failed) with the response as it comes in.
- **Export your results** — download everything as JSON, CSV, or plain text when the queue finishes.
- **Bring your own key** — you paste in your own Anthropic API key. It's used only to call `api.anthropic.com` directly from your browser. Nothing is sent anywhere else, and there is no backend.

## What it deliberately doesn't do

This is a lean, single-purpose utility, not a platform. No accounts, no request history/logging beyond the current session, no multi-user support. If you close the tab, the queue is gone (export first).

## Running it

There's no build step and no server. Pick whichever is easiest:

1. **Just open it.** Download `index.html` and double-click it, or open it directly in any modern browser.
2. **Host it for free with GitHub Pages** (recommended for this repo):
   - Go to **Settings → Pages** in this repository
   - Under "Build and deployment," set **Source** to "Deploy from a branch"
   - Set **Branch** to `main` and folder to `/ (root)`, then **Save**
   - GitHub publishes it at `https://virerra.github.io/Claude-Batch/` within a minute or two
   - Every push to `main` redeploys automatically — no build step to configure
3. **Any other static host.** Netlify, Vercel, Cloudflare Pages, an S3 bucket — it's a single static file with no dependencies beyond Google Fonts (which you can also self-host if you want a fully offline copy).

## Getting an API key

You'll need an Anthropic API key to use Claude Batch. Get one from the [Anthropic Console](https://console.anthropic.com/), then paste it into the key field at the top of the app. By default the key is saved in your browser's local storage so you don't have to re-enter it — uncheck "remember in this browser" if you'd rather not persist it.

**Your key never leaves your browser.** Requests go straight from your browser to `https://api.anthropic.com` using the `anthropic-dangerous-direct-browser-access` header. There is no Claude Batch server in the loop at all — which also means there's nothing for anyone but you to log, see, or lose.

## Cost

Claude Batch itself is free. You pay Anthropic directly for whatever API usage you run through it, at standard API rates — check [current pricing](https://www.anthropic.com/pricing) for the model you choose.

## A note on rate limits

Claude Batch helps you stay *under* rate limits by spacing out requests — it doesn't bypass them. If you still hit a limit at a given pace, try a longer interval, or check your usage tier in the Anthropic Console.

## Testing

`test-harness.js` loads the real `index.html` into a headless DOM (via jsdom), mocks `fetch`, and drives the actual UI — clicking buttons, typing into fields, and asserting on the resulting state. It's testing the live app code, not a reimplementation of it.

```bash
npm install
npm test
```

What's covered: bulk-adding prompts, pacing (the interval between requests is actually measured, not assumed), stopping a run mid-flight, retry-with-backoff on rate-limit and server errors (honoring the API's `retry-after` header when present), immediate failure on non-retryable errors like a bad API key, the manual "Retry this request" affordance, CSV export, and protection against clearing the queue while a request is in flight.

## Known limitations

- Requests are sent one at a time, in the order added — there's no concurrency, by design, since pacing is the entire point.
- If you close the tab mid-run, the queue is gone. Export early and often if a batch matters to you.
- The visual progress bar on a "processing" row is a soft pulse, not a literal countdown — actual API response time varies and isn't known in advance.

## Contributing

Issues and pull requests welcome. The whole app is one HTML file (`index.html`) with no build tooling, so it's easy to read top to bottom and easy to fork. Run `npm test` before opening a PR — it'll catch regressions in the queueing, pacing, or retry logic.

## License

MIT — see [LICENSE](./LICENSE). Do whatever you want with it.

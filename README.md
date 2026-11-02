# Calorie Log

A small calorie tracker you can install on Android as a PWA.

- **Daily log**: one entry per day, with day-by-day navigation and an optional daily goal.
- **Calculator**: add food with a built-in calculator (+ − × ÷ and parentheses), e.g. `250×2+80÷4`.
- **Ask AI**: describe the food, add a weight and/or photo, and Claude (`claude-opus-5-5`) estimates the calories. You can adjust the result before it goes into the log.
- Everything is stored on the device (IndexedDB). Use **Settings → Export backup** to save a JSON copy.

Tap an entry to edit or delete it.

## Run locally

```bash
npm install
npm run dev
```

## Deploy (required to install on Android)

PWAs only install from an HTTPS origin. Build and host `dist/` on any static host:

```bash
npm run build
```

Free options: GitHub Pages, Netlify, Cloudflare Pages, Vercel. The build uses relative paths, so it works from a sub-path such as `https://<user>.github.io/calorie-counter/`.

Then on the phone, open the URL in Chrome → menu → **Install app** (or **Add to Home screen**).

## API key

The AI feature calls the Anthropic API directly from the browser with your own key (Settings → API key). The key stays in that browser's local storage and is only sent to `api.anthropic.com`. This is fine for a personal app on your own phone; don't ship it as a multi-user app this way, because anyone using it would have to hand over their key. For that you'd add a small backend that holds the key.

## Files

- `src/main.js`: UI and app logic
- `src/db.js`: IndexedDB storage (one record per day)
- `src/calc.js`: safe calculator expression evaluator
- `src/ai.js`: Claude call (vision + JSON output)
- `public/sw.js`, `public/manifest.webmanifest`: PWA support
- `scripts/make-icons.js`: regenerates the app icons (`npm run icons`)

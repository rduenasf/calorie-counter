# Calorie Log

A small calorie tracker you can install on Android as a PWA.

- **Daily log**: one entry per day, with day-by-day navigation and an optional daily goal.
- **Calculator**: add food with a built-in calculator (+ − × ÷ and parentheses), e.g. `250×2+80÷4`.
- **Ask AI**: describe the food (with its weight if you know it), add a photo if you like (take one with the camera or choose from the gallery), and Gemini (`gemini-3.8-flash`, falling back to `gemini-3.6-flash` if it doesn't answer) estimates the calories. You can adjust the result before it goes into the log.
- **Weekly bank**: tap the Week pill to see the week against goal × 7. Select a day there and mark it as invalid to leave it out, so one invalid day makes the budget goal × 6 and its calories stop counting.
- Everything is stored on the device (IndexedDB). Use **Settings → Export backup** to save a JSON copy.
- **Sync (optional)**: sign in with Google in Settings to keep the log, invalid days and photo thumbnails the same on all your devices (Firebase). It still works offline and catches up later. See [Sync setup](#sync-setup).
- AI entries keep a small thumbnail of the photo (320px), shown in the list and when editing.

Tap an entry to edit or delete it. Press and hold one, then release, to copy its notes to the clipboard.

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

The AI feature calls the Gemini API directly from the browser with your own Google AI Studio key (Settings → Gemini API key). The key stays in that browser's local storage and is only sent to `generativelanguage.googleapis.com`. This is fine for a personal app on your own phone; don't ship it as a multi-user app this way, because anyone using it would have to hand over their key. For that you'd add a small backend that holds the key.

## Sync setup

Sync uses Firebase Auth (Google sign-in) and Cloud Firestore, both on the free Spark plan; no card is needed. Thumbnails are stored inside the Firestore entries (about 15–30 KB each), so Cloud Storage isn't used. Without the config below, the app builds and runs local-only, as before.

1. In the [Firebase console](https://console.firebase.google.com/), create a project.
2. **Build → Authentication → Get started → Sign-in method**: enable **Google**. Under **Settings → Authorized domains**, add the domain you host on (e.g. `<user>.github.io`). `localhost` is already there.
3. **Build → Firestore Database → Create database** (production mode, any region). On the **Rules** tab, paste [`firestore.rules`](firestore.rules) and publish.
4. **Project settings → Your apps → Add app → Web**, and copy `apiKey`, `projectId` and `appId`.
5. Local dev: copy `.env.example` to `.env.local` and fill them in.
   GitHub Pages: add them as repository **variables** (Settings → Secrets and variables → Actions → Variables) named `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_APP_ID`; the deploy workflow passes them to the build.
6. On each device: Settings → **Sign in with Google**. The first sign-in merges what's on that device into the account.

These values are public by design (they end up in the built JS). The Firestore rules are what keep each account's log private.

How it works: the device keeps its IndexedDB copy and stays the source of truth. Local changes go into an outbox and are pushed when signed in. Each entry is its own Firestore doc, so edits to different entries never clash; for the same entry, the newer edit wins. Deletes are kept as small tombstones so they reach devices that were offline. After the first sign-in, a device only reads what changed since its last sync, which keeps reads far below the free quota.

Signing out keeps the log on the device, and changes made while signed out are pushed at the next sign-in. Signing in with a different account on the same device merges this device's log into that account too.

## Files

- `src/main.js`: UI and app logic
- `src/db.js`: IndexedDB storage (one record per day)
- `src/sync.js`, `src/outbox.js`, `src/firebase-config.js`: Firebase sync (loaded only when configured)
- `firestore.rules`: Firestore security rules for sync
- `src/calc.js`: safe calculator expression evaluator
- `src/ai.js`: Gemini call (vision + JSON output)
- `public/sw.js`, `public/manifest.webmanifest`: PWA support
- `scripts/make-icons.js`: regenerates the app icons (`npm run icons`)

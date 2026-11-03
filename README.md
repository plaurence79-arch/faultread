# FaultRead

Photograph a fault code on a machine — a cab display or a printout — and get back what it
means, why it happens and what to try, ordered cheapest and quickest first.

No account, no sign-in, no server. It installs to the iPhone home screen as a web app and
everything it saves stays on the phone.

---

## Run it on this Mac

```bash
cd "/Users/meerkat/Fault Code Reader" && python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## Put it on the iPhone

The app needs to be served over HTTPS for the home-screen install and the camera to work.
GitHub Pages is free and takes about five minutes.

1. Make a new **public** repository on GitHub (private repos need a paid plan for Pages).
2. Push this folder to it:

```bash
cd "/Users/meerkat/Fault Code Reader" && git init && git add . && git commit -m "FaultRead" && git branch -M main && git remote add origin https://github.com/YOURNAME/faultread.git && git push -u origin main
```

3. In the repo: **Settings → Pages → Source: Deploy from a branch → main / (root)**. Save.
4. Wait a minute, then open `https://YOURNAME.github.io/faultread/` in **Safari** on the iPhone.
5. Share button → **Add to Home Screen**. The icon appears. Tapping it opens the app full
   screen with no Safari chrome.

It must be Safari for the install — Chrome on iOS cannot add a web app to the home screen.

## The API key

On first launch the app asks for a Google Gemini API key. Get one free at
<https://aistudio.google.com/apikey>.

- The key is kept in this browser's local storage on the phone. It is never sent anywhere
  except to Google's API.
- The free tier is far more than one person doing a few scans a day will ever use.
- On the free tier Google may use the data to improve their products. A paid key does not.
- The key sits in the app on your phone. That is fine for personal use. Do not hand the
  installed app or the repo's storage to anyone else without regenerating it.

The app asks Google which models the key can reach and picks the best Flash model
automatically. You can override it in Settings.

## What works without a signal

- **Typed codes** get looked up against `codes.json`, which ships with the app: the full SAE
  J1939 FMI list, about 130 common SPNs, and the standard OBD-II P-codes. You get the
  official description, clearly marked as a dictionary lookup with no diagnosis.
- **Saved diagnoses** are all readable offline.
- **Photos** need a signal — reading the image is what Gemini is there for.

## The voice note

On the machine details screen there is a mic. It works one of two ways, picked automatically:

- **Speech recognition** where the browser has it (iOS Safari does): your words land in the
  text box as you speak, and you can edit them before pressing Diagnose.
- **Recording** as a fallback: the audio is attached and sent to Gemini, which listens to it
  directly. Often better in a noisy yard than a transcript.

Either way you can just type instead. Whatever you add gets used — if it changes the ranking
of the causes, the result says so.

## What it will not do

- **Manufacturer-specific codes are not in any public table.** Cat E-codes, Komatsu CA codes,
  Hitachi and JCB numbering are proprietary. For those the app says plainly that it is
  reasoning from the subsystem rather than quoting a manual. Treat that as a pointer.
- **It is not a scan tool.** No live data, no freeze frames, no clearing codes. It reads what
  is already on the display.
- **OCR can misread.** Every result shows the code it read with a "Read the code wrong?" box
  that re-runs with your correction.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Every screen, as one page |
| `app.css` | All styling |
| `app.js` | Flow, Gemini calls, voice, storage |
| `codes.json` | The offline code table |
| `sw.js` | Service worker — offline shell |
| `manifest.webmanifest` | Home-screen install |
| `tools/make-icons.mjs` | Regenerates the icons (`node tools/make-icons.mjs`) |

## When you change something

Bump the version in three places, or the phone will keep the old copy:

1. `index.html` — the `?v=` on `app.css` and `app.js`
2. `sw.js` — the same `?v=` in `SHELL`, and the `CACHE` name
3. `app.js` — `VERSION` (cosmetic, shows in Settings)

Then push. The app picks up the new version on its second launch.

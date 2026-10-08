# COGS Desktop

Windows app for entering a lot of data at once:

- **Receipts**: drop in a stack of receipt photos. Each is read by OCR, its lines are matched to
  items (pack sizes convert to the item's unit: 2 × "TERIGU 1KG" → 2000 g), you check it against
  the photo and save it as a purchase. Every saved receipt teaches the matcher for next time.
- **Stock moves**: a grid for many stock changes at once: In, Out (waste, kitchen use) and Count
  (opname). Paste rows from Excel/Sheets (`item, quantity, note`), then sync.

It signs in with the same username and password as the web app and saves through the same API
(`https://cogs-seven.vercel.app`), so FIFO costing and the journal entries work exactly as on the
web. Supabase keys never live on the PC.

## Reading receipts

| | This computer (default) | Claude |
|---|---|---|
| Setup | none (first scan downloads ~15 MB of language files) | Anthropic API key in Settings |
| Cost | free | a few US cents per receipt |
| Works offline | yes | no |
| Good at | flat, sharp, printed receipts | crumpled, faded or handwritten ones; matching lines to items |

You can switch per receipt with **Read again** / **Read with Claude**.

## Local data

Drafts, unsynced stock moves, learned matches and receipt photos stay in
`%APPDATA%\COGS Desktop` until saved (Settings → Local data opens it). The API key is encrypted
with Windows' own protection. Nothing there is the source of truth; the database is.

## Development

```bash
npm install
npm run dev     # Vite + Electron against the local backend (http://localhost:3001)
npm test        # receipt parser and matcher tests
npm run dist    # installer -> ../release/desktop/COGS Desktop Setup x.y.z.exe (uses the deployed API)
```

The UI reuses sign-in, the API client, styles and UI pieces from `../frontend/src`, so install
the frontend's dependencies too. Run `npm run dev` from a normal terminal. VS Code's terminal
sets `ELECTRON_RUN_AS_NODE`, which stops Electron from opening a window.

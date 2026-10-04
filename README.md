# mathter-mcp

Ask your AI assistant for a math worksheet pack. Get a printable PDF on your computer.

> *"Make me a grade 4 times-tables pack for Friday."*
>
> → `mathter-grade-4-multiplication-2026-10-04-1532.pdf` in your Downloads folder, answer keys
> included. (Cover and lesson pages come with the Standard plan and up.)

This is a small [Model Context Protocol](https://modelcontextprotocol.io) server that connects
[Mathter](https://mathter.ca) to Claude Desktop, Claude Code, Cursor, or any other MCP client. It
does one thing: it turns a plain-English request into a real worksheet pack from your own Mathter
account, saved as a file you can open and print.

You need a Mathter account and an API key. Both are free to start: the free plan makes packs of
up to 2 worksheets with answer keys, and paid plans raise the size and add cover and lesson
pages.

---

## Setup (about two minutes)

### 1. Get your key

Sign in at [mathter.ca/account](https://mathter.ca/account), find **API access**, and create a
key. It looks like `mk_live_…` and is shown **once** — copy it before you close the page. If you
lose it, revoke it and make another; that is normal and costs nothing.

### 2. Tell your assistant about it

**Claude Desktop** — open Settings → Developer → Edit Config, and add the
`mathter` entry under `mcpServers` (or merge this block into your config file):

```json
{
  "mcpServers": {
    "mathter": {
      "command": "npx",
      "args": ["-y", "mathter-mcp"],
      "env": { "MATHTER_API_KEY": "mk_live_YOUR_KEY" }
    }
  }
}
```

Then restart Claude Desktop. (The config file lives at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows, if you would rather edit it directly.)

**Claude Code** — one command:

```bash
claude mcp add mathter --env MATHTER_API_KEY=mk_live_YOUR_KEY -- npx -y mathter-mcp
```

**Cursor, Windsurf and friends** — same JSON block as Claude Desktop, in whatever file that
app uses for MCP servers. Some editors (Zed, for instance) wrap the entry differently — check their
MCP docs for the exact shape; the command, arguments and `MATHTER_API_KEY` are the same everywhere.
The server speaks stdio; there is nothing to host and no port to open.

You do not need to install anything first. `npx -y mathter-mcp` fetches it on demand. Node 18 or
newer is the only requirement.

### 3. Ask for worksheets

> "What math skills can Mathter do for grade 3?"
> "Make a 5-page grade 3 subtraction pack called Warm-Ups, easy difficulty."
> "A blank multiplication chart for grade 4."
> "Ten worksheets of grade 6 fractions, hard, with worked solutions."

The assistant replies with the path to the PDF. Open it and print.

---

## What the assistant can do

### `list_skills`

Asks mathter.ca which skills exist right now and which grades each one covers. Your assistant
should call this before generating, so it picks a real skill rather than guessing. No key is sent
— that list is public.

### `generate_worksheet_pack`

Makes the pack. Only `skill` and `grade` are required; everything else has a sensible default.

| Option | What it does | Notes |
|---|---|---|
| `skill` | **Required.** Which skill to drill, e.g. `multiplication` | Must be one `list_skills` returns, and must be taught at that grade |
| `grade` | **Required.** 0 (kindergarten) to 12 | — |
| `theme` | One of ten colour palettes | Defaults to `teal`; every plan has all ten |
| `style` | `modern`, `classic`, `notebook`, `studio`, `ledger`, `blueprint` | Plan-gated: free has `modern`, Standard adds `classic`/`notebook`, Premium has all six |
| `difficulty` | `easy`, `medium`, `hard` | Default `medium` |
| `title` | Printed on the pack | Default "Math Lesson", trimmed at 80 characters |
| `worksheetCount` | How many sheets | Capped by plan: free 2, Standard 10, Premium 25. Left out, you get 10 or your cap, whichever is smaller |
| `problemsPerPage` | Questions per page | Default 12, capped by what fits the page |
| `includeAnswerKeys` | Answer keys | On by default |
| `includeCover` / `includeLesson` | Cover page, "how to" page | On by default, Standard and up |
| `workedSolutions` | Step-by-step solutions in the key | Where the skill has steps authored |
| `focus` / `focusOrder` | Single-number drill, e.g. the 7 times table | Addition, subtraction, multiplication, division only |
| `chart` | `{ "mode": "filled" }` or `"blank"` — a times-table chart | Multiplication only |
| `timed` | Mad-minute drill | The four fact skills only |
| `diagrams`, `graphBlank`, `unitSystem` | Geometry figures, blank grids, metric/imperial | Only where the skill uses them |
| `shopName` | Branding name on the pack | Premium only; otherwise quietly replaced |
| `seed` | Reproduce an identical pack | Default random |

Your logo comes from your Mathter account, not from here — upload it once at mathter.ca and every
pack carries it, however the pack was made.

---

## Configuration

| Variable | Required | Default |
|---|---|---|
| `MATHTER_API_KEY` | **yes** | — (the server refuses to start without it) |
| `MATHTER_BASE_URL` | no | `https://mathter.ca` |
| `MATHTER_OUT_DIR` | no | your Downloads folder, or the system temp folder if there isn't one |

Set `MATHTER_OUT_DIR` if you would rather packs landed in, say, a shared school folder:

```json
"env": {
  "MATHTER_API_KEY": "mk_live_YOUR_KEY",
  "MATHTER_OUT_DIR": "/Users/you/Documents/Worksheets"
}
```

The folder is created if it does not exist. Names never collide: a second pack of the same kind
in the same minute becomes `…-2.pdf`.

---

## Billing, in one paragraph

Packs made here are billed to your Mathter account exactly as if you had made them on the
website: same plan, same monthly allowance, same caps on pack size and styles. There is no
per-call charge and no separate API plan. Run out of credits and the assistant will tell you so
in those words. Plans are at [mathter.ca/pricing](https://mathter.ca/pricing).

## Your key

Your key stays on your machine. This server sends it to one place — the `Authorization` header of
`POST https://mathter.ca/api/generate` — and nowhere else. It is never sent to the public skills
endpoint, never written to a file, and never included in anything the server prints or hands back
to the assistant: all output is filtered for key-shaped text first, including error messages that
came from the server. That matters because chat transcripts get pasted into emails and bug
reports.

If a key is ever exposed anyway, revoke it at [mathter.ca/account](https://mathter.ca/account);
revocation takes effect immediately. A key can spend your account's allowance; it cannot change
your branding, your password, or your billing, and it cannot create other keys.

## When something goes wrong

The server answers in sentences, not status codes. The ones you may meet:

| What you see | What to do |
|---|---|
| "MATHTER_API_KEY is not set" | The key never reached the server — check the `env` block and restart the app |
| "Mathter did not accept the API key" | Wrong, mistyped, or revoked. Make a new one at mathter.ca/account |
| "Out of worksheet credits for the month" | The allowance resets next billing period, or upgrade |
| "That style is not available on this account's plan" | Drop the style, or upgrade |
| "This account is not allowed to generate packs" | An admin/support account, or a school licence that no longer covers you |
| "Mathter is rate-limiting this API key" | One pack at a time; wait the time it names. Your key is fine, nothing needs revoking |
| "Mathter is rate-limiting the public skill list" | Per-computer limit on the skill list, which never sends your key. Wait a minute |
| "The renderer is busy" | Backpressure, not breakage. Retry in half a minute; nothing was charged |
| "Mathter rejected that configuration" | Usually a skill that isn't taught at that grade — ask for the skill list again |

Still stuck? [mathter.ca/contact](https://mathter.ca/contact).

---

## For developers

A thin HTTP client over two endpoints, stdio transport. One direct runtime dependency —
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — which
brings its own tree, so a real install is around 90 packages, the SDK's HTTP-transport
dependencies among them. No telemetry, no analytics, no network calls other than the two documented
above. `MATHTER_BASE_URL` points it at a dev instance.

```bash
npm ci           # a lockfile is committed; plain `npm install` may need --legacy-peer-deps
npm test         # vitest, against a local stub HTTP server — never the real API
npm run typecheck
npm run build    # tsc -> dist/
```

The published tarball is `dist/`, this README and the licence; sources and tests stay in the
repository.

MIT licensed. Mathter is at [mathter.ca](https://mathter.ca); the API itself is documented at
[mathter.ca/api](https://mathter.ca/api).

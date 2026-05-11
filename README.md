# FT Tools

Small Financial Times extraction tools for agents using the user's logged-in
Chrome session.

These tools connect to Chrome remote debugging, open FT in that browser context,
and run focused extractors for the homepage and article pages. They are intended
to avoid generic browser exploration every time an agent needs FT headlines or
article text.

## Requirements

- Chrome remote debugging is running on `127.0.0.1:9222`.
- The user is already logged in to `ft.com` in that Chrome profile.
- Node.js 22+.

Install dependencies once:

```bash
npm install
```

By default the CLI uses the Playwright MCP Bridge extension and the configured
`PLAYWRIGHT_MCP_EXTENSION_TOKEN`. This avoids Chrome's repeated "Allow remote
debugging" prompt. Direct Chrome DevTools Protocol is still available as an
explicit fallback with `--transport cdp`, but that mode can trigger Chrome's
remote-debugging approval UI.

## Commands

Fetch top homepage articles:

```bash
node ft.js headlines --limit 10
```

Fetch and cache one article:

```bash
node ft.js article --url "https://www.ft.com/content/f66186e7-8e14-466d-b4de-114ee70c3e62"
```

Use a headline rank from the most recent headline cache:

```bash
node ft.js article --rank 5
```

Print a compact text summary shape instead of JSON:

```bash
node ft.js headlines --limit 10 --format text
node ft.js article --rank 5 --format text
```

Force direct CDP fallback only when needed:

```bash
node ft.js headlines --limit 10 --transport cdp
```

## Cache

Outputs are cached under `./data` by default:

- `data/headlines_latest.json`
- `data/headlines_YYYY-MM-DD.json`
- `data/articles/<content-id>.json`

Override with:

```bash
node ft.js headlines --cache-dir /path/to/cache
```

## Notes For Agents

- Prefer this tool before generic Playwright/browser inspection for FT.
- The homepage extractor is based on the FT structure observed on 2026-05-11:
  homepage story links use `/content/<uuid>` URLs, duplicate links often contain
  standfirsts, and visible display order can be inferred from anchor bounding
  boxes plus DOM order.
- The article extractor reads `h1`, meta descriptions, publication metadata,
  byline-ish text, and visible article paragraphs.
- The output is intentionally normalized JSON so the summarization step can use
  concise structured data instead of large DOM snapshots or HTML.
- Do not set `--transport cdp` for routine use unless you are willing to approve
  Chrome's remote-debugging prompt.

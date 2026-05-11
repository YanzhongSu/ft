---
name: ft
description: Fetch Financial Times homepage headlines and article text through the user's logged-in Chrome session, using the local FT tools in this folder instead of generic browser exploration.
---

# FT

Use this skill when the user asks to read, summarize, cache, or inspect
Financial Times (`ft.com`) headlines or articles and they have a logged-in
Chrome session.

## Workflow

Prefer the local CLI over generic browser browsing:

```bash
cd /path/to/ft
node ft.js headlines --limit 10 --format json
node ft.js article --rank 5 --format json
```

Use `--format text` for a human-readable extraction.

Use `--include-opinion` only when the user wants opinion/editorial links mixed
into homepage headline results.

## Cache

The CLI writes:

- `data/headlines_latest.json`
- `data/headlines_YYYY-MM-DD.json`
- `data/articles/<content-id>.json`

Read these cached JSON files before re-fetching when the user asks follow-up
questions in the same session.

## Requirements

Chrome remote debugging must be available. The CLI can discover Chrome using
the same `DevToolsActivePort` mechanism used by opencli. If discovery fails,
set `FT_CDP_ENDPOINT=ws://127.0.0.1:<port>/devtools/browser/<id>`.

Default transport is the Playwright MCP Bridge extension, using
`PLAYWRIGHT_MCP_EXTENSION_TOKEN`. This is preferred because it avoids repeated
Chrome "Allow remote debugging" prompts. Use `--transport cdp` only as an
explicit fallback.

## Caution

Article JSON may contain full article paragraphs. Summaries are fine, but do
not paste full FT article text back to the user.

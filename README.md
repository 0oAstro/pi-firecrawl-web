# pi-firecrawl-web

Everyday web browsing for the [Pi coding agent](https://pi.dev), powered by [Firecrawl](https://www.firecrawl.dev).

`pi-firecrawl-web` gives Pi three tools: `web_search`, `web_fetch` and `web_map`. The pages come from the same Firecrawl API as the official integrations. What this extension changes is what the model gets back:

- **Short defaults for the model.** Search returns titles, URLs and snippets. Fetch returns a small HTTP/cache header followed by readable Markdown, not a JSON envelope.
- **Local cleanup.** [Defuddle](https://github.com/kepano/defuddle) cleans Firecrawl's HTML into Markdown on your machine and keeps code blocks and tables.
- **Focused extraction with a model you choose.** Give `web_fetch` an `instruction` and a model you configure in Pi pulls out only the relevant part.
- **Bounded output you can recover.** Output that exceeds its limit returns a preview plus a private file path. Pi's built-in `read` tool can page through that file without a second fetch.
- **Native Pi UI.** Tool calls render as compact one-line summaries, and you can expand any result.

This is an independent, unofficial project. It is not affiliated with Firecrawl, and it is not a new search engine. Search results, URL discovery and page scraping all come from Firecrawl.

## Install

You need Pi, Node.js with npm, and a [Firecrawl API key](https://www.firecrawl.dev).

```bash
git clone https://github.com/0oAstro/pi-firecrawl-web.git
cd pi-firecrawl-web
npm ci
export FIRECRAWL_API_KEY='fc-your-key'   # better: load it from your secret manager or shell environment
pi -e ./index.ts
```

Once Pi starts, run `/firecrawl`. It confirms that a key is set and shows which focused-extraction model is configured. It does not check network access or whether the model is authenticated.

**Keep it loaded.** Add the absolute path of `index.ts` to the `extensions` array in `~/.pi/agent/settings.json`. If the file already has an `extensions` array, merge this entry into it rather than replacing it:

```json
{
  "extensions": ["/path/to/pi-firecrawl-web/index.ts"]
}
```

Leave the checkout and its `node_modules` in place, because Pi loads the dependencies from the same directory. After you add the entry or pull an update, run `/reload` or start a new session.

Notes:

- This repository has no `pi` package manifest yet, so `pi install git:…` is not a supported install path. Load `index.ts` explicitly as shown above.
- Don't clone into a directory Pi auto-discovers, such as `~/.pi/agent/extensions/` or `.pi/extensions/`, and then also list the path in settings. The extension would load twice.
- This extension and the official [`@firecrawl/pi-firecrawl`](https://github.com/firecrawl/pi-firecrawl) both register a `/firecrawl` command. Load only one of them in a session.

## Tools

### `web_search`

Searches the web through Firecrawl and returns up to 5 results by default (maximum 20), each with a title, URL and snippet.

| Option | Behavior |
|---|---|
| `limit` | Number of results, 1–20. Default: 5. |
| `includeDomains` / `excludeDomains` | Limit results to certain domains, or exclude domains. Use one or the other, not both. |
| `recency` | `hour`, `day`, `week`, `month` or `year`. |
| `includeContent` | Fetches page Markdown in the **same** Firecrawl request, which costs extra credits. Each result gets a preview of up to 2,400 characters with code formatting kept. |
| `maxAge` | Only valid with `includeContent: true`. It sets how old a cached copy of each page may be. It does not affect how fresh the search index is. |
| `maxChars` | Output budget. Default: 8,192. Maximum: 20,000. |

### `web_fetch`

Fetches one URL. By default it requests Markdown and HTML together, cleans the HTML locally with Defuddle, and falls back to Firecrawl's Markdown if cleaning produces nothing. The output starts with a compact header:

```text
Page: asyncio — Coroutines and Tasks
URL: https://docs.python.org/3/library/asyncio-task.html
HTTP: 200; cache=hit; cachedAt=…; age=…s
```

If Firecrawl reports no cache state, the header says `cache=unknown`. That does not mean the page is fresh. If the source returns HTTP 400 or higher, the tool fails before any extraction runs.

| Option | Behavior |
|---|---|
| `formats` | 1–4 of `markdown`, `summary`, `html`, `rawHtml`, `links`, `images`, `screenshot`, `branding`, `audio`, `highlights`. Default: `markdown`. |
| `onlyMainContent` | Default: `true`. Set it to `false` to skip Defuddle and keep Firecrawl's full Markdown. |
| `maxAge` | Maximum cache age in **milliseconds**. `0` forces a fresh fetch. Leave it out to use Firecrawl's default cache policy. |
| `instruction` | Runs focused extraction (see below). |
| `maxChars` | Default: 20,000, or 12,000 with an `instruction`. Maximum: 40,000. |

Inline binary data from screenshots or audio is left out of the text, but screenshot and audio URLs are kept. `branding` output appears as JSON.

### `web_map`

Lists URLs on a site, with titles and descriptions when Firecrawl provides them. Options: `search` ranks or filters the URLs, `limit` defaults to 100 (maximum 500), and `maxChars` defaults to 12,000 (maximum 20,000).

### Examples

Usually you just ask Pi in plain language ("check the current asyncio TaskGroup docs") and the model picks a tool. The arguments it sends look like this:

```jsonc
// web_search: snippets only, limited to one site and to the past year
{ "query": "asyncio TaskGroup cancellation", "includeDomains": ["docs.python.org"], "recency": "year" }

// web_fetch: force a fresh copy of the page
{ "url": "https://docs.python.org/3/library/asyncio-task.html", "maxAge": 0 }

// web_fetch: focused extraction
{ "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429",
  "instruction": "Return the status code and the name of the retry header." }

// web_map: find the relevant pages before fetching them
{ "url": "https://docs.python.org/3/library/", "search": "asyncio", "limit": 20 }
```

## Focused extraction

An `instruction` on `web_fetch` sends the cleaned page to a text model configured in Pi. The model is a Pi model you choose, not Firecrawl's JSON/schema extraction. The model comes from `~/.pi/agent/settings.json`:

```json
{
  "firecrawl-web": {
    "fetchModel": "openai-codex/gpt-5.3-codex-spark"
  }
}
```

If this setting is missing, the extension uses `openai-codex/gpt-5.3-codex-spark`. The value must match a `provider/model` that Pi knows and that has working authentication. If the model is unavailable or the call fails, `web_fetch` returns the cleaned page instead, with a notice at the top.

The model sees at most 120,000 characters of the page. For longer pages, part of the middle is left out, and the output starts with a warning. A focused answer is generated text, so it can be incomplete or wrong. When you need the exact source, run `web_fetch` without an `instruction`.

## Long output

Each tool applies a character budget (`maxChars`). It also applies byte and line limits that keep output under Pi's own tool-output limits. When output goes over:

1. The extension saves the full selected text in a new private temporary directory (mode `0700`, file mode `0600`).
2. The tool returns the start of the output and the absolute `fullOutputPath`.
3. The model reads more with Pi's existing `read` tool, using `offset`/`limit` line ranges. This does not fetch the page again or use more Firecrawl credits.

What the saved file contains:

- **Plain fetch or extraction fallback:** the complete selected text, including its source header and requested formats; Markdown is cleaned by default.
- **Successful focused extraction:** the generated answer and source header, not the full source page.
- **Search:** the formatted result previews, not full pages.
- **Map:** the formatted URL list.

Saved files stay until your OS or you clean up temporary files. Ending a session does not delete them, but they are not permanent storage. The `read` tool has a byte limit, so a single very long line (for example minified HTML) may need slicing with `bash`. Use a read-only command so the saved file stays unchanged.

## Why choose this over the official integrations?

**For everyday Pi research, this is a better default interface—not a more powerful backend.** It puts output budgets, readable page text and local continuation into the tools themselves. The model doesn't need to sift through a full SDK response or fetch a long page again just to read the next section. Those workflows can also be built around the official tools; here, they're the default.

All three use Firecrawl. The table compares how each integration exposes it. Facts about the official projects come from pinned snapshots: [`firecrawl/pi-firecrawl@2d7e896`](https://github.com/firecrawl/pi-firecrawl/tree/2d7e8966ad63744fa7d5932f7bd5b4a78eddb894) and [`firecrawl/firecrawl-mcp-server@7aa942e`](https://github.com/firecrawl/firecrawl-mcp-server/tree/7aa942ec89173ae2cd5fc2ed87ba0b52ea1989ea). Newer versions may be different.

| | pi-firecrawl-web | Official Pi extension | Official Firecrawl MCP |
|---|---|---|---|
| How it connects | Native Pi extension | Native Pi extension | MCP server: hosted, or local via `npx` |
| Tools | 3: search, fetch, map | 9: scrape, search, map, crawl (+ status/cancel), batch scrape (+ status), extract | Full profile adds crawl, interact, parse, agent, research, monitor and more. The hosted keyless endpoint exposes a 3-tool subset. |
| What the model gets back | Curated text: snippets, or an HTTP/cache header plus Markdown | The SDK response as indented JSON ([`jsonResult`](https://github.com/firecrawl/pi-firecrawl/blob/2d7e8966ad63744fa7d5932f7bd5b4a78eddb894/src/index.ts#L528-L533)) | Tool-specific JSON or Markdown |
| Local HTML cleaning | Defuddle | Not in snapshot | Not described |
| Targeted extraction | Natural-language `instruction` sent to a Pi model you configure | Firecrawl JSON format with prompt/schema, plus `firecrawl_extract` | Scrape JSON with prompt/schema, plus `firecrawl_agent` |
| Oversized output | Preview plus a private temp file you page through with `read` | No explicit continuation in snapshot | Depends on the client. Large retained results can go to a remote workspace. |
| Custom Pi result rendering | Yes | Not in snapshot | Depends on the MCP client |
| Cache control (`maxAge`) | Yes | Yes | Yes |
| Crawl, browser actions, proxies, timeouts | No | Yes | Yes (full profile) |
| Batch scrape jobs | No | Yes | Not exposed as an MCP tool in snapshot; use the Firecrawl API |
| Custom or self-hosted API URL | No, uses `api.firecrawl.dev/v2` only | `FIRECRAWL_API_URL` | `FIRECRAWL_API_URL` |
| Install | Clone and load `index.ts` | `pi install npm:@firecrawl/pi-firecrawl` | Hosted URL, or `npx firecrawl-mcp` |

**When to use this extension:** everyday research inside Pi, where you want short answers with sources and clean Markdown to read. It calls Firecrawl directly, so you don't need to set up an MCP connection.

**When to use the official options:** choose the official Pi extension for crawls, batch jobs, schema-typed JSON or richer scrape controls. Choose MCP for its broader research/browser tools, document parsing or clients other than Pi. Both official projects support a custom Firecrawl API URL; this extension does not. The official Pi extension also has a simpler install.

A small informal test compared an earlier version of this extension with a hosted Firecrawl MCP connection. Both returned the same five search URLs in the same order. This extension's responses had fewer characters, partly because MCP returns structured data. MCP had the lower median latency on every repeated workload, and all of its sampled scrapes were cache hits. Treat this as anecdote, not a benchmark. It says nothing about tokens, cost or accuracy in general, and the official Pi extension was not measured.

## Limitations

- Only three tools: no crawl, batch scrape, browser actions, document parsing or schema-typed JSON output.
- The search source is fixed to `web`. Firecrawl's news and image sources are not exposed.
- The API key comes only from the `FIRECRAWL_API_KEY` environment variable. There is no config-file or keychain fallback.
- The API endpoint is fixed to `https://api.firecrawl.dev/v2`.
- Defuddle cleaning is heuristic. On unusual pages, run `web_fetch` with `onlyMainContent: false` to get Firecrawl's Markdown unchanged.
- Focused extraction depends on a working model in Pi, and model usage costs extra.

## Security and privacy

- URLs and search queries go to Firecrawl. With an `instruction`, the cleaned page also goes to your configured model provider.
- The extension does not intentionally log or output the API key or request headers. It does not validate URLs itself. It passes them to Firecrawl.
- Page content is untrusted. The focused-extraction prompt tells the model to ignore instructions embedded in the page, but that is a mitigation, not a guarantee.
- Saved output files use private permissions, but they contain the page text you requested. If a page contains sensitive data, so does the file.

## Validation

Tests run through Pi's extension loader. There is no `npm test` script. Offline mode makes no API or model calls:

```bash
pi --offline -ne -ns -np -nc --no-session -p -e ./tests/run.ts /firecrawl-tests < /dev/null
```

Replace the prompt with `'/firecrawl-tests live'` to add three real checks: search with content, a long-page fetch, and focused extraction. The live checks spend Firecrawl and model credits. The current version passes 33 offline and 3 live checks. These are regression tests, not a comparison with other tools.

## License

[MIT](LICENSE) © 2026 0oAstro

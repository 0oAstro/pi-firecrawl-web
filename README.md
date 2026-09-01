# Compact Firecrawl web tools

Fulcrum-style Firecrawl integration for Pi. It exposes three focused tools:

- `web_search` — compact Firecrawl v2 web search
- `web_fetch` — cleaned page fetch, with optional focused extraction
- `web_map` — site URL discovery

The extension calls Firecrawl v2 directly. `web_fetch` uses Defuddle with LinkeDOM to clean Firecrawl HTML before returning Markdown.

## Output behavior

- Search snippets are compact by default; use `includeContent: true` when result content is needed.
- Search URLs are de-duplicated and oversized snippets are capped before entering context.
- Fetched Markdown is cleaned with Defuddle when HTML is available, then removes common GitHub/navigation chrome, duplicate lines, image payloads, and permalink noise.
- Large link/image lists are previewed rather than dumped in full.
- Focused extraction bounds the cleaned page input to keep the secondary model call predictable.

## Credentials

Set `FIRECRAWL_API_KEY` before starting Pi:

```bash
export FIRECRAWL_API_KEY="fc-..."
```

No config-file, command-resolver, or Keychain credential fallback is supported.

## Focused extraction model

When `web_fetch` receives an `instruction`, it reads the model from `~/.pi/agent/settings.json`:

```json
{
  "firecrawl-web": {
    "fetchModel": "openai-codex/gpt-5.3-codex-spark"
  }
}
```

The value must exactly match a model known to Pi and have working authentication. It defaults to `openai-codex/gpt-5.3-codex-spark` when the setting is absent. Run `/firecrawl` to check the API key and selected extraction model.

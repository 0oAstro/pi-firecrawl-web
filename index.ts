import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  FirecrawlClient,
  type FirecrawlScrapeFormat,
  type FirecrawlScrapeResult,
  type FirecrawlSearchResult,
} from "./client.js";
import { cleanFirecrawlHtml, extractFirecrawlContent } from "./content.js";

const RECENCY_TO_TBS = {
  hour: "qdr:h",
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
} as const;

const SCRAPE_FORMATS = [
  "markdown",
  "summary",
  "html",
  "rawHtml",
  "links",
  "images",
  "screenshot",
  "branding",
  "audio",
  "highlights",
] as const satisfies readonly FirecrawlScrapeFormat[];

const DEFAULT_FETCH_MODEL = "openai-codex/gpt-5.3-codex-spark";
const DEFAULT_SEARCH_MAX_CHARS = 8192;
const DEFAULT_FETCH_MAX_CHARS = 20000;
const DEFAULT_MAP_MAX_CHARS = 12000;
const SEARCH_SNIPPET_MAX_CHARS = 900;
const SEARCH_CONTENT_MAX_CHARS = 2400;
const SETTINGS_KEY = "firecrawl-web";

function fetchModel(): string {
  const settingsPath = join(getAgentDir(), "settings.json");
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read Firecrawl settings from ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return DEFAULT_FETCH_MODEL;
  const section = (settings as Record<string, unknown>)[SETTINGS_KEY];
  if (section === undefined) return DEFAULT_FETCH_MODEL;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error(`${SETTINGS_KEY} in ${settingsPath} must be an object.`);
  }
  const configured = (section as Record<string, unknown>).fetchModel;
  if (configured === undefined) return DEFAULT_FETCH_MODEL;
  if (typeof configured !== "string" || !configured.includes("/") || !configured.trim()) {
    throw new Error(`${SETTINGS_KEY}.fetchModel in ${settingsPath} must be a provider/model string.`);
  }
  return configured.trim();
}

function truncateOutput(output: string, maximum: number): string {
  if (output.length <= maximum) return output;
  const marker = `\n... [output truncated, ${output.length} chars total] ...\n`;
  const half = Math.max(0, Math.floor((maximum - marker.length) / 2));
  return `${output.slice(0, half)}${marker}${output.slice(-half)}`.slice(0, maximum);
}

function compactSearchText(value: string, maximum: number): string {
  const cleaned = value.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maximum) return cleaned;
  const marker = ` ... [snippet truncated, ${cleaned.length} chars total]`;
  return `${cleaned.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function presentSearch(
  result: FirecrawlSearchResult,
  query: string,
  maximum: number,
  includeContent: boolean,
): string {
  const seenUrls = new Set<string>();
  const items = result.web.filter((item) => {
    const key = item.url.trim().replace(/\/$/, "").toLowerCase();
    if (!key || seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });
  const sections = items.map((item, index) => {
    const lines = [`Result ${index + 1}: ${item.title?.trim() || "Untitled"}`, `URL: ${item.url}`];
    if (item.description?.trim()) lines.push(`Snippet: ${compactSearchText(item.description, SEARCH_SNIPPET_MAX_CHARS)}`);
    if (item.category?.trim()) lines.push(`Category: ${item.category.trim()}`);
    if (includeContent && item.markdown?.trim()) {
      lines.push(`Content:\n${compactSearchText(item.markdown, SEARCH_CONTENT_MAX_CHARS)}`);
    }
    return lines.join("\n");
  });
  const body = sections.length > 0 ? sections.join("\n\n---\n\n") : `No results returned for query: ${query}`;
  return truncateOutput(`Results for query "${query}":\n\n${body}`, maximum);
}

const BINARY_FORMATS = new Set<FirecrawlScrapeFormat>(["screenshot", "audio"]);
const MAX_LIST_ITEMS = 100;

function presentScrape(
  result: FirecrawlScrapeResult,
  url: string,
  formats: readonly FirecrawlScrapeFormat[],
  maximum: number,
): string {
  const lines = [result.metadata.title ? `Page: ${result.metadata.title}` : undefined, `URL: ${url}`].filter(
    (value): value is string => value !== undefined,
  );
  for (const format of formats) {
    const value = result[format as keyof FirecrawlScrapeResult];
    if (typeof value === "string" && value.trim()) {
      if (BINARY_FORMATS.has(format)) {
        lines.push(`${format}: [binary payload omitted from text output; ${value.length} chars]`);
        continue;
      }
      const text = value.trim();
      if (text) lines.push(format === "markdown" ? text : `${format}:\n${text}`);
    } else if (Array.isArray(value) && value.length > 0) {
      const preview = value.slice(0, MAX_LIST_ITEMS).join("\n");
      const suffix = value.length > MAX_LIST_ITEMS ? `\n... [${value.length - MAX_LIST_ITEMS} more ${format}]` : "";
      lines.push(`${format} (${value.length}):\n${preview}${suffix}`);
    }
  }
  return truncateOutput(lines.join("\n\n"), maximum);
}

function expandedToolText(result: { content?: readonly unknown[] }, expanded: boolean): string | undefined {
  if (!expanded) return undefined;
  const text = (result.content ?? []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
  return text || "No output.";
}

export default function firecrawlWeb(pi: ExtensionAPI) {
  function resolveApiKey(): string {
    const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
    if (!apiKey) throw new Error("Firecrawl is not configured. Set FIRECRAWL_API_KEY before starting Pi.");
    return apiKey;
  }

  function client(): FirecrawlClient {
    return new FirecrawlClient(resolveApiKey());
  }

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the live web through Firecrawl. Returns compact titles, URLs, and snippets; page content is opt-in. Output defaults to 8,192 characters and is capped at 20,000.",
    promptSnippet: "Search the live web through Firecrawl",
    parameters: Type.Object({
      query: Type.String({ description: "Concise web search query." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results; default 5." })),
      includeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Only return these domains." })),
      excludeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Exclude these domains." })),
      recency: Type.Optional(StringEnum(["hour", "day", "week", "month", "year"] as const)),
      includeContent: Type.Optional(Type.Boolean({ description: "Include search-provided page content when available; default false to keep search compact." })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000, description: "Maximum returned characters; default 8192." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (params.includeDomains && params.excludeDomains) {
        throw new Error("includeDomains and excludeDomains cannot be used together.");
      }
      const query = params.query.trim();
      if (!query) throw new Error("Search query cannot be blank.");
      onUpdate?.({ content: [{ type: "text", text: `Searching for: ${query}` }], details: {} });
      const result = await client().search({
        query,
        limit: params.limit ?? 5,
        sources: ["web"],
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
        tbs: params.recency ? RECENCY_TO_TBS[params.recency] : undefined,
      }, signal);
      return {
        content: [{ type: "text", text: presentSearch(result, query, params.maxChars ?? DEFAULT_SEARCH_MAX_CHARS, params.includeContent ?? false) }],
        details: {
          provider: "firecrawl",
          query,
          includeContent: params.includeContent ?? false,
          resultCount: result.web.length,
          results: result.web,
          warning: result.warning,
          creditsUsed: result.creditsUsed,
        },
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("WebSearch "))}${theme.fg("accent", `"${args.query}"`)}`, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const expandedText = expandedToolText(result, expanded);
      if (expandedText !== undefined) return new Text(theme.fg("toolOutput", expandedText), 0, 0);
      const details = result.details as { resultCount?: number } | undefined;
      const count = details?.resultCount ?? 0;
      return new Text(theme.fg("success", `${count} result${count === 1 ? "" : "s"}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL through Firecrawl. Without instruction, returns cleaned requested formats. With instruction, asks the model configured at firecrawl-web.fetchModel in Pi settings to extract only relevant content and falls back to cleaned Markdown. Output is capped at 40,000 characters.",
    promptSnippet: "Fetch or focus-extract a web page through Firecrawl",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP(S) page URL." }),
      formats: Type.Optional(Type.Array(StringEnum(SCRAPE_FORMATS), { minItems: 1, maxItems: 4, description: "Formats; default markdown." })),
      onlyMainContent: Type.Optional(Type.Boolean({ description: "Exclude navigation and boilerplate; default true." })),
      instruction: Type.Optional(Type.String({ description: "Optional focused extraction instruction. This invokes a cheap authenticated text model." })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 40000, description: "Maximum returned characters; default 20,000 raw or 12,000 focused." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const formats = (params.formats ?? ["markdown"]) as FirecrawlScrapeFormat[];
      const instruction = params.instruction?.trim();
      const outputFormats = instruction && !formats.includes("markdown") ? ["markdown", ...formats] : formats;
      const requestFormats = [...new Set([
        ...outputFormats,
        ...(formats.includes("markdown") ? ["html"] : []),
      ])] as FirecrawlScrapeFormat[];
      const maxOutput = params.maxChars ?? (instruction ? 12000 : DEFAULT_FETCH_MAX_CHARS);
      onUpdate?.({ content: [{ type: "text", text: `Fetching: ${params.url}` }], details: {} });
      const result = await client().scrape({
        url: params.url,
        formats: requestFormats,
        onlyMainContent: params.onlyMainContent ?? true,
      }, signal);
      const defuddledMarkdown = result.html ? await cleanFirecrawlHtml(result.html, params.url) : undefined;
      const cleanedResult = defuddledMarkdown ? { ...result, markdown: defuddledMarkdown } : result;
      const cleaner = defuddledMarkdown ? "defuddle" : "firecrawl";
      const fallback = presentScrape(cleanedResult, params.url, outputFormats, maxOutput);
      if (!instruction || !cleanedResult.markdown) {
        return {
          content: [{ type: "text", text: fallback }],
          details: { provider: "firecrawl", cleaner, url: params.url, formats: outputFormats, metadata: result.metadata, warning: result.warning, focused: false },
        };
      }
      const extracted = await extractFirecrawlContent({
        registry: ctx.modelRegistry,
        url: params.url,
        markdown: cleanedResult.markdown,
        instruction,
        model: fetchModel(),
        maxOutput,
        signal,
      });
      return {
        content: [{ type: "text", text: truncateOutput(extracted?.text ?? fallback, maxOutput) }],
        details: {
          provider: "firecrawl",
          cleaner,
          url: params.url,
          formats: outputFormats,
          metadata: result.metadata,
          warning: result.warning,
          focused: Boolean(extracted),
          extractionModel: extracted?.model,
        },
        usage: extracted?.usage,
      };
    },
    renderCall(args, theme) {
      const suffix = args.instruction ? theme.fg("dim", " focused") : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("WebFetch "))}${theme.fg("accent", args.url)}${suffix}`, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      const expandedText = expandedToolText(result, expanded);
      if (expandedText !== undefined) return new Text(theme.fg("toolOutput", expandedText), 0, 0);
      const details = result.details as { focused?: boolean; metadata?: { statusCode?: number } } | undefined;
      const status = details?.metadata?.statusCode ? `HTTP ${details.metadata.statusCode}` : "fetched";
      return new Text(theme.fg("success", details?.focused ? `${status}, focused extraction` : status), 0, 0);
    },
  });

  pi.registerTool({
    name: "web_map",
    label: "Web Map",
    description: "Discover URLs on a site through Firecrawl. Returns a compact link list, capped at 20,000 characters.",
    promptSnippet: "Discover URLs on a site through Firecrawl",
    parameters: Type.Object({
      url: Type.String({ description: "Site URL." }),
      search: Type.Optional(Type.String({ description: "Optional term used to rank or filter discovered URLs." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum links; default 100." })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000, description: "Maximum returned characters; default 12,000." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Mapping: ${params.url}` }], details: {} });
      const result = await client().map({
        url: params.url,
        search: params.search,
        limit: params.limit ?? 100,
      }, signal);
      const body = result.links.map((link, index) => {
        const label = link.title?.trim() ? `${index + 1}. ${link.title.trim()}\n` : `${index + 1}. `;
        return `${label}${link.url}${link.description?.trim() ? `\n${compactSearchText(link.description, 600)}` : ""}`;
      }).join("\n\n");
      return {
        content: [{ type: "text", text: truncateOutput(body || `No URLs discovered for ${params.url}`, params.maxChars ?? DEFAULT_MAP_MAX_CHARS) }],
        details: { provider: "firecrawl", url: params.url, linkCount: result.links.length, links: result.links },
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("WebMap "))}${theme.fg("accent", args.url)}`, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Mapping..."), 0, 0);
      const expandedText = expandedToolText(result, expanded);
      if (expandedText !== undefined) return new Text(theme.fg("toolOutput", expandedText), 0, 0);
      const details = result.details as { linkCount?: number } | undefined;
      const count = details?.linkCount ?? 0;
      return new Text(theme.fg("success", `${count} link${count === 1 ? "" : "s"}`), 0, 0);
    },
  });

  pi.registerCommand("firecrawl", {
    description: "Show the Firecrawl web integration status",
    handler: async (_args, ctx) => {
      try {
        resolveApiKey();
        ctx.ui.notify(`Firecrawl ready: search, fetch, and map; fetch model: ${fetchModel()}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

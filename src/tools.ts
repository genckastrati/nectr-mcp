import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { describeError, type NectrClient, type Scan } from "./client.js";

/** Default cap on the markdown returned to a model: roughly 10k tokens. */
export const DEFAULT_MAX_CHARS = 40_000;
/** How many "only with JavaScript" blocks to list; nectr returns up to 50. */
export const JS_BLOCKS_SHOWN = 10;

export const MARKDOWN_CHOICES = ["full", "without_javascript", "none"] as const;
export type MarkdownChoice = (typeof MARKDOWN_CHOICES)[number];

const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: describeError(err) }],
  isError: true,
});

function size(scan: Scan): string[] {
  return [
    "## Size",
    `- The whole page as markdown (after JavaScript runs): ${plural(scan.rendered_words, "word")}, ≈ ${plural(scan.markdown_tokens, "token")}.`,
    `- The raw HTML an agent receives when it fetches the URL: ≈ ${plural(scan.html_tokens, "token")}.`,
    `- Without JavaScript: ${plural(scan.plain_words, "word")} as markdown.`,
  ];
}

function robots(scan: Scan): string[] {
  if (!scan.robots_found) {
    return ["## robots.txt", "The site has no robots.txt, so every crawler may fetch this page."];
  }
  return [
    "## robots.txt",
    ...scan.robots.map((r) => `- ${r.agent}: ${r.allowed ? "allowed" : "blocked"}`),
  ];
}

function pdfs(scan: Scan): string[] {
  if (scan.pdfs.length === 0 && scan.pdfs_not_checked === 0) return [];
  const lines = scan.pdfs.map((p) => {
    if (p.has_text === null) return `- ${p.url}: not checked${p.note ? ` (${p.note})` : ""}`;
    const facts = [
      p.pages !== null ? plural(p.pages, "page") : null,
      p.words !== null ? `${plural(p.words, "word")} in the first pages` : null,
      p.has_text ? "has text" : "no text layer (a scanned image; AI reads nothing)",
    ].filter(Boolean);
    return `- ${p.url}: ${facts.join(", ")}`;
  });
  if (scan.pdfs_not_checked > 0) {
    lines.push(
      `- ${plural(scan.pdfs_not_checked, "more linked PDF")} not checked (past the first 3, or on another site).`,
    );
  }
  return ["## Linked PDFs", ...lines];
}

function onlyWithJavaScript(scan: Scan): string[] {
  const blocks = scan.only_with_javascript;
  if (blocks.length === 0) {
    return ["## Only with JavaScript", "Nothing: an agent that doesn't run JavaScript gets the same text."];
  }
  const share = Math.round(scan.missing_word_share * 100);
  const shown = blocks.slice(0, JS_BLOCKS_SHOWN).map((b) => `- ${b.replace(/\s+/g, " ").trim()}`);
  const more = blocks.length > JS_BLOCKS_SHOWN ? [`- …and ${blocks.length - JS_BLOCKS_SHOWN} more.`] : [];
  return [
    "## Only with JavaScript",
    `${share}% of the page's words appear only after JavaScript runs, in ${plural(blocks.length, "block")}. ` +
      "An agent that doesn't run JavaScript misses them:",
    ...shown,
    ...more,
  ];
}

function markdown(scan: Scan, choice: MarkdownChoice, maxChars: number): string[] {
  if (choice === "none") return [];
  if (!scan.markdown_included) {
    return ["## Markdown", "nectr didn't include the markdown with this scan."];
  }
  const full = choice === "full";
  const body = (full ? scan.rendered_markdown : scan.plain_markdown) ?? "";
  const heading = full
    ? "## The page as markdown (after JavaScript runs)"
    : "## The page as markdown, without JavaScript";
  if (body.length <= maxChars) return [heading, body];
  return [
    heading,
    body.slice(0, maxChars),
    `[Truncated: showing ${maxChars.toLocaleString("en")} of ${body.length.toLocaleString("en")} characters. ` +
      "Call scan_page again with a larger max_chars for the rest.]",
  ];
}

// ── Handler (exported for tests) ────────────────────────────────────────────

export async function scanPage(
  client: NectrClient,
  args: { url: string; markdown?: MarkdownChoice; max_chars?: number },
): Promise<CallToolResult> {
  const choice = args.markdown ?? "full";
  const maxChars = Math.max(args.max_chars ?? DEFAULT_MAX_CHARS, 1_000);
  try {
    const scan = await client.scan(args.url);
    // Short findings first, the long markdown last: a body of 40,000
    // characters at the top would push the findings out of view.
    const sections = [
      [`# ${scan.title || scan.url}`, `url: ${scan.url} · scanned: ${scan.scanned_at}`],
      size(scan),
      robots(scan),
      pdfs(scan),
      onlyWithJavaScript(scan),
      markdown(scan, choice, maxChars),
    ].filter((s) => s.length > 0);
    return text(sections.map((s) => s.join("\n")).join("\n\n"));
  } catch (err) {
    return failure(err);
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerTools(server: McpServer, client: NectrClient): void {
  server.registerTool(
    "scan_page",
    {
      title: "Scan a page the way AI reads it",
      description:
        "Fetch one public web page with nectr and return how AI agents see it: the page as clean markdown, " +
        "its size in words and estimated tokens (against the raw HTML), which AI crawlers its robots.txt " +
        "allows, linked PDFs and whether they have text, and the text that only appears after JavaScript " +
        "runs. Nothing is stored. nectr honours the site's robots.txt for itself.",
      inputSchema: {
        url: z.url().describe("The http(s) address of a public web page."),
        markdown: z
          .enum(MARKDOWN_CHOICES)
          .optional()
          .describe(
            'Which markdown to include: "full" (after JavaScript runs, the default), ' +
              '"without_javascript" (what an agent that runs no JavaScript gets) or "none".',
          ),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .optional()
          .describe(`Truncate the markdown after this many characters (default ${DEFAULT_MAX_CHARS}).`),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => scanPage(client, args),
  );
}

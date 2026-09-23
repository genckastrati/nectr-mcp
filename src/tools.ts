import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { describeError, type NectrClient, type Page, type SavedPage } from "./client.js";

/** Default cap on a page body returned to a model: roughly 10k tokens. */
export const DEFAULT_MAX_CHARS = 40_000;
const SEARCH_MAX = 25;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: describeError(err) }],
  isError: true,
});

function titleOf(p: { title: string | null; custom_title?: string | null; url: string }): string {
  return p.custom_title || p.title || p.url;
}

function statusNote(status: string): string {
  if (status === "completed") return "";
  if (status === "unreadable") return " · UNREADABLE (login wall or placeholder; no content)";
  return ` · ${status.toUpperCase()} (no content)`;
}

/** Compare URLs the way a person would: scheme/host case, fragment and trailing slash ignored. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const p = new URL(u.trim());
      p.hash = "";
      return `${p.protocol}//${p.host}${p.pathname.replace(/\/+$/, "")}${p.search}`.toLowerCase();
    } catch {
      return u.trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

// ── Handlers (exported for tests) ───────────────────────────────────────────

export async function searchLibrary(
  client: NectrClient,
  args: { query?: string; limit?: number },
): Promise<CallToolResult> {
  const query = args.query?.trim() || undefined;
  const limit = Math.min(Math.max(args.limit ?? 10, 1), SEARCH_MAX);
  try {
    const list = await client.search(query, limit);
    if (list.items.length === 0) {
      return text(
        query
          ? `No saved pages match "${query}". Use convert_url to add one.`
          : "The library is empty. Use convert_url to add a page.",
      );
    }
    const heading = query
      ? `${list.items.length} of ${plural(list.total, "saved page")} matching "${query}":`
      : `${list.items.length} most recently refreshed of ${plural(list.total, "saved page")}:`;
    // Summaries and ids only. Bodies are fetched deliberately with get_page:
    // returning ten full pages here would flood the context on every search.
    const rows = list.items.map((p, i) =>
      [
        `${i + 1}. ${titleOf(p)}`,
        `   id: ${p.id}`,
        `   url: ${p.url}`,
        `   fetched: ${p.fetched_at} · ${plural(p.word_count, "word")}${statusNote(p.status)}`,
        ...(p.summary ? [`   summary: ${p.summary}`] : []),
      ].join("\n"),
    );
    return text(`${heading}\n\n${rows.join("\n\n")}\n\nRead one with get_page(id).`);
  } catch (err) {
    return failure(err);
  }
}

export async function getPage(
  client: NectrClient,
  args: { id?: string; url?: string; max_chars?: number },
): Promise<CallToolResult> {
  const maxChars = Math.max(args.max_chars ?? DEFAULT_MAX_CHARS, 1_000);
  try {
    let id = args.id?.trim();
    if (!id) {
      const url = args.url?.trim();
      if (!url) return failure(new Error("Pass either id or url."));
      // By id rather than by public link: a private page has no working
      // public link, but its owner's key can still read it by id.
      const term = url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      const list = await client.search(term, SEARCH_MAX);
      const hit = list.items.find((p) => sameUrl(p.url, url));
      if (!hit) {
        return text(`No saved page for ${url}. Save it first with convert_url.`);
      }
      id = hit.id;
    }

    const page: Page = await client.getPage(id);
    if (page.status !== "completed") {
      return text(
        `"${titleOf(page)}" (${page.url}) has no readable content${statusNote(page.status)}.`,
      );
    }
    const body = page.markdown_content;
    const meta = `id: ${page.id} · url: ${page.url} · fetched: ${page.fetched_at} · ${page.word_count} words`;
    if (body.length <= maxChars) return text(`${meta}\n\n${body}`);
    return text(
      `${meta}\n\n${body.slice(0, maxChars)}\n\n[Truncated: showing ${maxChars} of ${body.length} characters. ` +
        `Call get_page again with a larger max_chars for the rest.]`,
    );
  } catch (err) {
    return failure(err);
  }
}

export async function convertUrl(
  client: NectrClient,
  args: { url: string; project_id?: string; force_refresh?: boolean },
): Promise<CallToolResult> {
  try {
    const saved: SavedPage = await client.convert(args.url, args.force_refresh ?? false);
    let projectLine = "";
    if (args.project_id) {
      try {
        await client.assignProject(saved.id, args.project_id);
        projectLine = `\nAdded to project ${args.project_id}.`;
      } catch (err) {
        // The page IS saved; say so rather than reporting the whole call as failed.
        projectLine = `\nSaved, but could not add it to project ${args.project_id}: ${describeError(err)}`;
      }
    }
    const how = saved.cached ? "Already in the library (served the saved copy)" : "Saved";
    return text(
      `${how}: ${titleOf(saved)}\n` +
        `id: ${saved.id} · ${saved.word_count} words · fetched: ${saved.fetched_at}` +
        (saved.summary ? `\nsummary: ${saved.summary}` : "") +
        projectLine +
        `\n\nnectr keeps this page current on the plan's refresh schedule. Read it with get_page("${saved.id}").`,
    );
  } catch (err) {
    return failure(err);
  }
}

export async function listProjects(client: NectrClient): Promise<CallToolResult> {
  try {
    const [projects, me] = await Promise.all([client.listProjects(), client.me()]);
    if (projects.length === 0) return text("No projects yet. Projects are created in the nectr dashboard.");
    const rows = projects.map(
      (p) =>
        `- ${p.name} (${plural(p.conversion_count, "page")})\n` +
        `  id: ${p.id}\n` +
        `  llms.txt: ${client.siteUrl}/p/${me.link_hash}/${p.slug}/llms.txt`,
    );
    return text(
      `${plural(projects.length, "project")}:\n\n${rows.join("\n")}\n\n` +
        "Each llms.txt is public and lists only the project's shareable pages.",
    );
  } catch (err) {
    return failure(err);
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerTools(server: McpServer, client: NectrClient): void {
  server.registerTool(
    "search_library",
    {
      title: "Search the nectr library",
      description:
        "Search the user's saved nectr pages by title or URL. Returns ids, URLs, freshness and a " +
        "short summary per page, not the page bodies. Omit query to list the most recently refreshed pages.",
      inputSchema: {
        query: z.string().max(500).optional().describe("Words from the title or URL. Omit to list recent pages."),
        limit: z.number().int().min(1).max(SEARCH_MAX).optional().describe("Max results (default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => searchLibrary(client, args),
  );

  server.registerTool(
    "get_page",
    {
      title: "Read a saved page",
      description:
        "Get the clean markdown of one saved nectr page, by id (from search_library) or by its " +
        "original URL. Includes when it was last fetched. Works for private pages too.",
      inputSchema: {
        id: z.string().optional().describe("Page id from search_library or convert_url."),
        url: z.string().optional().describe("The page's original URL, if the id is not known."),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .optional()
          .describe(`Truncate the body after this many characters (default ${DEFAULT_MAX_CHARS}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => getPage(client, args),
  );

  server.registerTool(
    "convert_url",
    {
      title: "Save a page to nectr",
      description:
        "Convert a web page, PDF or DOCX to clean markdown and save it to the user's nectr library, " +
        "where it is re-crawled automatically to stay current. Returns the new page's id and summary. " +
        "Counts against the user's monthly conversion quota unless the page is already saved.",
      inputSchema: {
        url: z.url().describe("The http(s) URL to save."),
        project_id: z.string().optional().describe("Optional project id (from list_projects) to file it under."),
        force_refresh: z
          .boolean()
          .optional()
          .describe("Re-crawl now even if the page is already saved (counts against the quota)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => convertUrl(client, args),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List nectr projects",
      description: "List the user's nectr projects with their page counts and public llms.txt URLs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => listProjects(client),
  );
}

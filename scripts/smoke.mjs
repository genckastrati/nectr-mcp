#!/usr/bin/env node
/**
 * Checks before publishing: starts the built server (dist/index.js) over stdio
 * as a real MCP client does, calls its tools against nectr with your key, and
 * prints PASS, SKIP or FAIL for each check. Exits 1 if anything failed.
 *
 *   npm run build
 *   NECTR_API_KEY=nct_... npm run smoke
 *
 * Optional:
 *   NECTR_URL           another nectr (default https://nectr.ch)
 *   NECTR_SMOKE_PAGE    a page on one of your verified sites, ideally with a
 *                       table and structured data (default: the first page
 *                       list_sites shows on a verified, running site)
 *   NECTR_SMOKE_FOREIGN a page that isn't yours and declares structured data
 *
 * It runs four or five scans, well under nectr's 10 a minute.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FOREIGN = process.env.NECTR_SMOKE_FOREIGN || "https://www.bbcgoodfood.com/recipes/easy-pancakes";
const NOTHING_DECLARED = "https://example.com/";

let failed = 0;
const pass = (name, note = "") => console.log(`PASS  ${name}${note ? ` (${note})` : ""}`);
const skip = (name, why) => console.log(`SKIP  ${name}: ${why}`);
const fail = (name, why) => {
  failed++;
  console.log(`FAIL  ${name}: ${why}`);
};
function check(name, problems, note) {
  const found = problems.filter(Boolean);
  if (found.length === 0) pass(name, note);
  else fail(name, found.join("; "));
}
const has = (out, s) => (out.includes(s) ? null : `missing ${JSON.stringify(s)}`);
const hasNot = (out, s) => (out.includes(s) ? `unexpected ${JSON.stringify(s)}` : null);

if (!existsSync(SERVER)) {
  console.error("dist/index.js not found: run `npm run build` first.");
  process.exit(2);
}
if (!process.env.NECTR_API_KEY) {
  console.error("Set NECTR_API_KEY to one of your nct_ keys (nectr → Settings → API keys).");
  process.exit(2);
}

// Without a key the server must refuse to start, and say why.
{
  const env = { ...process.env };
  delete env.NECTR_API_KEY;
  const r = spawnSync(process.execPath, [SERVER], { env, encoding: "utf8", timeout: 15_000 });
  check("no key: refuses to start", [
    r.status === 0 ? "exited 0" : null,
    has(`${r.stderr}${r.stdout}`, "NECTR_API_KEY is not set"),
  ]);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: {
    NECTR_API_KEY: process.env.NECTR_API_KEY,
    ...(process.env.NECTR_URL ? { NECTR_URL: process.env.NECTR_URL } : {}),
    PATH: process.env.PATH ?? "",
  },
  stderr: "inherit",
});
const client = new Client({ name: "nectr-mcp-smoke", version: "1" });
await client.connect(transport);

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return { error: result.isError === true, out: result.content?.[0]?.text ?? "" };
}

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).join(", ");
  check("tools/list: scan_page and list_sites, read-only", [
    names === "scan_page, list_sites" ? null : `got ${names}`,
    tools.every((t) => t.annotations?.readOnlyHint === true) ? null : "a tool isn't marked read-only",
  ]);

  // list_sites, and a page to use as "yours".
  const sites = await call("list_sites");
  const datasetLines = (sites.out.match(/^Published datasets \((\d+)\):/gm) ?? []).length;
  check("list_sites", [sites.error ? sites.out : null], `${(sites.out.match(/^## /gm) ?? []).length} sites, ${datasetLines} with published datasets`);
  if (sites.error) {
    // nectr runs a scan sent with a rejected key as an anonymous one, so the
    // scan checks below would only test the anonymous answer. Stop here.
    console.log("      Stopping: fix the key (or NECTR_URL) first; the scan checks need a working key.");
    process.exitCode = 1;
    throw new Error("stop");
  }

  let own = process.env.NECTR_SMOKE_PAGE;
  if (!own) {
    for (const section of sites.out.split("\n## ").slice(1)) {
      const [, state = "", ...rest] = section.split("\n");
      if (!state.startsWith("verified ·")) continue; // unverified, or paused
      const pages = rest.slice(rest.indexOf("Pages:") + 1);
      const m = pages.map((l) => l.match(/^- (https?:\/\/\S+?)(?::\s|$)/)).find(Boolean);
      if (m) {
        own = m[1];
        break;
      }
    }
  }

  if (!own) {
    skip("your page", "no verified, running site with pages; set NECTR_SMOKE_PAGE");
  } else {
    console.log(`      your page: ${own}`);
    const full = await call("scan_page", { url: own, markdown: "full" });
    if (full.error) {
      fail("your page, markdown=full", full.out);
    } else {
      check("your page, markdown=full: the markdown is included", [
        has(full.out, "## The page as markdown (after JavaScript runs)"),
        hasNot(full.out, "Not included: nectr only returns the markdown"),
      ]);
      if (full.out.includes("## Tables")) {
        check("your page: the tables' rows are in the markdown", [has(full.out, "Their rows are in the markdown below.")]);
      } else skip("your page: tables", "the page has none; set NECTR_SMOKE_PAGE to a page with a <table>");
      const json = full.out.split("## Structured data as JSON\n")[1];
      if (json !== undefined) {
        let parsed = null;
        try {
          parsed = JSON.parse(json.split("\n[Truncated:")[0]);
        } catch {}
        check("your page: the structured data comes last, as valid JSON", [
          parsed ? null : "the JSON section doesn't parse",
          has(full.out, "The data itself is at the end, as JSON."),
        ]);
      } else skip("your page: structured data as JSON", "the page declares none");

      const none = await call("scan_page", { url: own, markdown: "none" });
      check("your page, markdown=none: no markdown", [
        none.error ? none.out : null,
        hasNot(none.out, "## The page as markdown"),
        full.out.includes("## Tables") ? has(none.out, 'For their rows, call scan_page with markdown "full".') : null,
      ]);

      const jsonLength = json === undefined ? 0 : json.length;
      if (jsonLength > 1_100) {
        const small = await call("scan_page", { url: own, markdown: "none", max_chars: 1000 });
        check("your page, max_chars=1000: the JSON is cut and says so", [
          small.error ? small.out : null,
          has(small.out, "[Truncated: showing 1,000 of"),
        ]);
      } else skip("max_chars=1000", "your page's structured data is shorter than that");
    }
  }

  const empty = await call("scan_page", { url: NOTHING_DECLARED });
  check(`${NOTHING_DECLARED}: declares nothing, no tables, no markdown (not yours)`, [
    empty.error ? empty.out : null,
    has(empty.out, "None: the page declares no JSON-LD, microdata or schema.org RDFa"),
    hasNot(empty.out, "## Tables"),
    has(empty.out, "Not included: nectr only returns the markdown"),
  ]);

  const foreign = await call("scan_page", { url: FOREIGN });
  if (foreign.error) {
    fail(`${FOREIGN}: not yours`, foreign.out);
  } else if (!foreign.out.includes("## Structured data\nWhat the page declares")) {
    skip(`${FOREIGN}: not yours`, "it declared nothing this time; set NECTR_SMOKE_FOREIGN");
  } else {
    check(`${FOREIGN}: the kinds, but none of the content`, [
      has(foreign.out, "The data itself is only for pages on the user's own verified sites (see list_sites)."),
      hasNot(foreign.out, "## Structured data as JSON"),
      hasNot(foreign.out, "## The page as markdown"),
    ]);
  }
} catch (err) {
  if (!(err instanceof Error && err.message === "stop")) throw err;
} finally {
  await client.close();
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

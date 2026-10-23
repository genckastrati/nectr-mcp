import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_CHARS, JS_BLOCKS_SHOWN, scanPage } from "../src/tools.js";
import { fakeApi, json, scanResult } from "./fake-api.js";

const URL_ = "https://example.com/pricing";

async function scanned(overrides: Record<string, unknown> = {}, args: Record<string, unknown> = {}) {
  const { client } = fakeApi({ "POST /scans": () => json(200, scanResult(overrides)) });
  const result = await scanPage(client, { url: URL_, ...args });
  return { result, out: (result.content[0] as { text: string }).text };
}

describe("scan_page", () => {
  it("leads with the findings and ends with the whole page as markdown", async () => {
    const { result, out } = await scanned();
    expect(result.isError).toBeUndefined();
    const order = ["# Pricing", "## Size", "## robots.txt", "## Only with JavaScript", "## The page as markdown"];
    const at = order.map((h) => out.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out.trimEnd().endsWith("Plans start at 9 a month.")).toBe(true);
  });

  it("gives the size in words and tokens, against the raw HTML", async () => {
    const { out } = await scanned();
    expect(out).toContain("420 words, ≈ 610 tokens");
    expect(out).toContain("raw HTML an agent receives when it fetches the URL: ≈ 18,400 tokens");
    expect(out).toContain("Without JavaScript: 12 words");
  });

  it("says which AI crawlers robots.txt allows", async () => {
    const { out } = await scanned();
    expect(out).toContain("- GPTBot: blocked");
    expect(out).toContain("- ClaudeBot: allowed");
  });

  it("says a missing robots.txt allows every crawler", async () => {
    const { out } = await scanned({ robots_found: false, robots: [] });
    expect(out).toContain("no robots.txt, so every crawler may fetch this page");
  });

  it("lists what only appears with JavaScript, and its share", async () => {
    const { out } = await scanned();
    expect(out).toContain("97% of the page's words appear only after JavaScript runs, in 2 blocks");
    expect(out).toContain("- Compare every plan side by side.");
  });

  it("caps the JavaScript-only blocks and says how many more there are", async () => {
    const blocks = Array.from({ length: JS_BLOCKS_SHOWN + 5 }, (_, i) => `Block number ${i}`);
    const { out } = await scanned({ only_with_javascript: blocks });
    expect(out).toContain(`- Block number ${JS_BLOCKS_SHOWN - 1}`);
    expect(out).not.toContain(`- Block number ${JS_BLOCKS_SHOWN}\n`);
    expect(out).toContain("…and 5 more.");
  });

  it("says when nothing depends on JavaScript", async () => {
    const { out } = await scanned({ only_with_javascript: [], missing_word_share: 0 });
    expect(out).toContain("Nothing: an agent that doesn't run JavaScript gets the same text.");
  });

  it("reports linked PDFs, including a scanned image with no text", async () => {
    const { out } = await scanned({
      pdfs: [
        { url: "https://example.com/menu.pdf", pages: 2, words: 310, has_text: true, note: null },
        { url: "https://example.com/scan.pdf", pages: 4, words: 0, has_text: false, note: null },
        { url: "https://example.com/big.pdf", pages: null, words: null, has_text: null, note: "nectr was busy" },
      ],
      pdfs_not_checked: 2,
    });
    expect(out).toContain("- https://example.com/menu.pdf: 2 pages, 310 words in the first pages, has text");
    expect(out).toContain("- https://example.com/scan.pdf: 4 pages, 0 words in the first pages, no text layer");
    expect(out).toContain("- https://example.com/big.pdf: not checked (nectr was busy)");
    expect(out).toContain("2 more linked PDFs not checked");
  });

  it("leaves out the PDF section when the page links none", async () => {
    const { out } = await scanned();
    expect(out).not.toContain("## Linked PDFs");
  });

  it("can return the markdown without JavaScript instead, or none", async () => {
    const plain = (await scanned({}, { markdown: "without_javascript" })).out;
    expect(plain).toContain("## The page as markdown, without JavaScript\n# Pricing\n\nLoading…");
    const none = (await scanned({}, { markdown: "none" })).out;
    expect(none).not.toContain("## The page as markdown");
    expect(none).toContain("## robots.txt");
  });

  it("truncates a long page and says how to get the rest", async () => {
    const body = "x".repeat(DEFAULT_MAX_CHARS + 500);
    const { out } = await scanned({ rendered_markdown: body });
    expect(out).toContain(`showing 40,000 of ${(DEFAULT_MAX_CHARS + 500).toLocaleString("en")} characters`);
    expect(out).toContain("larger max_chars");
    const wider = (await scanned({ rendered_markdown: body }, { max_chars: DEFAULT_MAX_CHARS + 500 })).out;
    expect(wider).not.toContain("Truncated");
  });

  it("says so when nectr sent no markdown", async () => {
    const { out } = await scanned({ markdown_included: false, rendered_markdown: null, plain_markdown: null });
    expect(out).toContain("nectr didn't include the markdown with this scan.");
  });

  it("falls back to the URL when the page has no title", async () => {
    const { out } = await scanned({ title: null });
    expect(out.startsWith(`# ${URL_}`)).toBe(true);
  });

  it("surfaces a robots.txt refusal as an error not to retry", async () => {
    const { client } = fakeApi({
      "POST /scans": () => json(403, { detail: "This site's robots.txt asks Nectrbot not to fetch this page." }),
    });
    const result = await scanPage(client, { url: URL_ });
    expect(result.isError).toBe(true);
    const out = (result.content[0] as { text: string }).text;
    expect(out).toContain("robots.txt asks Nectrbot");
    expect(out).toContain("Do not retry");
  });
});

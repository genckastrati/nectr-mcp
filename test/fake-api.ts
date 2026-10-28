import { NectrClient } from "../src/client.js";

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const SITE = "https://nectr.test";
export const KEY = "nct_testkey";

/**
 * A fake nectr API. Routes are keyed "METHOD /path" with the query string
 * stripped, so a test states only what it cares about; every call is recorded
 * so a test can assert on what was actually sent.
 */
export function fakeApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api\/v1/, "") + url.search,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path.split("?")[0]}`];
    if (!route) return json(404, { detail: "Not Found" });
    return route(call);
  }) as typeof fetch;
  return { client: new NectrClient(KEY, SITE, fetchImpl), calls };
}

/** A scan as nectr returns it to a key holder, with sensible defaults. */
export function scanResult(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/pricing",
    title: "Pricing",
    rendered_words: 420,
    plain_words: 12,
    rendered_markdown: "# Pricing\n\nPlans start at 9 a month.",
    plain_markdown: "# Pricing\n\nLoading…",
    markdown_tokens: 610,
    html_tokens: 18_400,
    only_with_javascript: ["Plans start at 9 a month.", "Compare every plan side by side."],
    missing_word_share: 0.97,
    robots_found: true,
    robots: [
      { agent: "GPTBot", allowed: false },
      { agent: "ClaudeBot", allowed: true },
    ],
    pdfs: [],
    pdfs_not_checked: 0,
    scanned_at: "2026-10-23T20:00:00Z",
    markdown_included: true,
    ...overrides,
  };
}

/** A site as `GET /sites` returns it, trimmed to a realistic subset of its fields. */
export function siteResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-1",
    domain: "example.com",
    verified: true,
    verified_at: "2026-10-10T20:38:03Z",
    paused_at: null,
    record_name: "_nectr.example.com",
    record_value: "nectr-verify=secretish",
    pages_linked: 2,
    pages_copied: 2,
    llms_txt_url: "https://nectr.test/s/example.com/llms.txt",
    ...overrides,
  };
}

/** A page as `GET /sites/{id}/pages` returns it. */
export function pageResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "page-1",
    url: "https://example.com/",
    copy_url: "https://nectr.test/s/example.com/index.md",
    title: "Home",
    status: "copied",
    reason: null,
    words: 1303,
    tokens: 1191,
    html_tokens: 192_436,
    ...overrides,
  };
}

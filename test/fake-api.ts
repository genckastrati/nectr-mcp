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

export function page(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    url: "https://example.com/docs/intro",
    title: "Intro",
    custom_title: null,
    markdown_content: "# Intro\n\nThe body of the page.",
    summary: "An introduction to the docs.",
    word_count: 6,
    status: "completed",
    fetched_at: "2026-09-22T10:00:00Z",
    ...overrides,
  };
}

import { describe, expect, it } from "vitest";

import { convertUrl, getPage, listProjects, sameUrl, searchLibrary } from "../src/tools.js";
import { fakeApi, json, page, SITE } from "./fake-api.js";

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");

const listOf = (...items: unknown[]) => () =>
  json(200, { items, total: items.length, page: 1, limit: 10 });

describe("search_library", () => {
  it("returns ids and summaries, never page bodies", async () => {
    const { client } = fakeApi({
      "GET /conversions": listOf(page({ markdown_content: "SECRET BODY TEXT" })),
    });
    const out = textOf(await searchLibrary(client, { query: "intro" }));
    expect(out).toContain("11111111-1111-1111-1111-111111111111");
    expect(out).toContain("An introduction to the docs.");
    expect(out).not.toContain("SECRET BODY TEXT");
  });

  it("prefers the owner's custom title", async () => {
    const { client } = fakeApi({ "GET /conversions": listOf(page({ custom_title: "My name" })) });
    expect(textOf(await searchLibrary(client, {}))).toContain("1. My name");
  });

  it("flags pages that have no content", async () => {
    const { client } = fakeApi({ "GET /conversions": listOf(page({ status: "unreadable" })) });
    expect(textOf(await searchLibrary(client, {}))).toContain("UNREADABLE");
  });

  it("points at convert_url when nothing matches", async () => {
    const { client } = fakeApi({ "GET /conversions": listOf() });
    expect(textOf(await searchLibrary(client, { query: "nope" }))).toContain("convert_url");
  });

  it("clamps an oversized limit", async () => {
    const { client, calls } = fakeApi({ "GET /conversions": listOf() });
    await searchLibrary(client, { limit: 500 });
    expect(calls[0]!.path).toContain("limit=25");
  });
});

describe("get_page", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  it("reads by id with its freshness", async () => {
    const { client } = fakeApi({ [`GET /conversions/${id}`]: () => json(200, page()) });
    const out = textOf(await getPage(client, { id }));
    expect(out).toContain("fetched: 2026-09-22T10:00:00Z");
    expect(out).toContain("The body of the page.");
  });

  it("resolves a URL to the exact saved page, not a near miss", async () => {
    const near = page({ id: "near", url: "https://example.com/docs/intro-v2" });
    const exact = page({ url: "https://example.com/docs/intro/" });
    const { client, calls } = fakeApi({
      "GET /conversions": listOf(near, exact),
      [`GET /conversions/${id}`]: () => json(200, page()),
    });
    await getPage(client, { url: "https://EXAMPLE.com/docs/intro" });
    expect(calls.at(-1)!.path).toBe(`/conversions/${id}`);
  });

  it("says when a URL is not in the library", async () => {
    const { client } = fakeApi({ "GET /conversions": listOf() });
    expect(textOf(await getPage(client, { url: "https://unknown.example" }))).toContain("convert_url");
  });

  it("truncates a long body and says how to get the rest", async () => {
    const body = "~".repeat(5_000); // a character the metadata line cannot contain
    const { client } = fakeApi({
      [`GET /conversions/${id}`]: () => json(200, page({ markdown_content: body })),
    });
    const out = textOf(await getPage(client, { id, max_chars: 1_000 }));
    expect(out).toContain("Truncated: showing 1000 of 5000 characters");
    expect(out.match(/~/g)!.length).toBe(1_000);
  });

  it("does not present an unreadable page as content", async () => {
    const { client } = fakeApi({
      [`GET /conversions/${id}`]: () => json(200, page({ status: "unreadable", markdown_content: "" })),
    });
    expect(textOf(await getPage(client, { id }))).toContain("no readable content");
  });

  it("requires an id or a url", async () => {
    const { client } = fakeApi({});
    expect((await getPage(client, {})).isError).toBe(true);
  });
});

describe("convert_url", () => {
  const saved = {
    id: "22222222-2222-2222-2222-222222222222",
    url: "https://example.com/new",
    title: "New page",
    summary: "What it is.",
    word_count: 300,
    status: "completed",
    fetched_at: "2026-09-23T09:00:00Z",
    cached: false,
  };

  it("saves the page and files it under a project", async () => {
    const { client, calls } = fakeApi({
      "POST /conversions": () => json(200, saved),
      [`PATCH /conversions/${saved.id}/project`]: () => new Response(null, { status: 204 }),
    });
    const out = textOf(await convertUrl(client, { url: saved.url, project_id: "p1" }));
    expect(calls[0]!.body).toEqual({ url: saved.url, force_refresh: false });
    expect(calls[1]!.body).toEqual({ project_id: "p1" });
    expect(out).toContain("Saved: New page");
    expect(out).toContain("Added to project p1");
  });

  it("still reports the save when filing it under the project fails", async () => {
    const { client } = fakeApi({ "POST /conversions": () => json(200, saved) });
    const result = await convertUrl(client, { url: saved.url, project_id: "missing" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Saved, but could not add it to project missing");
  });

  it("surfaces nectr's reason for an unreadable page as an error", async () => {
    const reason = "This page appears to require signing in, so it could not be read.";
    const { client } = fakeApi({ "POST /conversions": () => json(422, { detail: reason }) });
    const result = await convertUrl(client, { url: "https://intranet.example" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(reason);
  });

  it("tells the model not to retry when over quota", async () => {
    const { client } = fakeApi({
      "POST /conversions": () => json(402, { detail: "Monthly conversion limit reached (100/mo)." }),
    });
    expect(textOf(await convertUrl(client, { url: saved.url }))).toContain("Do not retry");
  });
});

describe("list_projects", () => {
  it("builds each project's public llms.txt URL", async () => {
    const { client } = fakeApi({
      "GET /projects": () => json(200, [{ id: "p1", name: "Docs", slug: "docs", conversion_count: 4 }]),
      "GET /auth/me": () => json(200, { link_hash: "abc123" }),
    });
    const out = textOf(await listProjects(client));
    expect(out).toContain(`${SITE}/p/abc123/docs/llms.txt`);
    expect(out).toContain("1 project:");
  });
});

describe("sameUrl", () => {
  it.each([
    ["https://example.com/a/", "https://EXAMPLE.com/a", true],
    ["https://example.com/a#top", "https://example.com/a", true],
    ["https://example.com/a", "https://example.com/ab", false],
    ["https://example.com/a?x=1", "https://example.com/a", false],
  ])("%s vs %s → %s", (a, b, expected) => {
    expect(sameUrl(a, b)).toBe(expected);
  });
});

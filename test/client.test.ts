import { describe, expect, it } from "vitest";

import { describeError, NectrApiError, NectrClient, NectrUnreachableError } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { fakeApi, json, KEY, SITE } from "./fake-api.js";

describe("NectrClient", () => {
  it("authenticates every request with the API key", async () => {
    const { client, calls } = fakeApi({ "GET /projects": () => json(200, []) });
    await client.listProjects();
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers["user-agent"]).toMatch(/^nectr-mcp\//);
  });

  it("sends the search term and limit as query parameters", async () => {
    const { client, calls } = fakeApi({
      "GET /conversions": () => json(200, { items: [], total: 0, page: 1, limit: 5 }),
    });
    await client.search("pricing page", 5);
    const sent = new URL(`${SITE}${calls[0]!.path}`).searchParams;
    expect(sent.get("search")).toBe("pricing page");
    expect(sent.get("limit")).toBe("5");
  });

  it("omits the search parameter when there is no query", async () => {
    const { client, calls } = fakeApi({
      "GET /conversions": () => json(200, { items: [], total: 0, page: 1, limit: 10 }),
    });
    await client.search(undefined, 10);
    expect(calls[0]!.path).not.toContain("search=");
  });

  it("carries status, detail and Retry-After on an API error", async () => {
    const { client } = fakeApi({
      "GET /projects": () => json(429, { detail: "Too many requests" }, { "retry-after": "12" }),
    });
    const err = await client.listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(NectrApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(12);
  });

  it("flattens FastAPI validation errors into one message", async () => {
    const { client } = fakeApi({
      "POST /conversions": () =>
        json(422, { detail: [{ msg: "Invalid URL" }, { msg: "Field required" }] }),
    });
    const err = await client.convert("x", false).catch((e) => e);
    expect(err.detail).toBe("Invalid URL; Field required");
  });

  it("survives a non-JSON error page from a proxy", async () => {
    const { client } = fakeApi({
      "GET /projects": () => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    });
    const err = await client.listProjects().catch((e) => e);
    expect(err.detail).toBe("Bad Gateway");
  });

  it("reports an unreachable server as such, not as an API error", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new NectrClient(KEY, SITE, failing);
    await expect(client.listProjects()).rejects.toBeInstanceOf(NectrUnreachableError);
  });
});

describe("describeError", () => {
  // The contract that matters to a model is whether to retry. An opaque
  // failure gets retried, which for a quota or a revoked key only burns the
  // caller's rate limit.
  it.each([
    [401, "rejected", /Do not retry/],
    [402, "Monthly conversion limit reached (100/mo).", /Do not retry/],
  ])("tells the model not to retry a %i", (status, detail, expected) => {
    expect(describeError(new NectrApiError(status, detail))).toMatch(expected);
  });

  it("says how long to wait when rate limited", () => {
    expect(describeError(new NectrApiError(429, "x", 30))).toContain("Wait 30 seconds");
  });

  it("says a busy converter is transient", () => {
    expect(describeError(new NectrApiError(503, "busy", 5))).toContain("Retry in 5 seconds");
  });

  it("passes nectr's reason through for an unconvertible page", () => {
    const reason = "This page appears to require signing in, so it could not be read.";
    expect(describeError(new NectrApiError(422, reason))).toContain(reason);
  });
});

describe("loadConfig", () => {
  it("requires a key, and says where to get one", () => {
    expect(() => loadConfig({})).toThrow(/Settings → API keys/);
  });

  it("rejects something that is not a nectr key", () => {
    expect(() => loadConfig({ NECTR_API_KEY: "sk-123" })).toThrow(/nct_/);
  });

  it("defaults to nectr.ch and trims a trailing slash from an override", () => {
    expect(loadConfig({ NECTR_API_KEY: "nct_x" }).siteUrl).toBe("https://nectr.ch");
    expect(loadConfig({ NECTR_API_KEY: "nct_x", NECTR_URL: "http://localhost:3000/" }).siteUrl).toBe(
      "http://localhost:3000",
    );
  });
});

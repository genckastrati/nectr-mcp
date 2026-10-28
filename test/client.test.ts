import { describe, expect, it } from "vitest";

import {
  describeError,
  NectrApiError,
  NectrClient,
  NectrRedirectError,
  NectrUnreachableError,
} from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { fakeApi, json, KEY, SITE, scanResult } from "./fake-api.js";

describe("NectrClient", () => {
  it("authenticates every request with the API key", async () => {
    const { client, calls } = fakeApi({ "POST /scans": () => json(200, scanResult()) });
    await client.scan("https://example.com/pricing");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers["user-agent"]).toBe("nectr-mcp/0.4.1");
  });

  it("reads the key holder's sites and a site's pages", async () => {
    const { client, calls } = fakeApi({
      "GET /sites": () => json(200, [{ id: "a b" }]),
      "GET /sites/a%20b/pages": () => json(200, []),
    });
    await client.sites();
    await client.pages("a b");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /sites", "GET /sites/a%20b/pages"]);
    expect(calls.every((c) => c.headers.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  // fetch drops the Authorization header when it follows a redirect to another
  // origin, so a followed redirect would turn into a keyless request.
  it("refuses to follow a redirect", async () => {
    let redirect: RequestRedirect | undefined;
    const fetchImpl = (async (_: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, { status: 308, headers: { location: "https://nectr.ch/api/v1/scans" } });
    }) as unknown as typeof fetch;
    const client = new NectrClient(KEY, "http://nectr.ch", fetchImpl);
    const err = await client.scan("https://example.com").catch((e: unknown) => e);
    expect(redirect).toBe("manual");
    expect(err).toBeInstanceOf(NectrRedirectError);
    const said = describeError(err);
    expect(said).toContain("redirected to https://nectr.ch/api/v1/scans");
    expect(said).toContain("NECTR_URL");
    expect(said).toContain("Do not retry");
  });

  it("asks for a scan of the URL and nothing else", async () => {
    const { client, calls } = fakeApi({ "POST /scans": () => json(200, scanResult()) });
    const scan = await client.scan("https://example.com/pricing");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/scans");
    expect(calls[0]!.body).toEqual({ url: "https://example.com/pricing" });
    expect(scan.title).toBe("Pricing");
  });

  it("carries status, detail and Retry-After on an API error", async () => {
    const { client } = fakeApi({
      "POST /scans": () => json(429, { detail: "Too many requests" }, { "retry-after": "12" }),
    });
    const err = await client.scan("https://example.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NectrApiError);
    expect((err as NectrApiError).status).toBe(429);
    expect((err as NectrApiError).retryAfterSeconds).toBe(12);
  });

  it("flattens FastAPI validation errors into one message", async () => {
    const { client } = fakeApi({
      "POST /scans": () => json(422, { detail: [{ msg: "Invalid URL" }, { msg: "Field required" }] }),
    });
    const err = (await client.scan("x").catch((e: unknown) => e)) as NectrApiError;
    expect(err.detail).toBe("Invalid URL; Field required");
  });

  it("survives a non-JSON error page from a proxy", async () => {
    const { client } = fakeApi({
      "POST /scans": () => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    });
    const err = (await client.scan("https://example.com").catch((e: unknown) => e)) as NectrApiError;
    expect(err.detail).toBe("Bad Gateway");
  });

  it("reports an unreachable server as such, not as an API error", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new NectrClient(KEY, SITE, failing);
    await expect(client.scan("https://example.com")).rejects.toBeInstanceOf(NectrUnreachableError);
  });
});

describe("describeError", () => {
  // The contract that matters to a model is whether to retry. An opaque
  // failure gets retried, which for a revoked key or a robots.txt refusal only
  // burns the caller's rate limit.
  it.each([
    [401, "rejected"],
    [403, "This site's robots.txt asks Nectrbot not to fetch this page."],
  ])("tells the model not to retry a %i", (status, detail) => {
    expect(describeError(new NectrApiError(status, detail))).toMatch(/Do not retry/);
  });

  it("passes nectr's reason through for a refused or unscannable page", () => {
    const robots = "This site's robots.txt asks Nectrbot not to fetch this page.";
    expect(describeError(new NectrApiError(403, robots))).toContain(robots);
    const reason = "The page answered HTTP 404.";
    expect(describeError(new NectrApiError(422, reason))).toContain(reason);
  });

  it("says how long to wait when rate limited", () => {
    expect(describeError(new NectrApiError(429, "x", 30))).toContain("Wait 30 seconds");
  });

  it("says a busy scanner is transient", () => {
    expect(describeError(new NectrApiError(503, "busy", 5))).toContain("Retry in 5 seconds");
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { fakeApi, json, pageResult, scanResult, siteResult } from "./fake-api.js";

/** Drive the server through a real MCP client, as an MCP host would. */
async function connect(routes: Parameters<typeof fakeApi>[0]) {
  const { client: api, calls } = fakeApi(routes);
  const server = createServer(api);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls };
}

describe("MCP server", () => {
  it("exposes scan_page and list_sites, and neither writes anything", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["scan_page", "list_sites"]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint ?? false).toBe(false);
    }
  });

  it("lists sites end to end", async () => {
    const { client } = await connect({
      "GET /sites": () => json(200, [siteResult()]),
      "GET /sites/site-1/pages": () => json(200, [pageResult()]),
    });
    const result = await client.callTool({ name: "list_sites", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("## example.com");
    expect(text).toContain("- https://example.com/");
  });

  it("answers a tool call end to end", async () => {
    const { client } = await connect({ "POST /scans": () => json(200, scanResult()) });
    const result = await client.callTool({ name: "scan_page", arguments: { url: "https://example.com/pricing" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("# Pricing");
    expect(text).toContain("- GPTBot: blocked");
  });

  it("rejects a malformed URL before calling nectr", async () => {
    const { client, calls } = await connect({});
    const result = await client.callTool({ name: "scan_page", arguments: { url: "not a url" } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown markdown choice before calling nectr", async () => {
    const { client, calls } = await connect({});
    const result = await client.callTool({
      name: "scan_page",
      arguments: { url: "https://example.com", markdown: "everything" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

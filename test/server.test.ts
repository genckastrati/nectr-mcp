import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { fakeApi, json, page } from "./fake-api.js";

/** Drive the server through a real MCP client, as an MCP host would. */
async function connect(routes: Parameters<typeof fakeApi>[0]) {
  const { client: api } = fakeApi(routes);
  const server = createServer(api);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("MCP server", () => {
  it("exposes the four v1 tools and nothing destructive", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "convert_url",
      "get_page",
      "list_projects",
      "search_library",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.destructiveHint ?? false).toBe(false);
    }
    // Only convert_url writes; everything else must advertise itself as read-only.
    const writers = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
    expect(writers).toEqual(["convert_url"]);
  });

  it("answers a tool call end to end", async () => {
    const client = await connect({
      "GET /conversions": () => json(200, { items: [page()], total: 1, page: 1, limit: 10 }),
    });
    const result = await client.callTool({ name: "search_library", arguments: { query: "intro" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("1. Intro");
  });

  it("rejects a malformed URL before calling nectr", async () => {
    const client = await connect({});
    const result = await client.callTool({ name: "convert_url", arguments: { url: "not a url" } });
    expect(result.isError).toBe(true);
  });
});

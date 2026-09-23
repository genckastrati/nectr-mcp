#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { NectrClient } from "./client.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  // stdout is the MCP channel; anything meant for a person goes to stderr.
  console.error(`nectr-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const server = createServer(new NectrClient(config.apiKey, config.siteUrl));
await server.connect(new StdioServerTransport());

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { NectrClient } from "./client.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.1.0";

export function createServer(client: NectrClient): McpServer {
  const server = new McpServer({ name: "nectr", version: VERSION });
  registerTools(server, client);
  return server;
}

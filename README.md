# nectr-mcp

An [MCP](https://modelcontextprotocol.io) server for [nectr](https://nectr.ch), the markdown library for your LLMs.

It lets a model **search** your library, **read** any saved page as clean markdown, **save** new pages, and **list** your projects. You don't need to paste links into the chat.

- **Search:** a model can't guess your permalinks, but it can call `search_library("pricing page")`.
- **Private pages:** pages you haven't shared have no working public link, but your key can still read them.
- **Saving:** "save these docs and keep them current" becomes one step, and nectr re-crawls them on your plan's schedule.
- **Freshness:** every read says when the page was last fetched.

## Setup

1. In nectr, open **Settings → API keys** and create a key. It starts with `nct_`.
2. Add the server to your MCP client's configuration. Most desktop and editor clients use an `mcpServers` block like this:

```json
{
  "mcpServers": {
    "nectr": {
      "command": "npx",
      "args": ["-y", "nectr-mcp"],
      "env": {
        "NECTR_API_KEY": "nct_your_key_here"
      }
    }
  }
}
```

3. Restart the client. The four tools below should appear.

Node.js 20 or newer is required.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NECTR_API_KEY` | yes | — | Your `nct_` API key |
| `NECTR_URL` | no | `https://nectr.ch` | The nectr site to talk to, for a self-hosted instance |

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `search_library(query?, limit?)` | Finds saved pages by title or URL. Returns ids, URLs, freshness and a two-sentence summary per page, but **not** the bodies. Leave out `query` to list the most recently refreshed pages. | no |
| `get_page(id \| url, max_chars?)` | Returns the clean markdown of one page, with when it was last fetched. Long pages are cut off at 40,000 characters by default; ask for more with `max_chars`. | no |
| `convert_url(url, project_id?, force_refresh?)` | Saves a web page, PDF or DOCX to your library, optionally filed under a project. Counts against your monthly conversion quota unless the page is already saved. | yes |
| `list_projects()` | Lists your projects with page counts and each project's public `llms.txt` URL. | no |

There is deliberately **no delete**. A model that could delete your library by misreading a request isn't worth the convenience.

Search returns summaries rather than bodies so that looking around your library doesn't fill the model's context. It reads a full page only when it chooses to.

## Limits and errors

The server uses the same developer API as any other script, so your plan's limits apply unchanged. Errors are worded so a model knows whether to retry:

| nectr says | The model is told |
|---|---|
| 401: the key is invalid or revoked | Don't retry; you need a new key |
| 402: over the monthly quota | Don't retry until the quota resets |
| 422: the page can't be read (for example, it's behind a login) | nectr's reason, as given |
| 429: rate limited | How many seconds to wait |
| 503: the converter is busy | Retry in a few seconds |

## Security

**Your API key is stored in plain text in your MCP client's config file.** That's normal for MCP servers, but anyone who can read that file can use the key.

- Create a dedicated key for each client, so you can revoke one without breaking the others.
- If a key leaks, delete it under **Settings → API keys** in nectr. It stops working immediately.
- This server only ever reads and adds pages. **The key itself is broader:** it has the same access to the nectr API as your account, deletion included, so treat it like a password.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
NECTR_API_KEY=nct_... node dist/index.js   # speaks MCP over stdio
```

The tests run against a fake nectr API (`test/fake-api.ts`) and through a real MCP client over an in-memory transport (`test/server.test.ts`).

## License

MIT

# nectr-mcp

An [MCP](https://modelcontextprotocol.io) server for [nectr](https://nectr.ch), which shows how AI reads a web page.

It gives a model one tool, `scan_page`. Given a public page's address, it returns the page as clean markdown and what an AI agent gets from it: the size in words and estimated tokens, which AI crawlers the site's robots.txt allows, linked PDFs and whether they hold text, and the text that only appears after JavaScript runs.

> **Coming from 0.2?** The library tools (`search_library`, `get_page`, `convert_url`) are gone. Your existing `nct_` key works with `scan_page`.

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

3. Restart the client. The `scan_page` tool should appear.

Node.js 20 or newer is required.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NECTR_API_KEY` | yes | — | Your `nct_` API key |
| `NECTR_URL` | no | `https://nectr.ch` | The nectr site to talk to, for a self-hosted instance |

## The tool

`scan_page(url, markdown?, max_chars?)` fetches the page twice, with a browser and as plain HTTP, the way AI crawlers do, and returns:

| Section | What it says |
|---|---|
| Size | Words and estimated tokens of the whole page as markdown, against the raw HTML an agent receives, and the words left without JavaScript |
| robots.txt | Whether GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended and CCBot may fetch the page |
| Linked PDFs | Up to 3 PDFs on the same site: pages, words, and whether there's a text layer at all |
| Only with JavaScript | The share of words an agent misses without JavaScript, and the first 10 of those blocks |
| Markdown | The page as markdown, last. `markdown` picks `"full"` (after JavaScript runs, the default), `"without_javascript"` or `"none"`. It's cut at 40,000 characters unless you raise `max_chars` |

The tool is read-only: nectr stores nothing from a scan. nectr honours the site's robots.txt for itself, so a page whose robots.txt keeps nectr out isn't fetched.

The full response, field by field, is in the [scan API documentation](https://nectr.ch/docs#scan).

## Limits and errors

The server uses the same developer API as any other script, so the API's limits apply: 10 scans a minute from one IP address. Errors are worded so a model knows whether to retry:

| nectr says | The model is told |
|---|---|
| 401: the key is invalid or revoked | Don't retry; you need a new key |
| 403: robots.txt keeps nectr out, or scans aren't open to the account | nectr's reason; don't retry |
| 422: the page can't be scanned (not public, not found, a PDF) | nectr's reason, as given |
| 429: rate limited | How many seconds to wait |
| 503: nectr is busy | Retry in a few seconds |

## Security

**Your API key is stored in plain text in your MCP client's config file.** That's normal for MCP servers, but anyone who can read that file can use the key.

- Create a dedicated key for each client, so you can revoke one without breaking the others.
- If a key leaks, delete it under **Settings → API keys** in nectr. It stops working immediately.
- This server only ever scans. **The key itself is broader:** it has the same access to the nectr API as your account, so treat it like a password.

## Development

Running the server needs Node 20+, but **developing needs Node 22.12 or newer** (Vitest and the MCP Inspector require it). CI uses Node 24.

```bash
npm ci                 # not `npm install`: installs exactly the lockfile and never rewrites it
npm run typecheck
npm test
npm run build
NECTR_API_KEY=nct_... node dist/index.js   # speaks MCP over stdio
```

The tests run against a fake nectr API (`test/fake-api.ts`) and through a real MCP client over an in-memory transport (`test/server.test.ts`).

If `npm test` fails with **"Cannot find native binding"**, the `node_modules` folder was installed on another platform, for example inside a Linux container. `npm install` on top of it won't fix it. Delete `node_modules` and run `npm ci` again.

### Trying it by hand with the MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) calls the tools directly, without a model, and shows exactly what a model would receive. Build first (`npm run build`), then use its CLI mode. **Put the server command before the options.** With the options first, the Inspector reports "No servers found in config file".

```powershell
# PowerShell; in bash, use $NECTR_API_KEY instead of $k
$k = "nct_your_key"

npx @modelcontextprotocol/inspector --cli node dist/index.js -e NECTR_API_KEY=$k --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/index.js -e NECTR_API_KEY=$k --method tools/call --tool-name scan_page --tool-arg url=https://example.com/
npx @modelcontextprotocol/inspector --cli node dist/index.js -e NECTR_API_KEY=$k --method tools/call --tool-name scan_page --tool-arg url=https://example.com/ --tool-arg markdown=none
```

Add `-e NECTR_URL=http://localhost:8000` to test against a local nectr backend. There, scans are open to admins only unless the backend runs with `SCANS_ENABLED=true`; other accounts get a 403. Leave out `--cli` for the web interface; the argument order is the same.

The Inspector's own dependencies need a newer Node than this server does. If it fails with **"Cannot find native binding"** after you upgrade Node, delete its cached copy from the npx cache (`%LocalAppData%\npm-cache\_npx` on Windows, `~/.npm/_npx` elsewhere) and run it again.

The quickest sanity check needs no key at all: `npx -y nectr-mcp` should print "NECTR_API_KEY is not set" and exit.

### Publishing

```bash
npm version patch      # or minor / major; also bump VERSION in src/server.ts and USER_AGENT in src/client.ts
npm publish            # prepublishOnly runs typecheck, tests and build first
```

npm refuses to publish from an account without two-factor authentication (error `E403`). Enable it under your npm account settings; `npm publish` then asks you to confirm in the browser or with `--otp=<code>`.

## License

MIT

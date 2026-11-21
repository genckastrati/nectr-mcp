# nectr-mcp

An [MCP](https://modelcontextprotocol.io) server for [nectr](https://nectr.ch), which shows how AI reads a web page.

It gives a model two tools:

- **`scan_page`**: given a public page's address, it returns what an AI agent gets from it: the size in words and estimated tokens, which AI crawlers the site's robots.txt allows, linked PDFs and whether they hold text, its data tables and the structured data it declares (JSON-LD, microdata, schema.org RDFa), and the text that only appears after JavaScript runs. For pages on your own verified sites, it also returns the page as clean markdown, the tables' rows and the structured data itself.
- **`list_sites`**: lists your sites in nectr and their pages' URLs, so you can see which pages you'll get markdown for, and the datasets you've published from each site with their addresses.

> **New in 0.5:** `scan_page` reports a page's data tables and the structured data it declares, and `list_sites` shows the datasets you've published from each site.
>
> **Coming from 0.3?** `scan_page` now includes the markdown only for pages on your own verified sites. Any other page still gets the full scan, without the markdown.
>
> **Coming from 0.2?** The library tools (`search_library`, `get_page`, `convert_url`) are gone. Your existing `nct_` key works with these tools.

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

3. Restart the client. The `scan_page` and `list_sites` tools should appear.

Node.js 20 or newer is required.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NECTR_API_KEY` | yes | — | Your `nct_` API key |
| `NECTR_URL` | no | `https://nectr.ch` | The nectr site to talk to, for a self-hosted instance. Use its exact https address: the server won't follow a redirect, because the key would be dropped on the way |

## The tools

### scan_page

`scan_page(url, markdown?, max_chars?)` fetches the page twice, with a browser and as plain HTTP, the way AI crawlers do, and returns:

| Section | What it says |
|---|---|
| Size | Words and estimated tokens of the whole page as markdown, against the raw HTML an agent receives, and the words left without JavaScript |
| robots.txt | Whether GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended and CCBot may fetch the page |
| Linked PDFs | Up to 3 PDFs on the same site: pages, words, and whether there's a text layer at all |
| Tables | Each data table's title, columns and row count (the first 20). The rows are in the markdown, for a page on one of your verified sites. Left out when the page has none |
| Structured data | What the page declares about itself, experimental on nectr's side: each item's schema.org types and where it was declared (JSON-LD, microdata or RDFa, the first 20), and its definition lists. "None" when it declares nothing |
| Only with JavaScript | The share of words an agent misses without JavaScript, and the first 10 of those blocks. For a page that isn't on your verified sites, nectr sends only the first 5, shortened, so the tool doesn't count them |
| Markdown | The page as markdown, last, and only for a page on one of your verified sites; otherwise the tool says it was left out and points to `list_sites`. `markdown` picks `"full"` (after JavaScript runs, the default), `"without_javascript"` or `"none"`. It's cut at 40,000 characters unless you raise `max_chars` |
| Structured data as JSON | For a page on one of your verified sites, after the markdown: the structured data itself, compact, cut at `max_chars` like the markdown |

Any public page can be scanned. The tool is read-only: nectr stores nothing from a scan. nectr honours the site's robots.txt for itself, so a page whose robots.txt keeps nectr out isn't fetched.

The full response, field by field, is in the [scan API documentation](https://nectr.ch/docs#scan).

### list_sites

`list_sites()` takes no arguments. For each of your sites it gives the domain, whether it's verified (only verified sites get markdown from `scan_page`), how many pages nectr has copied as markdown, the site's llms.txt address, and the URL of each page (up to 100 per site) with its title and word count. A page nectr couldn't copy shows its status and the reason.

Before the pages come the datasets you've published from the site with [Publish](https://nectr.ch/docs#publish) (up to 50 per site): each one's name, kind (table, list, structured data or page content), title and source page, its JSON address and, for tables and lists, its CSV address, then the site's catalogue. A dataset that wasn't on its page at the last fetch says so, and from when it's deleted if it stays missing. Publishing and renaming datasets stay in nectr's dashboard: the tool only reads them. When nectr doesn't answer for the datasets, the site is listed without them.

## Limits and errors

The server uses the same developer API as any other script, so the API's limits apply: 10 scans a minute from one IP address. Errors are worded so a model knows whether to retry:

| nectr says | The model is told |
|---|---|
| 401: the key is invalid or revoked | Don't retry; you need a new key |
| 403: robots.txt keeps nectr out, or scans aren't open to the account | nectr's reason; don't retry |
| 422: the page can't be scanned (not public, not found, a PDF) | nectr's reason, as given |
| 429: rate limited | How many seconds to wait |
| 503: nectr is busy | Retry in a few seconds |
| A redirect (for example `NECTR_URL` set to `http://…`) | Don't retry; set `NECTR_URL` to nectr's https address |
| No answer within 90 seconds (a page with large linked PDFs can take that long) | nectr was reached but slow; trying once more may work |
| No answer at all (network, DNS, TLS) | nectr couldn't be reached; check the network or `NECTR_URL` |

## Security

**Your API key is stored in plain text in your MCP client's config file.** That's normal for MCP servers, but anyone who can read that file can use the key.

- Create a dedicated key for each client, so you can revoke one without breaking the others.
- If a key leaks, delete it under **Settings → API keys** in nectr. It stops working immediately.
- This server only ever scans pages and reads your sites, their pages and their published datasets. **The key itself is broader:** it has the same access to the nectr API as your account, so treat it like a password.

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

### Checks before publishing

`npm run smoke` starts the built server the way an MCP client does and runs the release checks against nectr with your key: the tools and their read-only marks, `list_sites`, a page on one of your verified sites (markdown, tables, structured data as JSON, `markdown=none`, `max_chars`), a page that declares nothing and a page that isn't yours. Each prints PASS, SKIP (with the reason) or FAIL, and the script exits 1 if anything failed. It runs four or five scans.

```bash
npm run build
NECTR_API_KEY=nct_... npm run smoke
# optional: NECTR_SMOKE_PAGE=<a page of yours with a table and JSON-LD>, NECTR_SMOKE_FOREIGN=<someone else's page>, NECTR_URL=…
```

It stops after `list_sites` when the key is rejected: nectr runs a scan sent with a rejected key as an anonymous one, so the scan checks would test nothing.

### Trying it in Claude

To try a local build in a real conversation before publishing, point the client at `dist/index.js` instead of `npx`, and rebuild after each change.

**Claude Desktop** (Settings → Developer → Edit Config, or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS). Desktop doesn't start from your shell, so give `node`'s full path (`which node`; with nvm it changes when you switch versions):

```json
{
  "mcpServers": {
    "nectr-dev": {
      "command": "/full/path/to/node",
      "args": ["/full/path/to/nectr-mcp/dist/index.js"],
      "env": { "NECTR_API_KEY": "nct_your_key_here" }
    }
  }
}
```

Quit Desktop completely and open it again; `nectr-dev` then shows under the tools button. Ask, for example, "Which of my nectr sites have published datasets?" or "Scan https://example.com/ with nectr and tell me what it declares", and check that the answer quotes the tool. Its logs are in `~/Library/Logs/Claude/mcp-server-nectr-dev.log`.

**Claude Code**, from this folder:

```bash
claude mcp add nectr-dev -e NECTR_API_KEY=nct_... -- node "$PWD/dist/index.js"
```

Then `/mcp` in a session lists it. `claude mcp remove nectr-dev` takes it out again.

### Publishing

```bash
npm version patch      # or minor / major; also bump VERSION in src/server.ts and USER_AGENT in src/client.ts
npm run build && NECTR_API_KEY=nct_... npm run smoke   # every check PASS or SKIP
npm publish            # prepublishOnly runs typecheck, tests and build first
```

npm refuses to publish from an account without two-factor authentication (error `E403`). Enable it under your npm account settings; `npm publish` then asks you to confirm in the browser or with `--otp=<code>`.

## License

MIT

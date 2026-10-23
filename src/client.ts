/**
 * A thin client over the public nectr API (`/api/v1`), authenticated with an
 * `nct_` API key. It uses the scan endpoint the developer API documents
 * (nectr.ch/docs#scan); this package adds no new server-side surface.
 */

export interface RobotsRule {
  agent: string;
  allowed: boolean;
}

export interface PdfCheck {
  url: string;
  pages: number | null;
  words: number | null;
  /** Null when the PDF wasn't checked; `note` then says why. */
  has_text: boolean | null;
  note: string | null;
}

/** One scan, as `POST /api/v1/scans` returns it to a key holder. */
export interface Scan {
  url: string;
  title: string | null;
  rendered_words: number;
  plain_words: number;
  /** The page as markdown after JavaScript runs, and without it. Null only without a key. */
  rendered_markdown: string | null;
  plain_markdown: string | null;
  markdown_tokens: number;
  html_tokens: number;
  /** Blocks of the rendered page whose words are nowhere in the plain HTML (at most 50). */
  only_with_javascript: string[];
  /** Words in those blocks over words in the rendered page, 0 to 1. */
  missing_word_share: number;
  robots_found: boolean;
  robots: RobotsRule[];
  pdfs: PdfCheck[];
  pdfs_not_checked: number;
  scanned_at: string;
  markdown_included: boolean;
}

/** An HTTP error from nectr, carrying what a caller needs to explain it. */
export class NectrApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`nectr API ${status}: ${detail}`);
    this.name = "NectrApiError";
  }
}

/** nectr could not be reached at all (DNS, TLS, connection refused, timeout). */
export class NectrUnreachableError extends Error {
  constructor(readonly siteUrl: string, cause: unknown) {
    super(`Could not reach nectr at ${siteUrl}`, { cause });
    this.name = "NectrUnreachableError";
  }
}

type Fetch = typeof fetch;

const USER_AGENT = "nectr-mcp/0.3.0";
// A scan fetches the page twice (a browser and plain HTTP) and checks linked
// PDFs, so it can take a while.
const TIMEOUT_MS = 90_000;

export class NectrClient {
  private readonly api: string;

  constructor(
    private readonly apiKey: string,
    readonly siteUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.api = `${siteUrl}/api/v1`;
  }

  scan(url: string): Promise<Scan> {
    return this.request<Scan>("POST", "/scans", { url });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new NectrUnreachableError(this.siteUrl, err);
    }

    if (!res.ok) {
      throw new NectrApiError(res.status, await readDetail(res), parseRetryAfter(res));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/** FastAPI puts the message in `detail`: a string, or a list of validation errors. */
async function readDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((e) => (e && typeof e === "object" && "msg" in e ? String(e.msg) : String(e)))
        .join("; ");
    }
  } catch {
    // Not JSON (a proxy error page, say) — fall through to the status text.
  }
  return res.statusText || `HTTP ${res.status}`;
}

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Turn a failure into a sentence a model can act on.
 *
 * The distinction that matters is retry-or-not: a model that sees an opaque
 * failure retries it, and retrying a quota error or a revoked key only burns
 * the caller's rate limit.
 */
export function describeError(err: unknown): string {
  if (err instanceof NectrUnreachableError) {
    return `Could not reach nectr at ${err.siteUrl}. Check the network or NECTR_URL; retrying immediately is unlikely to help.`;
  }
  if (!(err instanceof NectrApiError)) {
    return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const wait = err.retryAfterSeconds;
  switch (err.status) {
    case 401:
      return "The nectr API key was rejected — it is invalid or has been revoked. Do not retry; the user needs to create a new key in nectr under Settings → API keys.";
    case 403:
      // A robots.txt that keeps nectr out, or scans closed to this account.
      return `nectr will not scan this page: ${err.detail} Do not retry.`;
    case 422:
      return `nectr could not scan this page: ${err.detail}`;
    case 429:
      return `Rate limited by nectr. Wait ${wait ?? 60} seconds before trying again.`;
    case 503:
      return `nectr is busy scanning other pages. Retry in ${wait ?? 5} seconds.`;
    default:
      return err.status >= 500
        ? `nectr had a server error (${err.status}). Try again later.`
        : `nectr returned ${err.status}: ${err.detail}`;
  }
}

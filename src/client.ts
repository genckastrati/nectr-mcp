/**
 * A thin client over the public nectr API (`/api/v1`), authenticated with an
 * `nct_` API key. Every endpoint used here is the same one the developer API
 * documents; this package adds no new server-side surface.
 */

export interface Page {
  id: string;
  url: string;
  title: string | null;
  custom_title?: string | null;
  markdown_content: string;
  summary?: string | null;
  word_count: number;
  status: string;
  fetched_at: string;
  project_id?: string | null;
  is_shareable?: boolean;
}

export interface SavedPage {
  id: string;
  url: string;
  title: string | null;
  custom_title?: string | null;
  summary?: string | null;
  word_count: number;
  status: string;
  fetched_at: string;
  cached: boolean;
}

export interface PageList {
  items: Page[];
  total: number;
  page: number;
  limit: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  conversion_count: number;
}

export interface Me {
  link_hash: string;
  plan?: string | null;
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

const USER_AGENT = "nectr-mcp/0.1.0";
const TIMEOUT_MS = 60_000; // a real crawl can take a while; reads are fast

export class NectrClient {
  private readonly api: string;

  constructor(
    private readonly apiKey: string,
    readonly siteUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.api = `${siteUrl}/api/v1`;
  }

  search(query: string | undefined, limit: number): Promise<PageList> {
    const params = new URLSearchParams({ page: "1", limit: String(limit) });
    if (query) params.set("search", query);
    return this.request<PageList>("GET", `/conversions?${params}`);
  }

  getPage(id: string): Promise<Page> {
    return this.request<Page>("GET", `/conversions/${encodeURIComponent(id)}`);
  }

  convert(url: string, forceRefresh: boolean): Promise<SavedPage> {
    return this.request<SavedPage>("POST", "/conversions", { url, force_refresh: forceRefresh });
  }

  assignProject(id: string, projectId: string): Promise<void> {
    return this.request<void>("PATCH", `/conversions/${encodeURIComponent(id)}/project`, {
      project_id: projectId,
    });
  }

  listProjects(): Promise<Project[]> {
    return this.request<Project[]>("GET", "/projects");
  }

  me(): Promise<Me> {
    return this.request<Me>("GET", "/auth/me");
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
    case 402:
      return `Over the nectr plan's quota: ${err.detail} Do not retry until the quota resets or the plan is upgraded.`;
    case 403:
      return `nectr refused this request: ${err.detail}`;
    case 404:
      return "Not found in this nectr library. It may have been deleted, or the id is wrong.";
    case 422:
      return `nectr could not convert this page: ${err.detail}`;
    case 429:
      return `Rate limited by nectr. Wait ${wait ?? 60} seconds before trying again.`;
    case 503:
      return `nectr is busy converting other pages. Retry in ${wait ?? 5} seconds.`;
    default:
      return err.status >= 500
        ? `nectr had a server error (${err.status}). Try again later.`
        : `nectr returned ${err.status}: ${err.detail}`;
  }
}

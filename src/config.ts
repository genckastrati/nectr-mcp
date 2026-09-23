export interface Config {
  apiKey: string;
  /** Site origin, e.g. https://nectr.ch. The API lives under `${siteUrl}/api/v1`. */
  siteUrl: string;
}

export const DEFAULT_SITE_URL = "https://nectr.ch";

/**
 * Read configuration from the environment.
 *
 * Throws with a message meant for a person reading the MCP client's log: a
 * server that starts without a key would fail every single tool call instead,
 * and the model would be the one left guessing why.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.NECTR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "NECTR_API_KEY is not set. Create a key in nectr under Settings → API keys " +
        "and add it to this server's env in your MCP client configuration.",
    );
  }
  if (!apiKey.startsWith("nct_")) {
    throw new Error("NECTR_API_KEY does not look like a nectr API key (they start with nct_).");
  }
  const siteUrl = (env.NECTR_URL?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, "");
  return { apiKey, siteUrl };
}

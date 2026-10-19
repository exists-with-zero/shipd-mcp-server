// Runtime settings, read once from the environment. The MCP server holds no
// secrets of its own: every call to Shipd uses the caller's own `shp_` token.

export interface Config {
  /** Shipd backend base URL (Railway), without the /api/v1 suffix. */
  apiUrl: string;
  /** Shipd web app base URL, used to build links people can open. */
  appUrl: string;
  port: number;
  host: string;
  /** Host headers to accept. Empty means the SDK default for `host`. */
  allowedHosts: string[];
  /** Requests per minute from one client address before 429. */
  ratePerMin?: number;
  /** Browser origins allowed to call /mcp (CORS): Shipd's own web app, so the
   * voice page can be an MCP host, plus MCP_CORS_ORIGINS. */
  corsOrigins?: string[];
  /** Sign in with Shipd: the OAuth issuer (Shipd's backend) that clients such
   * as Claude are sent to for a token. Unset: no OAuth metadata, and 401s say
   * only "send a token", exactly as before. */
  oauthIssuer?: string;
  /** This server's own public base URL, which names it as an OAuth resource. */
  publicUrl?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** A web origin (http or https only). Anything else, including what turns
 * into the opaque origin "null" (file:, data:, extensions), is never allowed. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Every caller's token travels to this URL, so off this machine it must be
 * https (or Railway's private network, which never leaves Railway). */
function checkApiUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SHIPD_API_URL is not a URL: ${raw}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "https:" || LOOPBACK.has(host) || host.endsWith(".railway.internal")) return;
  throw new Error("SHIPD_API_URL must be https:// (callers' tokens travel to it).");
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Railway's health checks arrive with this Host header, not the public one. */
export const RAILWAY_HEALTHCHECK_HOST = "healthcheck.railway.app";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // On Railway: listen on every interface, and accept the service's own public
  // domain (Railway sets RAILWAY_PUBLIC_DOMAIN once one is generated) plus its
  // health checker. Anything else, such as a custom domain, goes in
  // MCP_ALLOWED_HOSTS. Elsewhere the defaults stay local.
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_SERVICE_ID);
  if (onRailway && (!env.SHIPD_API_URL || !env.SHIPD_APP_URL)) {
    // A deployed server pointed at localhost would fail every call quietly.
    throw new Error("Set SHIPD_API_URL and SHIPD_APP_URL on the Railway service.");
  }
  const explicit = (env.MCP_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const railwayHosts = onRailway ? [env.RAILWAY_PUBLIC_DOMAIN || "", RAILWAY_HEALTHCHECK_HOST] : [];
  const config: Config = {
    apiUrl: trimSlash(env.SHIPD_API_URL || "http://localhost:8000"),
    appUrl: trimSlash(env.SHIPD_APP_URL || "http://localhost:3000"),
    port: Number(env.PORT || 8787),
    host: env.MCP_HOST || (onRailway ? "0.0.0.0" : "127.0.0.1"),
    allowedHosts: [...new Set([...explicit, ...railwayHosts].filter(Boolean))],
    ratePerMin: Number(env.MCP_RATE_PER_MIN || 120),
    corsOrigins: [],
  };
  config.corsOrigins = [
    ...new Set(
      [originOf(config.appUrl), ...(env.MCP_CORS_ORIGINS || "").split(",").map((o) => originOf(o.trim()))].filter(
        (o): o is string => Boolean(o),
      ),
    ),
  ];
  checkApiUrl(config.apiUrl);
  const issuer = (env.SHIPD_OAUTH_ISSUER || "").trim();
  if (issuer) {
    const origin = originOf(issuer);
    if (!origin || (!origin.startsWith("https://") && !LOOPBACK.has(new URL(origin).hostname))) {
      throw new Error("SHIPD_OAUTH_ISSUER must be the https:// address of Shipd's backend.");
    }
    config.oauthIssuer = trimSlash(issuer);
    const domain = env.RAILWAY_PUBLIC_DOMAIN;
    config.publicUrl = trimSlash(
      env.MCP_PUBLIC_URL || (domain ? `https://${domain}` : `http://${config.host}:${config.port}`),
    );
  }
  if (!LOOPBACK.has(config.host) && config.allowedHosts.length === 0) {
    // The SDK would only warn and then accept any Host header.
    throw new Error(`Listening on ${config.host} needs MCP_ALLOWED_HOSTS (the public hostname).`);
  }
  return config;
}

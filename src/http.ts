// Streamable HTTP. Every server (and its task store) is bound to the Shipd API
// token in the Authorization header.
//
// A client that initializes gets a session, so Shipd can ask it a question
// mid-call (elicitation): the answer comes back as a new request and has to
// reach the same server. A session is bound to the token that opened it, and
// any other token is told it does not exist. A request with no session is
// served statelessly, as before: a fresh server per request.
//
// Builds never depend on a session. A build id carries the Shipd job itself,
// so builds survive a restart of this server; only an open question is lost,
// and the client starts a new session. Sessions live in memory: run ONE copy.

import { createHash, randomUUID } from "node:crypto";

import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { Config } from "./config.js";
import { withCallScope } from "./scope.js";
import { createShipdServer, SERVER_VERSION } from "./server.js";
import { ShipdClient, ShipdError } from "./shipd.js";

// Only Shipd API tokens (at most member rights). The voice page gets a
// short-lived one from the backend (POST /voice/token); a full-power signed-in
// session never reaches this server.
const TOKEN_RE = /^shp_[A-Za-z0-9_-]{43}$/;
const PRM_PATH = "/.well-known/oauth-protected-resource";

function bearer(req: Request): string | null {
  const h = req.headers.authorization || "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return TOKEN_RE.test(token) ? token : null;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** A token Shipd has just refused is turned away here for this long, so a
 * stream of bad tokens never becomes a stream of backend lookups. */
export const BAD_TOKEN_MS = 60_000;
/** With OAuth on, how long a token Shipd accepted is trusted before asking again
 * (short, so an access token past its hour is caught within a minute). */
export const VERIFY_MS = 60_000;
const MAP_LIMIT = 10_000;

/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** At most this many open sessions; the least recently used goes first. */
export const MAX_SESSIONS = 500;
/** At most this many per token: a client that re-initializes every turn only
 * ever pushes out its own oldest session, never anyone else's. */
export const MAX_SESSIONS_PER_TOKEN = 5;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tokenHash: string;
  lastSeen: number;
  /** Requests still open on it (one may be waiting on a question). Never evicted
   * while above zero. */
  inflight: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionHeader(req: Request): string | undefined {
  const raw = req.headers["mcp-session-id"];
  return typeof raw === "string" && raw ? raw : undefined;
}

export function createApp(config: Config, fetchImpl: typeof fetch = fetch): Express {
  const sessions = new Map<string, Session>();

  const endSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close();
    void s.server.close();
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) endSession(id);
  }, 60_000);
  sweep.unref();

  /** The live session for this id and token, or null. Another token's session
   * looks exactly like one that does not exist. */
  const sessionFor = (id: string, token: string): Session | null => {
    const s = sessions.get(id);
    if (!s || s.tokenHash !== hashToken(token)) return null;
    s.lastSeen = Date.now();
    return s;
  };

  // What the SDK's createMcpExpressApp builds, with CORS first, so even a
  // refused Host or an unreadable body reaches the voice page as a readable
  // error rather than an opaque network failure.
  const app = express();
  // Behind Railway's proxy: req.ip is the caller's address, not the proxy's.
  app.set("trust proxy", 1);

  // Sign in with Shipd (OAuth). With an issuer configured, this server says
  // where a token comes from (RFC 9728 protected-resource metadata, and a
  // pointer to it on every 401), so a client like Claude can send the person
  // to Shipd to approve it. The token it gets is an ordinary `shp_` token;
  // nothing below changes. Public, static metadata: any origin may read it.
  const oauth = config.oauthIssuer && config.publicUrl ? { issuer: config.oauthIssuer, base: config.publicUrl } : null;
  const challenge = (invalid: boolean): string => {
    if (!oauth) return 'Bearer realm="shipd"';
    const parts = ['realm="shipd"', `resource_metadata="${oauth.base}${PRM_PATH}/mcp"`, 'scope="shipd"'];
    if (invalid) parts.push('error="invalid_token"');
    return `Bearer ${parts.join(", ")}`;
  };
  if (oauth) {
    const metadata = {
      resource: `${oauth.base}/mcp`,
      authorization_servers: [oauth.issuer],
      scopes_supported: ["shipd"],
      bearer_methods_supported: ["header"],
      resource_name: "Shipd",
      resource_documentation: config.appUrl,
    };
    const paths = [PRM_PATH, `${PRM_PATH}/mcp`];
    app.options(paths, (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "MCP-Protocol-Version, Content-Type");
      res.status(204).end();
    });
    app.get(paths, (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(metadata);
    });
  }

  // CORS for Shipd's own web app only (the voice page is an MCP host in the
  // browser). Auth is a bearer header, never a cookie, so this opens no
  // cross-site request path; it only lets that one origin read the replies.
  const corsOrigins = new Set(config.corsOrigins ?? []);
  /** A call from Shipd's own web app (the voice page), which speaks the
   * team's lines itself: no watch_build or speak_line for it. */
  const fromShipdPage = (req: Request): boolean => {
    const origin = req.headers.origin;
    return typeof origin === "string" && corsOrigins.has(origin);
  };
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && corsOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
        );
        res.setHeader("Access-Control-Max-Age", "600");
        res.status(204).end();
        return;
      }
    } else if (req.method === "OPTIONS") {
      res.status(403).end();
      return;
    }
    next();
  });
  if (config.allowedHosts.length) app.use(hostHeaderValidation(config.allowedHosts));
  else if (["127.0.0.1", "localhost", "::1"].includes(config.host)) app.use(localhostHostValidation());
  app.use(express.json());

  const ratePerMin = config.ratePerMin ?? 120;
  const hits = new Map<string, { start: number; count: number }>();
  const badTokens = new Map<string, number>(); // token hash -> refused until

  /** Fixed one-minute window per key (a token hash, or an address). */
  const overLimit = (key: string, limit: number): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start >= 60_000) {
      if (hits.size >= MAP_LIMIT) hits.clear();
      hits.set(key, { start: now, count: 1 });
      return false;
    }
    h.count += 1;
    return h.count > limit;
  };

  const refused = (hash: string): boolean => {
    const until = badTokens.get(hash);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    badTokens.delete(hash);
    return false;
  };

  /** The caller's fetch to Shipd, remembering a token Shipd refuses. */
  const watching = (hash: string): typeof fetch => async (input, init) => {
    const res = await fetchImpl(input, init);
    if (res.status === 401) {
      if (badTokens.size >= MAP_LIMIT) badTokens.clear();
      badTokens.set(hash, Date.now() + BAD_TOKEN_MS);
    }
    return res;
  };

  // With OAuth on, a token Shipd no longer accepts (an access token past its
  // hour) has to be told so with a 401 here, which makes the client refresh
  // it, not with an error from inside a tool call. Checked at most once a
  // minute per token; without OAuth nothing changes.
  const verifiedAt = new Map<string, number>(); // token hash -> last accepted
  const stillAccepted = async (token: string, hash: string): Promise<boolean> => {
    if (!oauth) return true;
    const at = verifiedAt.get(hash);
    if (at !== undefined && Date.now() - at < VERIFY_MS) return true;
    try {
      await new ShipdClient(config.apiUrl, token, watching(hash)).whoami();
    } catch (err) {
      if (err instanceof ShipdError && err.status === 401) return false;
      return true; // Shipd unreachable or slow: the call will say so itself
    }
    if (verifiedAt.size >= MAP_LIMIT) verifiedAt.clear();
    verifiedAt.set(hash, Date.now());
    return true;
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: SERVER_VERSION });
  });

  const tooMany = (res: Response) => {
    res.setHeader("Retry-After", "60");
    rpcError(res, 429, -32000, "Too many requests. Wait a minute and try again.");
  };

  app.post("/mcp", async (req, res) => {
    // Per address only as a flood backstop: on a hosted client (Claude,
    // ChatGPT) every user's calls arrive from the host's own addresses.
    if (overLimit(`ip:${req.ip || "unknown"}`, ratePerMin * 10)) return tooMany(res);
    if (Array.isArray(req.body)) {
      // JSON-RPC batches left MCP in 2025-06-18; one request, one call.
      rpcError(res, 400, -32600, "Batched requests are not supported.");
      return;
    }
    const token = bearer(req);
    if (!token) {
      // The token itself is checked by Shipd on every call; this only turns
      // away requests that could never be one.
      res.setHeader("WWW-Authenticate", challenge(Boolean(req.headers.authorization)));
      rpcError(res, 401, -32001, "Send a Shipd API token: Authorization: Bearer shp_...");
      return;
    }
    const hash = hashToken(token);
    if (overLimit(`t:${hash}`, ratePerMin)) return tooMany(res);
    if (refused(hash) || (!isInitializeRequest(req.body) && !(await stillAccepted(token, hash)))) {
      res.setHeader("WWW-Authenticate", challenge(true));
      rpcError(res, 401, -32001, "Shipd didn't accept that token. Check it in Settings, API tokens.");
      return;
    }
    const sid = sessionHeader(req);
    if (sid) {
      const s = sessionFor(sid, token);
      if (!s) {
        rpcError(res, 404, -32001, "Session not found. Start a new one.");
        return;
      }
      s.inflight += 1;
      res.on("close", () => {
        s.inflight -= 1;
        s.lastSeen = Date.now();
      });
      try {
        await withCallScope(req.body, () => s.transport.handleRequest(req, res, req.body));
      } catch (err) {
        console.error("mcp session request failed:", err instanceof Error ? err.message : err);
        if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
      }
      return;
    }

    if (isInitializeRequest(req.body)) {
      const client = new ShipdClient(config.apiUrl, token, watching(hash));
      // A session costs memory, so only a token Shipd accepts gets one (and a
      // refused token lands in the bad-token memory on the way).
      try {
        await client.whoami();
      } catch (err) {
        if (err instanceof ShipdError && err.status === 401) {
          res.setHeader("WWW-Authenticate", challenge(true));
          rpcError(res, 401, -32001, "Shipd didn't accept that token. Check it in Settings, API tokens.");
          return;
        }
        // Shipd unreachable or slow: the session's calls will say so themselves.
      }
      if (oauth) verifiedAt.set(hash, Date.now());
      /** The least recently used idle session matching `pick`, if any. */
      const idlest = (pick: (s: Session) => boolean): string | null => {
        let found: [string, Session] | null = null;
        for (const entry of sessions) {
          const s = entry[1];
          if (s.inflight > 0 || !pick(s)) continue;
          if (!found || s.lastSeen < found[1].lastSeen) found = entry;
        }
        return found ? found[0] : null;
      };
      const mine = () => [...sessions.values()].filter((s) => s.tokenHash === hash).length;
      while (mine() >= MAX_SESSIONS_PER_TOKEN) {
        const id = idlest((s) => s.tokenHash === hash);
        if (!id) break;
        endSession(id);
      }
      while (sessions.size >= MAX_SESSIONS) {
        const id = idlest(() => true);
        if (!id) break;
        endSession(id);
      }
      if (sessions.size >= MAX_SESSIONS || mine() >= MAX_SESSIONS_PER_TOKEN) {
        res.setHeader("Retry-After", "30");
        rpcError(res, 503, -32000, "Shipd is busy right now. Try again in a moment.");
        return;
      }
      const server = createShipdServer(client, config.appUrl, { shipdPage: fromShipdPage(req) });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, tokenHash: hash, lastSeen: Date.now(), inflight: 0 });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      try {
        await server.connect(transport);
        await withCallScope(req.body, () => transport.handleRequest(req, res, req.body));
      } catch (err) {
        console.error("mcp initialize failed:", err instanceof Error ? err.message : err);
        if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
      }
      return;
    }

    // No session: stateless, a fresh server for this one request.
    const server = createShipdServer(new ShipdClient(config.apiUrl, token, watching(hash)), config.appUrl, {
      shipdPage: fromShipdPage(req),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await withCallScope(req.body, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      console.error("mcp request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });

  // No standalone server-to-client stream: Shipd only ever asks a question
  // inside a call, on that call's own response.
  app.get("/mcp", (_req: Request, res: Response) => rpcError(res, 405, -32000, "Method not allowed."));

  // A client ending its session.
  app.delete("/mcp", (req: Request, res: Response) => {
    const token = bearer(req);
    const sid = sessionHeader(req);
    if (!token || !sid) {
      rpcError(res, 405, -32000, "Method not allowed.");
      return;
    }
    if (!sessionFor(sid, token)) {
      rpcError(res, 404, -32001, "Session not found.");
      return;
    }
    endSession(sid);
    res.status(200).end();
  });

  // Express's own error page is HTML with a stack trace outside production.
  // A bad body (unparseable JSON, too large) gets a JSON-RPC error instead.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = Number((err as { status?: number })?.status) || 500;
    if (status === 413) return rpcError(res, 413, -32600, "Request too large.");
    if (status >= 400 && status < 500) return rpcError(res, status, -32700, "Could not read the request.");
    console.error("mcp error:", err instanceof Error ? err.message : err);
    rpcError(res, 500, -32603, "Internal server error");
  });

  return app;
}

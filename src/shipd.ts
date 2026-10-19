// A thin client for the Shipd backend, bound to ONE caller's API token.
//
// Every guard Shipd has (rate limits, the daily budget breaker, token limits,
// plan rules, org isolation) runs on the backend for these calls exactly as it
// does for the browser. This client adds none and skips none; it only turns
// the backend's answers into short sentences a voice assistant can say.

export interface Project {
  id: string;
  name: string;
  framework?: string;
  /** "node", "python", "csharp" or "java" when the app has its own server. */
  backend?: string;
  created_at?: string;
}

export interface Version {
  id: string;
  version_num: number;
  prompt?: string | null;
  created_at?: string;
}

export interface JobStatus {
  status: "running" | "done" | "error";
  chars?: number;
  /** Epoch seconds of the last heartbeat or state change. */
  updated_at?: number;
  error?: string | null;
  retryable?: boolean;
}

/** The AI Team job (backend /team/job): the rooms and what each person said. */
export interface TeamJobStatus extends JobStatus {
  stage?: string | null;
  stages?: { key: string; name: string; title: string; status: string }[];
  /** Spoken lines, e.g. "Ren designed 3 screens: Home, Booking and Done." */
  lines?: string[];
  lines_total?: number;
  /** The same moments in each person's own voice (the voice page speaks them). */
  voice?: { key: string; name: string; text: string }[];
  voice_total?: number;
  /** The version Devin saved on his own; the app is ready past it. */
  base_version?: number;
}

/** A team member's answer to a note (backend /team/job/{id}/note). */
export interface TeamNoteReply {
  /** Their room ("director"), which is also their voice. */
  to: string;
  name: string;
  reply: string;
  /** Whether the rest of the build takes the note (false once Sam is building). */
  taken: boolean;
  /** Who will carry it in. */
  by: string[];
}

/** A failed Shipd call, with a message that is safe to say out loud.
 * `detail` is Shipd's own text, kept to tell apart answers that share a
 * status (the team switch's "Not found" vs "Project not found"). */
export class ShipdError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ShipdError";
  }
}

/** No em or en dashes in anything said aloud (owner rule); some of Shipd's
 * shared error texts still carry them. */
export function undash(text: string): string {
  const em = String.fromCharCode(0x2014);
  const en = String.fromCharCode(0x2013);
  return text
    .split(` ${em} `).join(", ")
    .split(` ${en} `).join(", ")
    .split(em).join(", ")
    .split(en).join("-");
}

const REQUEST_TIMEOUT_MS = 20_000;
/** A spoken line is a sentence or two; a few hundred KB of MP3 at most. */
const MAX_AUDIO_BYTES = 1_000_000;

function spokenError(status: number, detail: string | undefined): string {
  return undash(rawSpokenError(status, detail));
}

function rawSpokenError(status: number, detail: string | undefined): string {
  if (status === 401) {
    return "Your Shipd token is not valid anymore. Make a new one in Shipd settings and reconnect.";
  }
  if (status === 404) return "I couldn't find that in your Shipd account.";
  if (status === 402 || status === 403 || status === 429) {
    // Plan limits and rate limits already carry a human sentence.
    return detail || "Your Shipd plan doesn't allow that right now.";
  }
  if (status >= 500) return "Shipd had a problem. Try again in a moment.";
  return detail || `Shipd said no (${status}).`;
}

export class ShipdClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShipdError(503, "I couldn't reach Shipd. Try again in a moment.");
    }
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const data = (await res.json()) as { detail?: unknown };
        if (typeof data.detail === "string") detail = data.detail;
      } catch {
        // not JSON; the status alone decides the message
      }
      throw new ShipdError(res.status, spokenError(res.status, detail), detail);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** One line in a team member's own voice (Amazon Polly, through Shipd),
   * as MP3 bytes: the same voices as the voice page. 404 when voice is not on
   * for the account, 503 when Shipd has no voices set up. */
  async speak(voice: string, text: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}/api/v1/voice/speak`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ voice, text }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShipdError(503, "I couldn't reach Shipd's voices.");
    }
    if (!res.ok) {
      throw new ShipdError(
        res.status,
        res.status === 404 ? "Shipd's voices aren't switched on for this account." : spokenError(res.status, undefined),
      );
    }
    if (!(res.headers.get("content-type") || "").startsWith("audio/")) {
      throw new ShipdError(502, "Shipd sent something that isn't audio.");
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new ShipdError(502, "That line is too long to play.");
    return bytes;
  }

  listProjects(): Promise<Project[]> {
    return this.call<Project[]>("GET", "/projects");
  }

  /** The newest projects and the total, without each project's design (the
   * full list is about 0.5 MB for an account with 380 apps). A Shipd that
   * does not have this yet answers with the full list instead. */
  async recentProjects(limit: number): Promise<{ total: number; projects: Project[] }> {
    try {
      return await this.call<{ total: number; projects: Project[] }>("GET", `/projects/recent?limit=${limit}`);
    } catch (err) {
      // An older Shipd reads "recent" as a project id.
      if (!(err instanceof ShipdError) || ![400, 404, 405, 422, 500].includes(err.status)) throw err;
      console.warn(`recent projects answered ${err.status}; reading the full list instead`);
      const all = await this.listProjects();
      return { total: all.length, projects: all.slice(0, limit) };
    }
  }

  getProject(projectId: string): Promise<Project> {
    return this.call<Project>("GET", `/projects/${encodeURIComponent(projectId)}`);
  }

  /** `backend` ("node") gives the project a real server and database, which
   * the AI Team's Devin builds before Sam builds the screens. */
  createProject(name: string, backend?: string): Promise<Project> {
    // React is the one framework every plan can build.
    return this.call<Project>("POST", "/projects", { name, framework: "react", ...(backend ? { backend } : {}) });
  }

  /** A name a person chose. The backend then stops renaming the project from
   * the generated app (projects.name_auto). */
  renameProject(projectId: string, name: string): Promise<Project> {
    return this.call<Project>("PATCH", `/projects/${encodeURIComponent(projectId)}`, { name });
  }

  /** Only for a project this call just created and could not build. */
  async deleteProject(projectId: string): Promise<void> {
    await this.call<void>("DELETE", `/projects/${encodeURIComponent(projectId)}`);
  }

  async listVersions(projectId: string): Promise<Version[]> {
    const data = await this.call<{ versions: Version[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/versions`,
    );
    return data.versions ?? [];
  }

  /** Start a build or an edit. With no code snapshot the backend loads the
   * project's latest saved version itself, so an edit changes the real app. */
  /** `backend` is the app's own stack, so an edit of an app with a server
   * keeps (and can change) that server instead of editing the screens alone. */
  async startGenerate(projectId: string, prompt: string, framework = "react", backend = ""): Promise<string> {
    const data = await this.call<{ job_id: string }>("POST", "/generate/job", {
      prompt,
      project_id: projectId,
      framework,
      ...(backend ? { backend } : {}),
    });
    return data.job_id;
  }

  /** Who the token belongs to (plan and limits). The cheapest call that
   * proves a token is real. */
  whoami(): Promise<unknown> {
    return this.call("GET", "/me/entitlements");
  }

  /** Shipd's pre-build questionnaire, tailored to the request: who the app is
   * for and which features it might need (a fast, cheap model; Shipd serves
   * generic options if that model fails). */
  clarify(prompt: string): Promise<{ audience?: string[]; features?: string[]; questions?: string[] }> {
    return this.call("POST", "/clarify", { prompt });
  }

  /** Job state without the model's text (`since` past the end returns none). */
  jobStatus(jobId: string): Promise<JobStatus> {
    return this.call<JobStatus>(
      "GET",
      `/generate/status/${encodeURIComponent(jobId)}?since=1000000000`,
    );
  }

  /** A public link to one saved version (the latest by default). Sharing the
   * same version again hands back the same link. `live_data`: visitors run on
   * the app's real data (it uses Shipd's built-in backend). */
  createShare(
    projectId: string,
  ): Promise<{ url: string; version_num: number; withheld?: string[]; live_data?: boolean }> {
    return this.call("POST", `/projects/${encodeURIComponent(projectId)}/share`, {});
  }

  /** Turn off every share link to this app. */
  async stopSharing(projectId: string): Promise<number> {
    const data = await this.call<{ revoked: number }>(
      "DELETE",
      `/projects/${encodeURIComponent(projectId)}/shares`,
    );
    return Number(data.revoked || 0);
  }

  /** Start the AI Team (Maya, Theo, Ren, Sam) as one server-side job. */
  async startTeamJob(projectId: string, prompt: string, answers?: string): Promise<string> {
    const data = await this.call<{ job_id: string }>("POST", "/team/job", {
      project_id: projectId,
      prompt,
      ...(answers ? { answers } : {}),
    });
    return data.job_id;
  }

  teamJobStatus(jobId: string): Promise<TeamJobStatus> {
    return this.call<TeamJobStatus>("GET", `/team/job/${encodeURIComponent(jobId)}`);
  }

  /** The person speaks to one team member mid-build ("Theo, make it darker"):
   * the note joins the rest of the build, and that person answers. */
  noteTeamJob(jobId: string, to: string, text: string): Promise<TeamNoteReply> {
    return this.call<TeamNoteReply>("POST", `/team/job/${encodeURIComponent(jobId)}/note`, { to, text });
  }

  async cancelTeamJob(jobId: string): Promise<boolean> {
    const data = await this.call<{ cancelled: boolean }>(
      "POST",
      `/team/job/${encodeURIComponent(jobId)}/cancel`,
    );
    return Boolean(data.cancelled);
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const data = await this.call<{ cancelled: boolean }>(
      "POST",
      `/generate/cancel/${encodeURIComponent(jobId)}`,
    );
    return Boolean(data.cancelled);
  }
}

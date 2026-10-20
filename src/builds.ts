// Builds as MCP Tasks, with no state kept here.
//
// A build id (the MCP task id) is an opaque, url-safe encoding of the Shipd
// job it tracks: the backend job id, the project, and the version number the
// project had before the build. Everything else is read from Shipd on every
// call with the CALLER'S token, so:
//   - tenant isolation is the backend's: another org's job is a 404 there, and
//     so "task not found" here, whatever id someone presents;
//   - this server can restart, or run as many copies as it likes, without
//     losing a build;
//   - nothing about a build outlives the backend's own 1 hour job record.
//
// The MCP SDK sends tasks/get, tasks/result and tasks/cancel straight to the
// task store with only a task id, never the caller's auth. That is why a store
// is created per HTTP request, bound to that request's token (http.ts).

import type { Request, RequestId, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import type { CreateTaskOptions, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ShipdClient, ShipdError, undash, type TeamJobStatus } from "./shipd.js";

export const JOB_TTL_MS = 60 * 60 * 1000; // the backend keeps a job for 1 hour
export const POLL_INTERVAL_MS = 5000;
// A running job heartbeats every 15s; this long without one means the backend
// restarted under it (a Railway deploy kills in-process jobs).
const STALE_RUNNING_S = 120;
// The version is saved just after the job reports done; allow for that.
const SAVE_GRACE_S = 90;

// "team": the AI Team job (backend /team/job) instead of a single generate job.
const KindSchema = z.enum(["build", "edit", "team"]);
export type BuildKind = z.infer<typeof KindSchema>;

// Shipd's job and project ids are UUIDs. Anything else in a build id is
// forged, and must never become part of a backend path.
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const JobRefSchema = z.object({
  v: z.literal(1),
  kind: KindSchema,
  job: UUID,
  project: UUID,
  prev: z.number().int().min(0),
  t: z.number().int().positive(),
  // Set only on the task handed to a client that did not ask for a task: the
  // SDK would otherwise hold that call open for the whole build (minutes), so
  // the task is born completed and its result says "started" with the real
  // build id (this ref without `ack`), which check_build and the card follow.
  ack: z.literal(1).optional(),
});
// A build that never started (a plan limit, a rate limit, an unknown app).
// Carried as a task that is born failed, because the SDK cannot turn an error
// thrown while creating a task into anything but a schema error; this way the
// person hears the real reason from tasks/get and tasks/result.
const FailRefSchema = z.object({
  v: z.literal(1),
  kind: KindSchema,
  fail: z.string().min(1).max(400),
  t: z.number().int().positive(),
});
const BuildRefSchema = z.union([JobRefSchema, FailRefSchema]);
export type JobRef = z.infer<typeof JobRefSchema>;
export type BuildRef = z.infer<typeof BuildRefSchema>;

export function failedRef(kind: BuildKind, message: string): BuildRef {
  return { v: 1, kind, fail: message.slice(0, 400) || "The build could not start.", t: Date.now() };
}

export function encodeBuildId(ref: BuildRef): string {
  return Buffer.from(JSON.stringify(ref)).toString("base64url");
}

export function decodeBuildId(id: string): BuildRef | null {
  if (typeof id !== "string" || id.length > 600) return null;
  try {
    const parsed = BuildRefSchema.safeParse(JSON.parse(Buffer.from(id, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type BuildStatus = "working" | "completed" | "failed" | "cancelled";

/** One person on the AI Team and where they are. */
export interface TeamStage {
  key: string;
  name: string;
  title: string;
  status: string;
}

export interface BuildState {
  status: BuildStatus;
  /** One short sentence, written to be spoken. */
  message: string;
  version?: number;
  updatedAt: string;
  /** For the live card: how far a running build has got. */
  chars?: number;
  stage?: string | null;
  stages?: TeamStage[];
  /** The team's own lines, last few, and how many there have been in all. */
  voice?: VoiceLine[];
  voice_total?: number;
}

/** One line in a team member's own voice. */
export interface VoiceLine {
  key: string;
  name: string;
  text: string;
}

// A poller sees every line if it polls more often than 4 lines are said (the
// team says about one a minute), and text hosts are not flooded each poll.
const VOICE_KEPT = 4;

function cleanVoice(raw: unknown): VoiceLine[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((v) => v && typeof v === "object" && typeof (v as VoiceLine).text === "string")
    .slice(-VOICE_KEPT)
    .map((v) => ({
      key: String((v as VoiceLine).key ?? "").slice(0, 20),
      name: String((v as VoiceLine).name ?? "").slice(0, 30),
      text: String((v as VoiceLine).text).slice(0, 300),
    }));
  return out.length ? out : undefined;
}

/** The id that tracks the build itself (never the born-completed task). */
export function trackingId(ref: BuildRef): string {
  if ("ack" in ref && ref.ack) {
    const { ack: _ack, ...rest } = ref;
    return encodeBuildId(rest);
  }
  return encodeBuildId(ref);
}

function cleanStages(raw: unknown): TeamStage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((s) => s && typeof s === "object")
    // The five plus up to five hired specialists (the team job's own cap).
    .slice(0, 12)
    .map((s) => ({
      key: String((s as TeamStage).key ?? "").slice(0, 20),
      name: String((s as TeamStage).name ?? "").slice(0, 30),
      title: String((s as TeamStage).title ?? "").slice(0, 40),
      status: String((s as TeamStage).status ?? "").slice(0, 20),
    }));
  return out.length ? out : undefined;
}

function iso(epochSeconds: number | undefined, fallbackMs: number): string {
  return new Date(epochSeconds ? epochSeconds * 1000 : fallbackMs).toISOString();
}

/** Where a build is now, read from Shipd. null when the caller cannot see it
 * (another org's job, an expired job, or an id that was never ours). */
export async function readBuild(
  client: ShipdClient,
  ref: BuildRef,
  nowMs: number = Date.now(),
): Promise<BuildState | null> {
  if ("fail" in ref) {
    return { status: "failed", message: ref.fail, updatedAt: new Date(ref.t).toISOString() };
  }
  let job: TeamJobStatus;
  try {
    job = ref.kind === "team" ? await client.teamJobStatus(ref.job) : await client.jobStatus(ref.job);
  } catch (err) {
    if (err instanceof ShipdError && err.status === 404) return null;
    throw err;
  }
  const updatedAt = iso(job.updated_at, nowMs);
  const age = job.updated_at ? nowMs / 1000 - job.updated_at : 0;
  // A team's own lines ride along in every state, so the last one ("It's
  // built.") is not lost to a poller that next sees the build finished.
  const voice =
    ref.kind === "team" && cleanVoice(job.voice)
      ? { voice: cleanVoice(job.voice), voice_total: Math.max(0, Number(job.voice_total) || 0) }
      : {};

  if (job.status === "running") {
    if (age > STALE_RUNNING_S) {
      return {
        status: "failed",
        message: "The build stopped when Shipd restarted. Ask me to try again.",
        updatedAt,
        ...voice,
      };
    }
    const k = Math.round((job.chars ?? 0) / 1000);
    const code = k > 0 ? ` About ${k} thousand characters of code so far.` : "";
    const progress = {
      chars: Math.max(0, Number(job.chars) || 0),
      ...(ref.kind === "team"
        ? { stage: typeof job.stage === "string" ? job.stage.slice(0, 20) : null, stages: cleanStages(job.stages) }
        : {}),
    };
    if (ref.kind === "team") {
      // What the last person just finished and who is working now, e.g.
      // "Ren designed 4 screens: ... Sam is building the app." The team writes
      // a room's summary and the next room's start within milliseconds, so the
      // latest line alone would hide every summary from a poller. No code
      // count here: the message changes once per room, so a voice client can
      // say each one once instead of repeating itself every few seconds.
      const said = (job.lines ?? []).slice(-2).join(" ") || "The team is working.";
      return { status: "working", message: said, updatedAt, ...progress, ...voice };
    }
    return { status: "working", message: `Still building.${code}`, updatedAt, ...progress };
  }

  if (job.status === "error") {
    if (job.error === "Stopped.") {
      return { status: "cancelled", message: "The build was stopped.", updatedAt, ...voice };
    }
    return { status: "failed", message: undash(job.error || "The build failed."), updatedAt, ...voice };
  }

  // done: the job is finished once its version is saved. A team build with a
  // backend saves Devin's version first; the app is ready only past it.
  const versions = await client.listVersions(ref.project);
  const newest = versions.reduce((m, v) => Math.max(m, v.version_num), 0);
  const devin = ref.kind === "team" ? Number(job.base_version) || 0 : 0;
  if (newest > Math.max(ref.prev, devin)) {
    return { status: "completed", message: "Your app is ready.", version: newest, updatedAt, ...voice };
  }
  if (age < SAVE_GRACE_S) {
    return { status: "working", message: "Saving your app.", updatedAt, ...voice };
  }
  return {
    status: "failed",
    message: "The build finished but nothing new was saved. Try describing it a little differently.",
    updatedAt,
  };
}

/** Stop the job behind a build, whichever kind it is. */
export function cancelBuild(client: ShipdClient, ref: JobRef): Promise<boolean> {
  return ref.kind === "team" ? client.cancelTeamJob(ref.job) : client.cancelJob(ref.job);
}

export function appLink(appUrl: string, projectId: string): string {
  return `${appUrl}/builder?project=${encodeURIComponent(projectId)}`;
}

/** The tool result a finished (or failed, or stopped) build hands back. */
export async function buildResult(
  client: ShipdClient,
  appUrl: string,
  buildId: string,
  ref: BuildRef,
  state: BuildState,
): Promise<CallToolResult> {
  const base = {
    build_id: buildId,
    kind: ref.kind,
    ...(state.voice ? { voice: state.voice, voice_total: state.voice_total } : {}),
    // When it started and when it last moved: a card drawn again later shows
    // the real time it took, not the time since the chat was reopened.
    started_at: ref.t,
    updated_at: state.updatedAt,
    status: state.status,
    ...("project" in ref ? { app_id: ref.project } : {}),
    message: state.message,
  };
  if (state.status !== "completed" || !("project" in ref)) {
    return {
      content: [{ type: "text", text: state.message }],
      structuredContent: base,
      isError: state.status === "failed",
    };
  }
  let name = "your app";
  try {
    name = (await client.getProject(ref.project)).name || name;
  } catch {
    // the link still works without the name
  }
  const link = appLink(appUrl, ref.project);
  const text =
    ref.kind === "edit"
      ? `Done. ${name} is updated, now on version ${state.version}.`
      : ref.kind === "team"
        ? `${name} is ready. Your team planned, designed and built it, and it's on version ${state.version}.`
        : `${name} is ready. That's version ${state.version}.`;
  return {
    content: [{ type: "text", text: `${text} Open it here: ${link}` }],
    structuredContent: { ...base, message: text, app_name: name, version: state.version, link },
  };
}

/** What a client without tasks hears at once: the build has started, and the
 * id to follow it by. The card on hosts that show one follows it live. */
export function startedResult(ref: JobRef): CallToolResult {
  const said =
    ref.kind === "edit"
      ? "I'm making that change now. It takes a minute or two; I'll tell you when it's done."
      : ref.kind === "team"
        ? "Your team is on it, and Maya is writing the plan. It takes several minutes; I'll tell you when it's ready."
        : "I've started building it. It takes a few minutes; I'll tell you when it's ready.";
  return {
    content: [{ type: "text", text: said }],
    structuredContent: {
      build_id: trackingId(ref),
      kind: ref.kind,
      status: "working",
      app_id: ref.project,
      message: said,
    },
  };
}

function toTask(taskId: string, ref: BuildRef, state: BuildState): Task {
  return {
    taskId,
    status: state.status,
    ttl: JOB_TTL_MS,
    createdAt: new Date(ref.t).toISOString(),
    lastUpdatedAt: state.updatedAt,
    pollInterval: POLL_INTERVAL_MS,
    statusMessage: state.message,
  };
}

/** A TaskStore that stores nothing: every answer is read from Shipd with the
 * token of the request it was built for. */
export class ShipdTaskStore implements TaskStore {
  constructor(
    private readonly client: ShipdClient,
    private readonly appUrl: string,
  ) {}

  async createTask(params: CreateTaskOptions, _requestId: RequestId, _request: Request): Promise<Task> {
    const ref = BuildRefSchema.parse(params.context);
    const now = new Date(ref.t).toISOString();
    const started =
      ref.kind === "edit"
        ? "Making your change."
        : ref.kind === "team"
          ? "Your team is on it. Maya is writing the plan."
          : "Building your app.";
    if ("ack" in ref && ref.ack) {
      return {
        taskId: encodeBuildId(ref),
        status: "completed",
        ttl: JOB_TTL_MS,
        createdAt: now,
        lastUpdatedAt: now,
        pollInterval: POLL_INTERVAL_MS,
        statusMessage: "Started.",
      };
    }
    return {
      taskId: encodeBuildId(ref),
      status: "fail" in ref ? "failed" : "working",
      ttl: JOB_TTL_MS,
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval: POLL_INTERVAL_MS,
      statusMessage: "fail" in ref ? ref.fail : started,
    };
  }

  /** A "started" task is answered without reading the job, but only for the
   * caller's own project: another org's id is "not found", as for any task. */
  private async ownsProject(ref: JobRef): Promise<boolean> {
    try {
      await this.client.getProject(ref.project);
      return true;
    } catch (err) {
      if (err instanceof ShipdError && err.status === 404) return false;
      throw err;
    }
  }

  async getTask(taskId: string): Promise<Task | null> {
    const ref = decodeBuildId(taskId);
    if (!ref) return null;
    if ("ack" in ref && ref.ack) {
      if (!(await this.ownsProject(ref))) return null;
      const at = new Date(ref.t).toISOString();
      return toTask(taskId, ref, { status: "completed", message: "Started.", updatedAt: at });
    }
    const state = await readBuild(this.client, ref);
    return state ? toTask(taskId, ref, state) : null;
  }

  async getTaskResult(taskId: string): Promise<Result> {
    const ref = decodeBuildId(taskId);
    if (ref && "ack" in ref && ref.ack) {
      if (!(await this.ownsProject(ref))) throw new Error("Build not found.");
      return startedResult(ref);
    }
    const state = ref ? await readBuild(this.client, ref) : null;
    if (!ref || !state) throw new Error("Build not found.");
    if (state.status === "working") throw new Error("The build is still running.");
    return buildResult(this.client, this.appUrl, taskId, ref, state);
  }

  async storeTaskResult(): Promise<void> {
    // Results are read from Shipd, never stored here.
  }

  async updateTaskStatus(taskId: string, status: Task["status"]): Promise<void> {
    // The only transition a client can ask for is cancel; Shipd owns the rest.
    if (status !== "cancelled") return;
    const ref = decodeBuildId(taskId);
    if (ref && "job" in ref) await cancelBuild(this.client, ref);
  }

  async listTasks(): Promise<{ tasks: Task[]; nextCursor?: string }> {
    // Not advertised (no `tasks.list` capability): there is no build index to list.
    return { tasks: [] };
  }
}

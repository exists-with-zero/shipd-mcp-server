// The Shipd MCP server: tools that build and change real apps in the caller's
// Shipd account. One server (and one task store) per HTTP request, bound to
// that request's Shipd API token; see http.ts.

import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  appLink,
  buildResult,
  cancelBuild,
  decodeBuildId,
  failedRef,
  readBuild,
  ShipdTaskStore,
  type BuildKind,
  type BuildRef,
} from "./builds.js";

/** A client that did not ask for a task gets a task born completed, whose
 * result says "started" with the id to follow (see `ack` in builds.ts),
 * instead of a call held open for the whole build. */
function forCaller(ref: BuildRef): BuildRef {
  return "job" in ref && !askedForTask() ? { ...ref, ack: 1 } : ref;
}
import { askBeforeBuilding } from "./ask.js";
import { CARD_URI, cardHtml, cardMeta, cardUri } from "./card.js";
import { askedForTask } from "./scope.js";
import { ShipdClient, ShipdError } from "./shipd.js";
import { registerStaffTools } from "./staff.js";

export const SERVER_VERSION = "0.1.0";

function instructions(host: string): string {
  return `Shipd builds real, working web apps from a description and changes them on request.
Replies are often spoken aloud, so keep what you say short: one or two sentences, no markdown, no reading out ids or long links unless asked.
Builds take a few minutes. build_app, build_with_team and edit_app run as tasks: start one, tell the person it has started, and report back when it finishes. If you call them without a task, they answer at once that the build has started, with a build_id: follow it with check_build (every 20 seconds or so, or whenever the person asks) and tell them when it is ready. Where the host shows it, a live card follows the build on its own. While build_with_team runs, the task's status message is what the team just did ("Ren designed 3 screens"); read each new one out. check_build also returns the team's own words (voice): pass each new line on once, with the person's name ("Maya: It's for walk-in clients."). If the task finishes while they are away, check_build with the build id tells you where it got to. While build_with_team runs, if the person speaks to a team member by name (Maya, Theo, Ren, Devin or Sam) or asks to change something in the app being built, call tell_team with the build_id, then pass on that person's answer with their name. When a build is ready, say so in a sentence and offer to open it (get_app_link) or share it (share_app). In a spoken conversation (voice mode, no card), keep the person company while the team builds: call watch_build in a loop and say each new line in a few words with the speaker's name ("Maya says it's for walk-in clients."), until the build is ready; if the person speaks, answer them first. A spoken conversation shows no card, so when a team build starts, tell them once that they can watch the team work at ${host}/live on any screen where they are signed in to Shipd.
Use build_with_team when the person wants the full product team (a plan, a design direction and designed screens before the build) or asks for "the team"; use build_app for a quick build. With build_with_team, set backend when the app has to remember things between visits (bookings, orders, accounts, sign-in): Devin, the Backend Engineer, then builds its database and API before Sam builds the screens.
When the person wants to show the app to someone else, use share_app: its link opens for anyone, no account needed; stop_sharing turns its links off. get_app_link opens the app in Shipd for the person themselves.
Before build_app or build_with_team: if the person has not said who the app is for or what it must do, ask them one quick question first, offering two or three likely answers ("Who is it for, and what must it have? For example walk-in clients, online booking, a price list."), then build with their reply as answers. Do not ask if they already said, or told you to just build it; then pass answers "skip". With answers given, Shipd will not ask again; without them, a host that shows forms may get Shipd's own question instead.`;
}

/** The client abandoned the call (for instance while a question was open):
 * build nothing, since nobody would ever hear about it. */
function gaveUp(kind: BuildKind): BuildRef {
  return failedRef(kind, "Stopped before the build started.");
}

/** The description plus what the person added when asked. */
function withAnswers(description: string, answers: string): string {
  return answers ? `${description}\n\n${answers}` : description;
}

/** What the person added, without a plain "skip" (it means "don't ask", not
 * something to build). */
function added(answers: string | undefined): string {
  const a = (answers ?? "").trim();
  return SKIPPED.test(a) ? "" : a;
}
const SKIPPED = /^(skip|skipped|none|no|nothing|you decide|just build( it)?|no preference)[.!]?$/i;

function text(message: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function spoken(err: unknown): string {
  return err instanceof ShipdError ? err.message : "Something went wrong talking to Shipd.";
}

function failure(err: unknown): CallToolResult {
  return { content: [{ type: "text", text: spoken(err) }], isError: true };
}

/** "A", "A and B", "A, B and C": how a list sounds read aloud. */
export function spokenList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A placeholder name from the description. Shipd renames the project from
 * the app it actually built, unless the person named it themselves. */
export function nameFromDescription(description: string): string {
  const words = description
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return (name || "New App").slice(0, 60);
}

// Answers that prove the work did NOT start: Shipd looked at the request and
// said no. A timeout or a 5xx proves nothing (the job may be running), so on
// those the project is kept.
const REFUSED = new Set([400, 401, 402, 403, 404, 409, 422, 429]);

const MAYBE_STARTED =
  "I couldn't confirm the build started. It may still be running, so check your Shipd apps in a minute before trying again.";

/** Create a project and start work on it. If Shipd refuses the work (a plan
 * limit, a rate limit), the project this call just made is removed again, so
 * a refused build never leaves an empty app behind, and the refusal comes
 * back as a build that is born failed, carrying Shipd's own sentence. The
 * project is only ever removed when no work on it can be running. */
async function startInNewProject(
  client: ShipdClient,
  kind: BuildKind,
  description: string,
  name: string | undefined,
  start: (projectId: string) => Promise<string>,
  backend?: string,
): Promise<BuildRef> {
  let projectId: string | null = null;
  let asked = false; // has the start request been sent?
  try {
    const project = await client.createProject(name?.trim() || nameFromDescription(description), backend);
    projectId = project.id;
    if (name?.trim()) await client.renameProject(project.id, name.trim());
    asked = true;
    const job = await start(project.id);
    return { v: 1, kind, job, project: project.id, prev: 0, t: Date.now() };
  } catch (err) {
    const refused = err instanceof ShipdError && REFUSED.has(err.status);
    if (projectId && (!asked || refused)) {
      try {
        await client.deleteProject(projectId);
      } catch {
        // best effort: the refusal is what the person needs to hear
      }
    }
    return failedRef(kind, asked && !refused ? MAYBE_STARTED : spoken(err));
  }
}

export interface ServerOptions {
  /** A call from Shipd's own voice page, which speaks the team's lines itself
   * and whose backend accepts only the nine tools it knows: no watch_build or
   * speak_line for it. */
  shipdPage?: boolean;
}

/** The voices speak_line knows (Shipd's /voice/speak picks the Polly voice). */
// "specialist": someone the person hired (a team build's "custom:" rooms).
const SPEAKERS = ["assistant", "pm", "director", "designer", "backend", "engineer", "specialist"] as const;

/** Where the person can watch their team build (Shipd's /live page), as
 * said aloud: "theshipd.com", without the https. */
function watchHost(appUrl: string): string {
  try {
    return new URL(appUrl).host;
  } catch {
    return "theshipd.com";
  }
}

export function createShipdServer(client: ShipdClient, appUrl: string, opts: ServerOptions = {}): McpServer {
  const taskStore = new ShipdTaskStore(client, appUrl);
  const server = new McpServer(
    { name: "shipd", title: "Shipd", version: SERVER_VERSION },
    {
      capabilities: {
        tasks: { cancel: {}, requests: { tools: { call: {} } } },
      },
      taskStore,
      instructions: instructions(watchHost(appUrl)),
    },
  );

  // The live build card (MCP Apps). Hosts without MCP Apps never read it.
  // The same page at two addresses: the fixed one the voice page reads, and
  // the one named after its content that the build tools point to (see cardUri).
  for (const [name, uri] of [
    ["Shipd build card", cardUri()],
    ["Shipd build card (fixed address)", CARD_URI],
  ]) {
    registerAppResource(
      server,
      name,
      uri,
      { description: "Live progress of a Shipd build: the AI Team at work, then the finished app." },
      async () => ({
        contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: cardHtml(), _meta: { ui: { prefersBorder: false } } }],
      }),
    );
  }

  server.registerTool(
    "list_apps",
    {
      title: "List my apps",
      description: "List the apps in the person's Shipd account, newest first (up to 20).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        // The total is every app, not the 20 newest that come back.
        const { total, projects } = await client.recentProjects(20);
        const apps = projects.slice(0, 20).map((p) => ({ id: p.id, name: p.name, created_at: p.created_at }));
        if (total === 0) return text("You don't have any apps yet.", { total, apps });
        const names = spokenList(apps.slice(0, 5).map((a) => a.name));
        const said =
          total <= 5
            ? `You have ${total} app${total === 1 ? "" : "s"}: ${names}.`
            : `You have ${total} apps. The newest are ${names}.`;
        return text(said, { total, apps });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.experimental.tasks.registerToolTask(
    "build_app",
    {
      title: "Build a new app",
      description:
        "Build a new web app from a plain-language description, as a new project in the person's Shipd account. Takes a few minutes; runs as a task. If the request does not say who the app is for or what it must do, ask the person first and pass their reply as answers.",
      inputSchema: {
        description: z
          .string()
          .min(3)
          .max(4000)
          .describe("What the app is for, who uses it and what it should do, in the person's words."),
        name: z.string().min(1).max(80).optional().describe("A name, only if the person gave one."),
        answers: z
          .string()
          .max(2000)
          .optional()
          .describe(
            'What the person said when you asked who it is for and what it must have (ask first when their request does not say), or "skip" if they want you to just build it.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: "optional" },
      _meta: cardMeta(),
    },
    {
      async createTask({ description, name, answers }, extra) {
        const asked = await askBeforeBuilding(server, client, extra, description, answers);
        const prompt = withAnswers(description, [added(answers), asked].filter(Boolean).join(" "));
        const ref = extra.signal.aborted
          ? gaveUp("build")
          : forCaller(
              await startInNewProject(client, "build", description, name, (id) => client.startGenerate(id, prompt)),
            );
        const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl, context: ref });
        return { task };
      },
      async getTask(_args, extra) {
        return extra.taskStore.getTask(extra.taskId);
      },
      async getTaskResult(_args, extra) {
        return (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult;
      },
    },
  );

  server.experimental.tasks.registerToolTask(
    "build_with_team",
    {
      title: "Build with the AI Team",
      description:
        "Build a new app with Shipd's AI product team: Maya (product manager) writes the plan, Theo (design director) sets the look, Ren (designer) designs the screens, Devin (backend engineer) builds the database and API when the app has a backend, and Sam (engineer) builds it. Slower than build_app (10 to 20 minutes with a backend) and runs as a task; each status message is what the team just did, written to be read aloud. If the request does not say who the app is for or what it must do, ask the person first and pass their reply as answers.",
      inputSchema: {
        description: z
          .string()
          .min(3)
          .max(4000)
          .describe("What the app is for, who uses it and what it should do, in the person's words."),
        name: z.string().min(1).max(80).optional().describe("A name, only if the person gave one."),
        answers: z
          .string()
          .max(2000)
          .optional()
          .describe(
            'What the person said when you asked who it is for and what it must have (ask first when their request does not say), or "skip" if they want you to just build it.',
          ),
        backend: z
          .boolean()
          .optional()
          .describe(
            "True when the app has to remember things between visits (bookings, orders, accounts, sign-in): Devin builds a real database and API (Node) first. Leave out for a site that only shows information.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: "optional" },
      _meta: cardMeta(),
    },
    {
      async createTask({ description, name, answers, backend }, extra) {
        const asked = await askBeforeBuilding(server, client, extra, description, answers);
        const told = [added(answers), asked].filter(Boolean).join(" ") || undefined;
        const ref = extra.signal.aborted
          ? gaveUp("team")
          : forCaller(
              await startInNewProject(
                client,
                "team",
                description,
                name,
                async (id) => {
                  try {
                    return await client.startTeamJob(id, description, told);
                  } catch (err) {
                    // Only the switch's own 404 ("Not found"), not "Project not found".
                    if (err instanceof ShipdError && err.status === 404 && err.detail === "Not found") {
                      throw new ShipdError(404, "The AI Team isn't switched on for your Shipd account yet. I can do a quick build instead.");
                    }
                    throw err;
                  }
                },
                backend ? "node" : undefined,
              ),
            );
        const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl, context: ref });
        return { task };
      },
      async getTask(_args, extra) {
        return extra.taskStore.getTask(extra.taskId);
      },
      async getTaskResult(_args, extra) {
        return (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult;
      },
    },
  );

  server.experimental.tasks.registerToolTask(
    "edit_app",
    {
      title: "Change an app",
      description:
        "Change an existing app: new features, fixes, colours, copy. Works on the latest saved version. Takes a minute or two; runs as a task.",
      inputSchema: {
        app_id: z.string().uuid().describe("The app's id, from list_apps."),
        change: z.string().min(3).max(4000).describe("The change, in the person's words."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: "optional" },
      _meta: cardMeta(),
    },
    {
      async createTask({ app_id, change }, extra) {
        let ref: BuildRef;
        try {
          const project = await client.getProject(app_id);
          const versions = await client.listVersions(app_id);
          const prev = versions.reduce((m, v) => Math.max(m, v.version_num), 0);
          if (prev === 0) {
            throw new ShipdError(409, `${project.name} has no build yet. Ask me to build it first.`);
          }
          const stack = ["node", "python", "csharp", "java"].includes(project.backend ?? "") ? project.backend : "";
          const job = await client.startGenerate(app_id, change, project.framework || "react", stack);
          ref = forCaller({ v: 1, kind: "edit", job, project: app_id, prev, t: Date.now() });
        } catch (err) {
          ref = failedRef("edit", spoken(err));
        }
        const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl, context: ref });
        return { task };
      },
      async getTask(_args, extra) {
        return extra.taskStore.getTask(extra.taskId);
      },
      async getTaskResult(_args, extra) {
        return (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult;
      },
    },
  );

  server.registerTool(
    "check_build",
    {
      title: "Check on a build",
      description: "Where a build or edit has got to, by its build id (the task id build_app or edit_app returned).",
      inputSchema: { build_id: z.string().min(1).max(600) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ build_id }) => {
      const ref = decodeBuildId(build_id);
      if (!ref) return failure(new ShipdError(404, "I don't recognise that build."));
      try {
        const state = await readBuild(client, ref);
        if (!state) {
          // The job record is gone (Shipd keeps one for an hour) or was never
          // ours. If the app has a newer version than when the build began,
          // the build saved it: that is the result, for a chat reopened later.
          if ("job" in ref) {
            try {
              const versions = await client.listVersions(ref.project);
              const newest = versions.reduce((a, v) => (v.version_num > a.version_num ? v : a), { version_num: 0 } as { version_num: number; created_at?: string });
              if (newest.version_num > ref.prev) {
                return await buildResult(client, appUrl, build_id, ref, {
                  status: "completed",
                  message: "Your app is ready.",
                  version: newest.version_num,
                  updatedAt: newest.created_at || new Date(ref.t).toISOString(),
                });
              }
            } catch {
              // another org's project or Shipd unreachable: fall through
            }
          }
          // Not "failed": the card says so instead of calling a shipped app a failure.
          const said = "I can't see that build any more. It may have finished a while ago; ask me to list your apps.";
          return { ...text(said, { build_id, kind: ref.kind, status: "unknown", message: said }), isError: true };
        }
        if (state.status === "working") {
          const app = "project" in ref ? { app_id: ref.project } : {};
          return text(state.message, {
            build_id,
            kind: ref.kind,
            started_at: ref.t,
            updated_at: state.updatedAt,
            status: state.status,
            ...app,
            message: state.message,
            ...(state.chars !== undefined ? { chars: state.chars } : {}),
            ...(state.stage !== undefined ? { stage: state.stage } : {}),
            ...(state.stages ? { stages: state.stages } : {}),
            ...(state.voice ? { voice: state.voice, voice_total: state.voice_total } : {}),
          });
        }
        return await buildResult(client, appUrl, build_id, ref, state);
      } catch (err) {
        return failure(err);
      }
    },
  );

  // Hands-free, for a spoken conversation (Claude's voice mode has no card and
  // speaks only after the person does): each call waits for the team's next
  // lines and returns them, so the assistant can say them and call again,
  // narrating the build until it is ready without being asked.
  if (!opts.shipdPage) server.registerTool(
    "watch_build",
    {
      title: "Listen to a build",
      description:
        "For a spoken conversation: wait up to 40 seconds for what the AI Team says next on a build, and get their new lines. Pass heard = the voice_total from your last call (0 the first time). After build_with_team in a voice conversation, call this again and again, saying each new line in a few words with the speaker's name, until status is completed or failed; if the person says something, answer them first.",
      inputSchema: {
        build_id: z.string().min(1).max(600),
        heard: z.number().int().min(0).max(100000).optional().describe("voice_total from the last call; 0 or left out the first time."),
        wait_seconds: z.number().int().min(5).max(40).optional().describe("How long to wait for something new (default 30)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ build_id, heard = 0, wait_seconds = 30 }, extra) => {
      const ref = decodeBuildId(build_id);
      if (!ref) return failure(new ShipdError(404, "I don't recognise that build."));
      const until = Date.now() + wait_seconds * 1000;
      try {
        for (;;) {
          const state = await readBuild(client, ref);
          if (!state) {
            const said = "I can't see that build any more. Ask me to list your apps.";
            return { ...text(said, { build_id, status: "unknown", new_lines: [], voice_total: heard }), isError: true };
          }
          const total = state.voice_total ?? 0;
          const fresh = Math.max(0, total - heard);
          // slice(-0) would be the whole list: nothing new must mean nothing.
          const lines = fresh > 0 ? (state.voice ?? []).slice(-Math.min(fresh, (state.voice ?? []).length)) : [];
          const done = state.status !== "working";
          if (lines.length || done || Date.now() >= until || extra.signal.aborted) {
            const spokenLines = lines.map((l) => `${l.name}: ${l.text}`);
            // The first call of a team build: no card in a spoken conversation,
            // so the person hears where to see the team.
            const watch =
              heard === 0 && !done && ref.kind === "team"
                ? [`If you have not said it yet, tell them once they can watch the team work at ${watchHost(appUrl)}/live.`]
                : [];
            const ending = done
              ? state.status === "completed"
                ? "The app is ready. Offer to open it (get_app_link) or share it."
                : state.message
              : lines.length
                ? "Say these, then call watch_build again with heard set to voice_total."
                : "Nothing new yet; the team is still working. Call watch_build again.";
            return text([...spokenLines, ending, ...watch].join("\n"), {
              build_id,
              status: state.status,
              new_lines: lines,
              voice_total: Math.max(total, heard),
              ...(state.stage !== undefined ? { stage: state.stage } : {}),
              ...(done && "project" in ref ? { app_id: ref.project } : {}),
            });
          }
          await new Promise((r) => setTimeout(r, Math.min(4000, Math.max(0, until - Date.now()))));
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  // For the build card's Listen button: one line in that person's own voice,
  // the same Amazon Polly voices as the voice page (Maya Joanna, Theo Matthew,
  // Ren Ruth, Devin Gregory, Sam Stephen). Only the card may call it (MCP Apps
  // visibility "app"), so the model never sees it. It goes through Shipd's
  // /voice/speak with the caller's own token: voice must be on for their
  // account, and Shipd's rate and daily character limits apply.
  if (!opts.shipdPage) server.registerTool(
    "speak_line",
    {
      title: "Say a team line",
      description: "For Shipd's build card: one AI Team line as audio, in that person's own voice.",
      inputSchema: {
        voice: z.enum(SPEAKERS),
        text: z.string().min(1).max(300),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ voice, text: line }) => {
      try {
        const mp3 = await client.speak(voice, line);
        return { content: [{ type: "audio", data: Buffer.from(mp3).toString("base64"), mimeType: "audio/mpeg" }] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "cancel_build",
    {
      title: "Stop a build",
      description: "Stop a build or edit that is still running. Nothing from it is saved.",
      inputSchema: { build_id: z.string().min(1).max(600) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ build_id }) => {
      const ref = decodeBuildId(build_id);
      if (!ref) return failure(new ShipdError(404, "I don't recognise that build."));
      if (!("job" in ref)) return text("That build never started, so there is nothing to stop.");
      try {
        const stopped = await cancelBuild(client, ref);
        return text(stopped ? "Stopped. Nothing from that build was saved." : "That build had already finished.", {
          build_id,
          cancelled: stopped,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  // Talking to the team mid-build: offered everywhere, Shipd's voice page
  // included (its backend knows this tool).
  server.registerTool(
    "tell_team",
    {
      title: "Talk to the team",
      description:
        "While an AI Team build (build_with_team) is running: pass what the person says to one team member by name (Maya the product manager, Theo the design director, Ren the designer, Devin the backend engineer, Sam the engineer), or to the team. The note goes into the rest of the build, and that person answers in their own words: pass their answer on with their name. Once the build is ready, use edit_app for changes instead.",
      inputSchema: {
        build_id: z.string().min(1).max(600),
        to: z.string().min(1).max(40).describe('The team member\'s name ("Theo"), or "team".'),
        note: z.string().min(1).max(500).describe("What the person said, in their words."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ build_id, to, note }) => {
      const ref = decodeBuildId(build_id);
      if (!ref || !("job" in ref) || ref.kind !== "team") {
        return failure(new ShipdError(404, "That isn't a running team build, so there's nobody to pass it to."));
      }
      try {
        const r = await client.noteTeamJob(ref.job, to, note);
        return text(`${r.name}: ${r.reply}`, { build_id, to: r.to, name: r.name, reply: r.reply, taken: r.taken, by: r.by });
      } catch (err) {
        // Only the switch's own 404 ("Not found"), not "Team job not found."
        if (err instanceof ShipdError && err.status === 404 && err.detail === "Not found") {
          return failure(new ShipdError(404, "Talking to the team during a build isn't switched on for your Shipd account yet."));
        }
        return failure(err);
      }
    },
  );

  // Hiring, interviewing and letting people go: the Team office by conversation.
  registerStaffTools(server, client);

  server.registerTool(
    "share_app",
    {
      title: "Share an app",
      description:
        "A public link to an app that anyone can open in their browser without a Shipd account. They can't change the app, but if it has sign-in, a database or uploads, they use its real data, like a deployed app. It shows the latest saved version; after a change, share again for a new link.",
      inputSchema: { app_id: z.string().uuid().describe("The app's id, from list_apps.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id }) => {
      try {
        const project = await client.getProject(app_id);
        const share = await client.createShare(app_id);
        const held = share.withheld ?? [];
        const liveData = share.live_data === true;
        const note =
          (liveData ? " People with the link use this app's real data, like a deployed app." : "") +
          (held.length
            ? ` I left out ${held.length} ${held.length === 1 ? "file that looks" : "files that look"} like secrets.`
            : "");
        return text(`Here's a link anyone can open: ${share.url}${note}`, {
          app_id,
          app_name: project.name,
          version: share.version_num,
          link: share.url,
          withheld: held,
          live_data: liveData,
        });
      } catch (err) {
        if (err instanceof ShipdError && err.status === 404 && err.detail === "Not found") {
          return failure(new ShipdError(404, "Sharing isn't switched on for your Shipd account yet."));
        }
        return failure(err);
      }
    },
  );

  server.registerTool(
    "stop_sharing",
    {
      title: "Stop sharing an app",
      description: "Turn off every public share link to an app. Anyone who opens one afterwards sees that it no longer works.",
      inputSchema: { app_id: z.string().uuid().describe("The app's id, from list_apps.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ app_id }) => {
      try {
        const n = await client.stopSharing(app_id);
        return text(
          n === 0 ? "That app wasn't shared." : `Done. ${n === 1 ? "Its share link is" : `All ${n} share links are`} off.`,
          { app_id, revoked: n },
        );
      } catch (err) {
        if (err instanceof ShipdError && err.status === 404 && err.detail === "Not found") {
          return failure(new ShipdError(404, "Sharing isn't switched on for your Shipd account yet."));
        }
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_app_link",
    {
      title: "Get an app's link",
      description: "The link that opens an app in Shipd, where the person can see it running and keep changing it.",
      inputSchema: { app_id: z.string().uuid().describe("The app's id, from list_apps.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app_id }) => {
      try {
        const project = await client.getProject(app_id);
        const link = appLink(appUrl, project.id);
        return text(`Here's ${project.name}: ${link}`, { app_id: project.id, app_name: project.name, link });
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

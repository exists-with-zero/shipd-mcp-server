// End to end over real HTTP: the official MCP client talks to this server,
// which talks to a fake Shipd backend. The fake keeps the backend's own rules
// that matter here: each token belongs to one org, and another org's projects
// and jobs are a 404.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

import { decodeBuildId, encodeBuildId } from "../src/builds.js";
import { createApp } from "../src/http.js";
import { nameFromDescription, spokenList } from "../src/server.js";

const TOKEN_A = "shp_" + "a".repeat(43);
const TOKEN_B = "shp_" + "b".repeat(43);
// A signed-in Shipd session (JWT-shaped), as the voice page sends it.
const SESSION_A = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEifQ.c2lnbmF0dXJlLWZvci10ZXN0cw";

interface FakeJob {
  org: string;
  project: string;
  status: "running" | "done" | "error";
  chars: number;
  updated_at: number;
  error?: string;
  // team jobs only
  team?: boolean;
  stage?: string | null;
  stages?: { key: string; name: string; title: string; status: string }[];
  lines?: string[];
  voice?: { key: string; name: string; text: string }[];
  voice_total?: number;
  base_version?: number;
}

const fake = {
  orgOf: { [TOKEN_A]: "org-a", [TOKEN_B]: "org-b", [SESSION_A]: "org-a" } as Record<string, string>,
  projects: [] as { id: string; name: string; org: string; framework: string; backend?: string }[],
  versions: {} as Record<string, number[]>,
  jobs: {} as Record<string, FakeJob>,
  projectLimit: Infinity,
  cancels: [] as string[],
  auth: [] as string[],
  deleted: [] as string[],
  teamOff: false,
  notesOff: false,
  notes: [] as { job: string; to: string; text: string }[],
  tokensOut: false,
  // the start request reached Shipd and the job began, then the answer failed
  startCrash: false,
  // the team job answers "Project not found" (a 404 that is not the switch's)
  teamProjectMissing: false,
  shareOff: false,
  shares: [] as { project: string; version: number; token: string }[],
  withheld: [] as string[],
  liveData: false,
  prompts: [] as string[],
  teamAnswers: [] as (string | undefined)[],
  clarifyCalls: [] as string[],
  clarifyFail: false,
  // an older Shipd without /projects/recent; and how often the full list was read
  noRecent: false,
  fullLists: 0,
  stacks: [] as string[], // the backend each generate job was asked for
  voiceOff: false,
  spoken: [] as string[],
  // staffing: per org, hired agents and their seats, and who was let go
  agentsOff: false,
  agentsPaid: false, // writes refused like a free plan
  agents: [] as { id: string; org: string; name: string; title: string; color: string; blurb: string; instructions: string; mode: string }[],
  slots: [] as { org: string; agent: string; anchor: string; project: string | null }[],
  fired: [] as { org: string; role: string; project: string | null }[],
  interviews: [] as { org: string; name: string; title: string; instructions: string; question: string; history: unknown[] }[],
};

function resetFake() {
  fake.agentsOff = false;
  fake.agentsPaid = false;
  fake.agents = [];
  fake.slots = [];
  fake.fired = [];
  fake.interviews = [];
  fake.voiceOff = false;
  fake.spoken = [];
  fake.noRecent = false;
  fake.fullLists = 0;
  fake.stacks = [];
  fake.projects = [];
  fake.versions = {};
  fake.jobs = {};
  fake.notes = [];
  fake.projectLimit = Infinity;
  fake.cancels = [];
  fake.auth = [];
  fake.deleted = [];
  fake.teamOff = false;
  fake.tokensOut = false;
  fake.startCrash = false;
  fake.teamProjectMissing = false;
  fake.shareOff = false;
  fake.shares = [];
  fake.withheld = [];
  fake.liveData = false;
  fake.prompts = [];
  fake.teamAnswers = [];
  fake.clarifyCalls = [];
  fake.clarifyFail = false;
}

function fakeBackend() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    fake.auth.push(token);
    const org = fake.orgOf[token];
    if (!org) return void res.status(401).json({ detail: "Invalid or expired token" });
    res.locals.org = org;
    next();
  });
  const own = (req: express.Request, res: express.Response) =>
    fake.projects.find((p) => p.id === req.params.id && p.org === res.locals.org);

  // ── the Team office ───────────────────────────────────────────────────
  const FIVE = [
    ["pm", "Maya", "Product Manager"],
    ["director", "Theo", "UI/UX Director"],
    ["designer", "Ren", "UI/UX Designer"],
    ["backend", "Devin", "Backend Engineer"],
    ["engineer", "Sam", "Frontend Engineer"],
    ["forward", "Kai", "Forward Engineer"],
  ];
  const COLORS = ["#2A6F97", "#9D4E15", "#6D28D9", "#0F766E"];
  const agentsGate = (res: express.Response, write: boolean) => {
    if (fake.agentsOff) return void res.status(404).json({ detail: "Custom agents are not enabled." }), true;
    if (write && fake.agentsPaid) return void res.status(402).json({ detail: "Hiring specialists is on paid plans. Upgrade to hire." }), true;
    return false;
  };
  app.get("/api/v1/team/roster", (req, res) => {
    if (agentsGate(res, false)) return;
    const org = res.locals.org;
    const project = typeof req.query.project_id === "string" ? req.query.project_id : null;
    const firedRoles = new Set(fake.fired.filter((f) => f.org === org && (f.project === null || f.project === project)).map((f) => f.role));
    const seats = fake.slots.filter((s) => s.org === org && (s.project === null || s.project === project));
    const pipeline: Record<string, unknown>[] = [];
    for (const [key, name, title] of FIVE) {
      if (!firedRoles.has(key)) pipeline.push({ key, kind: "default", name, title, color: "", does: "" });
      for (const seat of seats.filter((x) => x.anchor === key)) {
        const a = fake.agents.find((x) => x.id === seat.agent)!;
        pipeline.push({ key: `custom:${a.id}`, kind: "custom", agentId: a.id, name: a.name, title: a.title, color: a.color, does: a.blurb, mode: a.mode, anchor: key, scope: seat.project ? "project" : "org" });
      }
    }
    const seated = new Set(seats.map((x) => x.agent));
    res.json({
      pipeline,
      fired: FIVE.filter(([k]) => firedRoles.has(k)).map(([key, name, title]) => ({ key, name, title, color: "", does: "" })),
      benched: fake.agents.filter((a) => a.org === org && !seated.has(a.id)),
      roles: {},
      agents: fake.agents.filter((a) => a.org === org),
      members: [{ user_id: "u1", name: "Owner", email: "owner@example.com" }],
      colors: COLORS,
      models: [],
    });
  });
  app.post("/api/v1/team/agents/interview", (req, res) => {
    if (agentsGate(res, true)) return;
    fake.interviews.push({ org: res.locals.org, ...req.body });
    res.json({ answer: `I'd keep it warm and short. ${String(req.body.question).slice(0, 40)}` });
  });
  app.post("/api/v1/team/agents", (req, res) => {
    if (agentsGate(res, true)) return;
    const a = { id: randomUUID(), org: res.locals.org, mode: "deliverable", ...req.body };
    fake.agents.push(a);
    res.json(a);
  });
  app.put("/api/v1/team/agents/slots", (req, res) => {
    if (agentsGate(res, true)) return;
    const org = res.locals.org;
    const { agent_id, anchor, project_id } = req.body;
    if (!fake.agents.some((a) => a.id === agent_id && a.org === org)) return void res.status(422).json({ detail: "No such agent." });
    fake.slots = fake.slots.filter((x) => !(x.org === org && x.agent === agent_id && x.project === (project_id ?? null)));
    if (anchor) fake.slots.push({ org, agent: agent_id, anchor, project: project_id ?? null });
    res.json({ ok: true, anchor: anchor ?? null });
  });
  app.put("/api/v1/team/defaults/seat", (req, res) => {
    if (agentsGate(res, false)) return;
    const org = res.locals.org;
    const { role, fired, project_id } = req.body;
    if (!FIVE.some(([k]) => k === role)) return void res.status(422).json({ detail: "Unknown role." });
    fake.fired = fake.fired.filter((f) => !(f.org === org && f.role === role && f.project === (project_id ?? null)));
    if (fired) fake.fired.push({ org, role, project: project_id ?? null });
    res.json({ ok: true, role, fired });
  });

  app.post("/api/v1/voice/speak", (req, res) => {
    if (fake.voiceOff) return void res.status(404).json({ detail: "Not found" });
    fake.spoken.push(`${req.body.voice}: ${req.body.text}`);
    res.type("audio/mpeg").send(Buffer.from("ID3-fake-mp3"));
  });
  app.get("/api/v1/me/entitlements", (_req, res) => {
    res.json({ plan: "pro" });
  });
  app.get("/api/v1/projects", (_req, res) => {
    fake.fullLists += 1;
    res.json(fake.projects.filter((p) => p.org === res.locals.org).slice().reverse());
  });
  app.get("/api/v1/projects/recent", (req, res, next) => {
    if (fake.noRecent) return next(); // falls to /projects/:id, like an older Shipd
    const mine = fake.projects.filter((p) => p.org === res.locals.org).slice().reverse();
    res.json({ total: mine.length, projects: mine.slice(0, Number(req.query.limit) || 20) });
  });
  app.post("/api/v1/projects", (req, res) => {
    const mine = fake.projects.filter((p) => p.org === res.locals.org);
    if (mine.length >= fake.projectLimit) {
      return void res.status(403).json({ detail: "The free plan allows 3 projects. Upgrade to add more." });
    }
    const p = {
      id: randomUUID(),
      name: req.body.name,
      org: res.locals.org,
      framework: req.body.framework,
      ...(req.body.backend ? { backend: req.body.backend } : {}),
    };
    fake.projects.push(p);
    res.status(201).json(p);
  });
  app.get("/api/v1/projects/:id", (req, res) => {
    const p = own(req, res);
    if (!p) return void res.status(404).json({ detail: "Project not found" });
    res.json(p);
  });
  app.patch("/api/v1/projects/:id", (req, res) => {
    const p = own(req, res);
    if (!p) return void res.status(404).json({ detail: "Project not found" });
    p.name = req.body.name;
    res.json(p);
  });
  app.get("/api/v1/projects/:id/versions", (req, res) => {
    if (!own(req, res)) return void res.status(404).json({ detail: "Project not found" });
    const nums = fake.versions[req.params.id] || [];
    res.json({ versions: nums.map((n) => ({ id: `v${n}`, version_num: n })).reverse(), plan: "pro" });
  });
  app.delete("/api/v1/projects/:id", (req, res) => {
    if (!own(req, res)) return void res.status(404).json({ detail: "Project not found" });
    fake.deleted.push(req.params.id);
    fake.projects = fake.projects.filter((p) => p.id !== req.params.id);
    res.status(204).end();
  });
  app.post("/api/v1/projects/:id/share", (req, res) => {
    if (fake.shareOff) return void res.status(404).json({ detail: "Not found" });
    if (!own(req, res)) return void res.status(404).json({ detail: "Project not found" });
    const nums = fake.versions[req.params.id] || [];
    if (!nums.length) return void res.status(409).json({ detail: "This app has no saved version to share yet." });
    const version = nums.at(-1)!;
    let s = fake.shares.find((x) => x.project === req.params.id && x.version === version);
    if (!s) {
      s = { project: req.params.id, version, token: randomUUID().replace(/-/g, "").slice(0, 22) };
      fake.shares.push(s);
    }
    res.json({ id: randomUUID(), token: s.token, url: `https://shipd.test/s/${s.token}`, version_num: version, withheld: fake.withheld, live_data: fake.liveData });
  });
  app.delete("/api/v1/projects/:id/shares", (req, res) => {
    if (fake.shareOff) return void res.status(404).json({ detail: "Not found" });
    if (!own(req, res)) return void res.status(404).json({ detail: "Project not found" });
    const before = fake.shares.length;
    fake.shares = fake.shares.filter((x) => x.project !== req.params.id);
    res.json({ revoked: before - fake.shares.length });
  });
  app.post("/api/v1/team/job", (req, res) => {
    if (fake.teamOff) return void res.status(404).json({ detail: "Not found" });
    if (fake.teamProjectMissing) return void res.status(404).json({ detail: "Project not found" });
    const p = fake.projects.find((x) => x.id === req.body.project_id && x.org === res.locals.org);
    if (!p) return void res.status(404).json({ detail: "Project not found" });
    fake.teamAnswers.push(req.body.answers);
    const id = randomUUID();
    fake.jobs[id] = {
      org: res.locals.org, project: p.id, status: "running", chars: 0, updated_at: Date.now() / 1000,
      team: true, stage: "pm", lines: ["Maya is writing the plan."],
      stages: [
        { key: "pm", name: "Maya", title: "Product Manager", status: "working" },
        { key: "director", name: "Theo", title: "Design Director", status: "pending" },
        { key: "designer", name: "Ren", title: "Designer", status: "pending" },
        { key: "engineer", name: "Sam", title: "Frontend Engineer", status: "pending" },
      ],
    };
    res.json({ job_id: id, stages: ["pm", "director", "designer", "engineer"] });
  });
  app.get("/api/v1/team/job/:id", (req, res) => {
    const j = fake.jobs[req.params.id];
    if (!j || !j.team || j.org !== res.locals.org) return void res.status(404).json({ detail: "Team job not found." });
    res.json({ status: j.status, stage: j.stage, stages: j.stages, lines: j.lines, voice: j.voice, voice_total: j.voice_total, chars: j.chars, updated_at: j.updated_at, error: j.error, base_version: j.base_version });
  });
  app.post("/api/v1/team/job/:id/note", (req, res) => {
    if (fake.notesOff) return void res.status(404).json({ detail: "Not found" });
    const j = fake.jobs[req.params.id];
    if (!j || !j.team || j.org !== res.locals.org) return void res.status(404).json({ detail: "Team job not found." });
    if (j.status !== "running") {
      return void res.status(409).json({ detail: "The team has finished this build. Ask Shipd to change the app instead." });
    }
    fake.notes.push({ job: req.params.id, to: req.body.to, text: req.body.text });
    res.json({ to: "director", name: "Theo", reply: "Darker it is, I'll hand it to Ren and Sam.", taken: true, by: ["Ren", "Sam"] });
  });
  app.post("/api/v1/team/job/:id/cancel", (req, res) => {
    const j = fake.jobs[req.params.id];
    if (!j || !j.team || j.org !== res.locals.org || j.status !== "running") return void res.json({ cancelled: false });
    fake.cancels.push(req.params.id);
    Object.assign(j, { status: "error", error: "Stopped.", updated_at: Date.now() / 1000 });
    res.json({ cancelled: true });
  });
  app.post("/api/v1/clarify", (req, res) => {
    fake.clarifyCalls.push(req.body.prompt);
    if (fake.clarifyFail) return void res.status(500).json({ detail: "boom" });
    res.json({
      audience: ["Walk-in clients", "Regulars", "Barbers", "Shop owner"],
      features: ["Online booking", "Price list", "Opening hours", "Gallery"],
      questions: ["Do you take walk-ins?"],
    });
  });
  app.post("/api/v1/generate/job", (req, res) => {
    const p = fake.projects.find((x) => x.id === req.body.project_id && x.org === res.locals.org);
    if (!p) return void res.status(404).json({ detail: "Project not found" });
    fake.prompts.push(req.body.prompt);
    fake.stacks.push(req.body.backend ?? "");
    if (fake.tokensOut) {
      const em = String.fromCharCode(0x2014);
      return void res
        .status(402)
        .json({ detail: `You've reached your monthly token limit ${em} it resets on the 1st.` });
    }
    if (fake.startCrash) {
      const jid = randomUUID();
      fake.jobs[jid] = { org: res.locals.org, project: p.id, status: "running", chars: 0, updated_at: Date.now() / 1000 };
      return void res.status(502).json({ detail: "Bad gateway" });
    }
    const id = randomUUID();
    fake.jobs[id] = { org: res.locals.org, project: p.id, status: "running", chars: 0, updated_at: Date.now() / 1000 };
    res.json({ job_id: id });
  });
  app.get("/api/v1/generate/status/:id", (req, res) => {
    const j = fake.jobs[req.params.id];
    if (!j || j.org !== res.locals.org) return void res.status(404).json({ detail: "Build job not found." });
    res.json({ status: j.status, chars: j.chars, updated_at: j.updated_at, error: j.error, text: "", text_len: 0 });
  });
  app.post("/api/v1/generate/cancel/:id", (req, res) => {
    const j = fake.jobs[req.params.id];
    if (!j || j.org !== res.locals.org || j.status !== "running") return void res.json({ cancelled: false });
    fake.cancels.push(req.params.id);
    Object.assign(j, { status: "error", error: "Stopped.", updated_at: Date.now() / 1000 });
    res.json({ cancelled: true });
  });
  return app;
}

/** Finish a job the way the backend does: done, then the version is saved. */
function finish(jobId: string) {
  const j = fake.jobs[jobId];
  j.status = "done";
  j.updated_at = Date.now() / 1000;
  const nums = (fake.versions[j.project] ||= []);
  nums.push((nums.at(-1) ?? 0) + 1);
}

let backend: Server;
let mcp: Server;
let mcpUrl: URL;

async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: { tasks: {} } });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const first = (r.content as { type: string; text: string }[])[0];
  return { text: first?.text ?? "", result: r };
}

async function startTask(client: Client, name: string, args: Record<string, unknown>) {
  const created = await client.request(
    { method: "tools/call", params: { name, arguments: args, task: { ttl: 60_000 } } },
    CreateTaskResultSchema,
  );
  return created.task;
}

before(async () => {
  backend = await listen(fakeBackend());
  const apiUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  // Every test comes from 127.0.0.1, so the shared server's per-address limit
  // is out of the way here; "public hardening" checks the limit on its own.
  const app = createApp({
    apiUrl, appUrl: "https://shipd.test", port: 0, host: "127.0.0.1", allowedHosts: [], ratePerMin: 1_000_000,
  });
  mcp = await listen(app);
  mcpUrl = new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`);
});

after(() => {
  backend.close();
  mcp.close();
});

beforeEach(resetFake);

describe("auth", () => {
  test("no token is a 401 that names what to send", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") || "", /Bearer/);
    assert.equal(fake.auth.length, 0);
  });

  test("a bearer that is not a Shipd token never reaches Shipd", async () => {
    await assert.rejects(connect("eyJhbGciOiJFUzI1NiJ9.session.jwt"));
    assert.equal(fake.auth.length, 0);
  });

  test("the caller's own token is what Shipd sees", async () => {
    const c = await connect(TOKEN_A);
    await callText(c, "list_apps");
    assert.deepEqual(new Set(fake.auth), new Set([TOKEN_A]));
    await c.close();
  });
});

describe("tools", () => {
  test("the tool list, with build and edit as optional tasks", async () => {
    const c = await connect(TOKEN_A);
    const { tools } = await c.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), [
      "build_app",
      "build_with_team",
      "cancel_build",
      "check_build",
      "edit_app",
      "fire_teammate",
      "get_app_link",
      "hire_specialist",
      "interview_candidate",
      "list_apps",
      "rehire_teammate",
      "share_app",
      "speak_line",
      "stop_sharing",
      "team_roster",
      "tell_team",
      "watch_build",
    ]);
    // Only the card may call speak_line; the model never sees it.
    assert.deepEqual((byName.speak_line._meta as { ui?: { visibility?: string[] } }).ui?.visibility, ["app"]);
    assert.equal(byName.watch_build.annotations?.readOnlyHint, true);
    assert.equal(byName.build_app.execution?.taskSupport, "optional");
    assert.equal(byName.edit_app.execution?.taskSupport, "optional");
    assert.equal(byName.build_with_team.execution?.taskSupport, "optional");
    assert.equal(byName.list_apps.annotations?.readOnlyHint, true);
    await c.close();
  });

  test("list_apps speaks the names and only sees its own org", async () => {
    fake.projects.push({ id: randomUUID(), name: "Barber Booking", org: "org-a", framework: "react" });
    fake.projects.push({ id: randomUUID(), name: "Someone Else's", org: "org-b", framework: "react" });
    const c = await connect(TOKEN_A);
    const { text, result } = await callText(c, "list_apps");
    assert.equal(text, "You have 1 app: Barber Booking.");
    assert.equal((result.structuredContent as { apps: unknown[] }).apps.length, 1);
    await c.close();
  });

  test("list_apps reads the light list, not every project's design", async () => {
    fake.projects.push({ id: randomUUID(), name: "Barber Booking", org: "org-a", framework: "react" });
    const c = await connect(TOKEN_A);
    const { text } = await callText(c, "list_apps");
    assert.equal(text, "You have 1 app: Barber Booking.");
    assert.equal(fake.fullLists, 0);
    await c.close();
  });

  test("list_apps still answers from an older Shipd without the light list", async () => {
    fake.noRecent = true;
    for (let i = 1; i <= 25; i++) {
      fake.projects.push({ id: randomUUID(), name: `App ${i}`, org: "org-a", framework: "react" });
    }
    const c = await connect(TOKEN_A);
    const { text, result } = await callText(c, "list_apps");
    assert.equal(text, "You have 25 apps. The newest are App 25, App 24, App 23, App 22 and App 21.");
    assert.equal((result.structuredContent as { apps: unknown[] }).apps.length, 20);
    assert.equal(fake.fullLists, 1);
    await c.close();
  });

  test("list_apps says the real total, not the 20 it returns", async () => {
    // Seen on prod: an account with 372 apps heard "You have 20 apps".
    for (let i = 1; i <= 25; i++) {
      fake.projects.push({ id: randomUUID(), name: `App ${i}`, org: "org-a", framework: "react" });
    }
    const c = await connect(TOKEN_A);
    const { text, result } = await callText(c, "list_apps");
    assert.equal(text, "You have 25 apps. The newest are App 25, App 24, App 23, App 22 and App 21.");
    const sc = result.structuredContent as { total: number; apps: unknown[] };
    assert.equal(sc.total, 25);
    assert.equal(sc.apps.length, 20);
    await c.close();
  });

  test("get_app_link for someone else's app is a spoken not-found", async () => {
    const theirs = randomUUID();
    fake.projects.push({ id: theirs, name: "Theirs", org: "org-b", framework: "react" });
    const c = await connect(TOKEN_A);
    const { text, result } = await callText(c, "get_app_link", { app_id: theirs });
    assert.equal(result.isError, true);
    assert.equal(text, "I couldn't find that in your Shipd account.");
    await c.close();
  });
});

describe("builds as tasks", () => {
  test("build_app: working, then saving, then completed with a link", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "a booking site for my barbershop" });
    assert.equal(task.status, "working");
    const ref = decodeBuildId(task.taskId);
    assert.ok(ref && "job" in ref);
    assert.equal(fake.projects[0].name, "A Booking Site For My Barbershop");

    fake.jobs[ref.job].chars = 12_400;
    let t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.status, "working");
    assert.equal(t.statusMessage, "Still building. About 12 thousand characters of code so far.");

    fake.jobs[ref.job].status = "done"; // done, version not saved yet
    fake.jobs[ref.job].updated_at = Date.now() / 1000;
    t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.status, "working");
    assert.equal(t.statusMessage, "Saving your app.");

    fake.versions[ref.project] = [1];
    t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.status, "completed");

    const result = await c.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.version, 1);
    assert.equal(sc.link, `https://shipd.test/builder?project=${ref.project}`);
    assert.match((result.content[0] as { text: string }).text, /is ready\. That's version 1\./);
    await c.close();
  });

  test("a task survives across requests and even a new connection", async () => {
    const c1 = await connect(TOKEN_A);
    const task = await startTask(c1, "build_app", { description: "a todo list", name: "Todos" });
    await c1.close();
    assert.equal(fake.projects[0].name, "Todos"); // a name the person gave is kept
    const ref = decodeBuildId(task.taskId);
    assert.ok(ref && "job" in ref);
    finish(ref.job);
    const c2 = await connect(TOKEN_A);
    const t = await c2.experimental.tasks.getTask(task.taskId);
    assert.equal(t.status, "completed");
    await c2.close();
  });

  test("another org cannot see, read or cancel your build", async () => {
    const a = await connect(TOKEN_A);
    const task = await startTask(a, "build_app", { description: "a private app" });
    const b = await connect(TOKEN_B);
    await assert.rejects(b.experimental.tasks.getTask(task.taskId), /not found/i);
    await assert.rejects(b.experimental.tasks.cancelTask(task.taskId), /not found/i);
    const { result } = await callText(b, "check_build", { build_id: task.taskId });
    assert.equal(result.isError, true);
    assert.equal(fake.cancels.length, 0);
    await a.close();
    await b.close();
  });

  test("tasks/cancel stops the job on Shipd", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "something to stop" });
    const cancelled = await c.experimental.tasks.cancelTask(task.taskId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(fake.cancels.length, 1);
    await c.close();
  });

  test("a plan limit comes back as a failed task carrying the real sentence", async () => {
    fake.projectLimit = 0;
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "one app too many" });
    assert.equal(task.status, "failed");
    assert.equal(task.statusMessage, "The free plan allows 3 projects. Upgrade to add more.");
    const result = await c.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema);
    assert.equal(result.isError, true);
    await c.close();
  });

  test("a job whose heartbeat stopped (backend restart) is reported failed", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "an app during a deploy" });
    const ref = decodeBuildId(task.taskId);
    assert.ok(ref && "job" in ref);
    fake.jobs[ref.job].updated_at = Date.now() / 1000 - 600;
    const t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.status, "failed");
    assert.match(t.statusMessage || "", /restarted/);
    await c.close();
  });

  test("done with nothing saved is an honest failure, not 'ready'", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "an empty build" });
    const ref = decodeBuildId(task.taskId);
    assert.ok(ref && "job" in ref);
    Object.assign(fake.jobs[ref.job], { status: "done", updated_at: Date.now() / 1000 - 600 });
    const t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.status, "failed");
    await c.close();
  });

  test("edit_app changes the latest version; an unbuilt app is refused", async () => {
    const id = randomUUID();
    fake.projects.push({ id, name: "Barber Booking", org: "org-a", framework: "react" });
    const c = await connect(TOKEN_A);
    const refused = await startTask(c, "edit_app", { app_id: id, change: "make the buttons gold" });
    assert.equal(refused.status, "failed");
    assert.match(refused.statusMessage || "", /has no build yet/);

    fake.versions[id] = [1, 2];
    const task = await startTask(c, "edit_app", { app_id: id, change: "make the buttons gold" });
    const ref = decodeBuildId(task.taskId);
    assert.ok(ref && "job" in ref);
    assert.equal(ref.prev, 2);
    finish(ref.job);
    const result = await c.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema);
    assert.match((result.content[0] as { text: string }).text, /^Done\. Barber Booking is updated, now on version 3\./);
    await c.close();
  });

  test("a client without tasks hears at once that the build started, then follows it with check_build", async () => {
    const c = await connect(TOKEN_A);
    const t0 = Date.now();
    const r = await c.callTool({ name: "build_app", arguments: { description: "a quick one" } });
    assert.ok(Date.now() - t0 < 3000, "not held open for the build");
    const first = (r.content as { text: string }[])[0].text;
    assert.match(first, /^I've started building it\./);
    const sc = r.structuredContent as { build_id: string; status: string; kind: string; app_id: string };
    assert.equal(sc.status, "working");
    assert.equal(sc.kind, "build");
    const ref = decodeBuildId(sc.build_id) as { job: string; ack?: number };
    assert.ok(ref && !("ack" in ref && ref.ack), "the id to follow tracks the build itself");
    const running = await callText(c, "check_build", { build_id: sc.build_id });
    assert.equal(running.text, "Still building.");
    finish(ref.job);
    const done = await callText(c, "check_build", { build_id: sc.build_id });
    const ds = done.result.structuredContent as { status: string; version: number; link: string };
    assert.equal(ds.status, "completed");
    assert.equal(ds.version, 1);
    assert.match(ds.link, /^https:\/\/shipd\.test\/builder\?project=/);
    await c.close();
  });

  test("a refused build still fails at once for a client without tasks", async () => {
    fake.tokensOut = true;
    const c = await connect(TOKEN_A);
    const r = await c.callTool({ name: "build_app", arguments: { description: "one build too many" } });
    assert.equal(r.isError, true);
    assert.equal((r.content as { text: string }[])[0].text, "You've reached your monthly token limit, it resets on the 1st.");
    await c.close();
  });

  test("a refused build_app leaves no empty project behind", async () => {
    fake.tokensOut = true;
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "one build too many" });
    assert.equal(task.status, "failed");
    assert.equal(task.statusMessage, "You've reached your monthly token limit, it resets on the 1st.");
    assert.equal(fake.deleted.length, 1);
    assert.equal(fake.projects.length, 0);
    await c.close();
  });

  test("a start that may have reached Shipd keeps the project and says so", async () => {
    fake.startCrash = true;
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "an app whose start answer was lost" });
    assert.equal(task.status, "failed");
    assert.match(task.statusMessage || "", /may still be running/);
    assert.equal(fake.deleted.length, 0);
    assert.equal(fake.projects.length, 1);
    await c.close();
  });

  test("'Project not found' from the team job is not mistaken for the switch being off", async () => {
    fake.teamProjectMissing = true;
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "a project the team cannot see" });
    assert.equal(task.status, "failed");
    assert.equal(task.statusMessage, "I couldn't find that in your Shipd account.");
    await c.close();
  });

  test("check_build refuses a made-up id and reads a real one", async () => {
    const c = await connect(TOKEN_A);
    const junk = await callText(c, "check_build", { build_id: "not-a-build" });
    assert.equal(junk.text, "I don't recognise that build.");
    const forged = encodeBuildId({ v: 1, kind: "build", job: randomUUID(), project: randomUUID(), prev: 0, t: 1 });
    const missing = await callText(c, "check_build", { build_id: forged });
    assert.equal(missing.result.isError, true);
    const task = await startTask(c, "build_app", { description: "check me" });
    const running = await callText(c, "check_build", { build_id: task.taskId });
    assert.equal(running.text, "Still building.");
    await c.close();
  });
});

describe("the AI Team", () => {
  test("the task speaks each thing the team did, then completes on the saved version", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", {
      description: "a booking site for my barbershop",
      answers: "walk-ins welcome",
    });
    assert.equal(task.status, "working");
    assert.equal(task.statusMessage, "Your team is on it. Maya is writing the plan.");
    const ref = decodeBuildId(task.taskId);
    assert.ok(ref && "job" in ref && ref.kind === "team");
    const job = fake.jobs[ref.job];

    // The team writes a room's summary and the next room's start together, so
    // a poller must still hear the summary.
    job.lines!.push("Maya wrote the plan: 3 user stories.", "Theo is choosing the look and feel.");
    job.stage = "director";
    let t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.statusMessage, "Maya wrote the plan: 3 user stories. Theo is choosing the look and feel.");

    job.lines!.push("Ren designed 3 screens: Home, Booking and Done.", "Sam is building the app.");
    Object.assign(job, { stage: "engineer", chars: 9000 });
    t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.statusMessage, "Ren designed 3 screens: Home, Booking and Done. Sam is building the app.");
    // More code does not change what is said: one message per room.
    job.chars = 30000;
    const again = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(again.statusMessage, t.statusMessage);

    finish(ref.job);
    t = await c.experimental.tasks.getTask(task.taskId);
    assert.equal(t.status, "completed");
    const result = await c.experimental.tasks.getTaskResult(task.taskId, CallToolResultSchema);
    assert.match(
      (result.content[0] as { text: string }).text,
      /is ready\. Your team planned, designed and built it, and it's on version 1\./,
    );
    await c.close();
  });

  test("an app that keeps data gets a backend project, so Devin builds its API first", async () => {
    const c = await connect(TOKEN_A);
    await startTask(c, "build_with_team", { description: "A booking site for my barbershop", backend: true });
    await startTask(c, "build_with_team", { description: "A one-page site for my barbershop" });
    assert.deepEqual(
      fake.projects.map((p) => p.backend ?? ""),
      ["node", ""],
    );
    await c.close();
  });

  test("a team build with Devin is ready only past his own saved version", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "A booking site for my barbershop", backend: true });
    const jobId = Object.keys(fake.jobs)[0];
    const job = fake.jobs[jobId];
    const project = fake.projects[0].id;
    fake.versions[project] = [1]; // Devin's own save
    job.base_version = 1;
    job.status = "done";
    job.updated_at = Date.now() / 1000;
    const waiting = (await callText(c, "check_build", { build_id: task.taskId })).result.structuredContent as {
      status: string;
    };
    assert.equal(waiting.status, "working"); // "Saving your app.", not "ready" on Devin's version
    fake.versions[project].push(2); // Sam's
    const done = (await callText(c, "check_build", { build_id: task.taskId })).result.structuredContent as {
      status: string;
      version: number;
    };
    assert.equal(done.status, "completed");
    assert.equal(done.version, 2);
    await c.close();
  });

  test("an edit of an app with its own server keeps the server", async () => {
    const id = randomUUID();
    fake.projects.push({ id, name: "Bookings", org: "org-a", framework: "react", backend: "node" });
    fake.versions[id] = [1];
    const c = await connect(TOKEN_A);
    await startTask(c, "edit_app", { app_id: id, change: "add a phone number field" });
    assert.deepEqual(fake.stacks, ["node"]);
    await c.close();
  });

  test("when the team is not switched on, it says so and leaves nothing behind", async () => {
    fake.teamOff = true;
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "a team app" });
    assert.equal(task.status, "failed");
    assert.match(task.statusMessage || "", /isn't switched on/);
    assert.equal(fake.projects.length, 0);
    assert.equal(fake.deleted.length, 1);
    await c.close();
  });

  test("cancel reaches the team job, and another org cannot see it", async () => {
    const a = await connect(TOKEN_A);
    const task = await startTask(a, "build_with_team", { description: "a team app to stop" });
    const b = await connect(TOKEN_B);
    await assert.rejects(b.experimental.tasks.getTask(task.taskId), /not found/i);
    const cancelled = await a.experimental.tasks.cancelTask(task.taskId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(fake.cancels.length, 1);
    await a.close();
    await b.close();
  });
});

describe("sharing", () => {
  test("share_app gives a public link, and the same version gives the same link", async () => {
    const id = randomUUID();
    fake.projects.push({ id, name: "Fade Street", org: "org-a", framework: "react" });
    fake.versions[id] = [1, 2];
    const c = await connect(TOKEN_A);
    const first = await callText(c, "share_app", { app_id: id });
    const sc = first.result.structuredContent as { link: string; version: number };
    assert.match(first.text, /^Here's a link anyone can open: https:\/\/shipd\.test\/s\/\w{22}$/);
    assert.equal(sc.version, 2);
    const again = await callText(c, "share_app", { app_id: id });
    assert.equal((again.result.structuredContent as { link: string }).link, sc.link);
    await c.close();
  });

  test("share_app says when it held files back, and stop_sharing turns links off", async () => {
    const id = randomUUID();
    fake.projects.push({ id, name: "Fade Street", org: "org-a", framework: "react" });
    fake.versions[id] = [1];
    fake.withheld = ["/.env", "/certs/server.pem"];
    const c = await connect(TOKEN_A);
    const shared = await callText(c, "share_app", { app_id: id });
    assert.match(shared.text, / I left out 2 files that look like secrets\.$/);
    const stopped = await callText(c, "stop_sharing", { app_id: id });
    assert.equal(stopped.text, "Done. Its share link is off.");
    const again = await callText(c, "stop_sharing", { app_id: id });
    assert.equal(again.text, "That app wasn't shared.");
    await c.close();
  });

  test("share_app says plainly when people with the link use the app's real data", async () => {
    const id = randomUUID();
    fake.projects.push({ id, name: "Fade Street", org: "org-a", framework: "react" });
    fake.versions[id] = [1];
    fake.liveData = true;
    fake.withheld = ["/.env"];
    const c = await connect(TOKEN_A);
    const shared = await callText(c, "share_app", { app_id: id });
    assert.match(
      shared.text,
      / People with the link use this app's real data, like a deployed app\. I left out 1 file that looks like secrets\.$/,
    );
    assert.equal((shared.result.structuredContent as { live_data: boolean }).live_data, true);
    await c.close();
  });

  test("sharing switched off, an unbuilt app and someone else's app all say why", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    fake.projects.push({ id: mine, name: "Empty", org: "org-a", framework: "react" });
    fake.projects.push({ id: theirs, name: "Theirs", org: "org-b", framework: "react" });
    const c = await connect(TOKEN_A);
    const unbuilt = await callText(c, "share_app", { app_id: mine });
    assert.equal(unbuilt.result.isError, true);
    assert.equal(unbuilt.text, "This app has no saved version to share yet.");
    const notMine = await callText(c, "share_app", { app_id: theirs });
    assert.equal(notMine.text, "I couldn't find that in your Shipd account.");
    fake.versions[mine] = [1];
    fake.shareOff = true;
    const off = await callText(c, "share_app", { app_id: mine });
    assert.equal(off.text, "Sharing isn't switched on for your Shipd account yet.");
    await c.close();
  });
});

describe("staffing the AI Team", () => {
  const AVA = {
    name: "Ava",
    title: "Copywriter",
    brief: "You write the website's words for a barbershop: warm, short, in the owner's voice.",
  };

  test("team_roster says the five in order, and never the members' emails", async () => {
    const c = await connect(TOKEN_A);
    const r = await callText(c, "team_roster");
    assert.equal(
      r.text,
      "Your team, in order: Maya the product manager, Theo the design director, Ren the designer, Devin the backend engineer and Sam the frontend engineer.",
    );
    assert.doesNotMatch(JSON.stringify(r.result), /owner@example\.com|Kai/);
    await c.close();
  });

  test("an interview answers in character and saves nothing", async () => {
    const c = await connect(TOKEN_A);
    const r = await callText(c, "interview_candidate", {
      ...AVA,
      question: "How would you write our booking page?",
      history: [{ role: "user", text: "Hi Ava" }, { role: "candidate", text: "Hi there" }],
    });
    assert.match(r.text, /^Ava: I'd keep it warm and short\./);
    assert.equal((r.result.structuredContent as { voice: string }).voice, "specialist");
    assert.equal(fake.interviews.length, 1);
    assert.equal(fake.interviews[0].instructions, AVA.brief);
    assert.equal(fake.interviews[0].history.length, 2);
    assert.equal((fake.interviews[0] as { spoken?: boolean }).spoken, true);
    const him = await callText(c, "interview_candidate", { ...AVA, name: "Omar", voice: "man", question: "Hi?" });
    assert.equal((him.result.structuredContent as { voice: string }).voice, "specialist_m");
    assert.equal(fake.agents.length, 0);
    await c.close();
  });

  test("hire_specialist creates and seats them after Maya, in their own colour", async () => {
    const c = await connect(TOKEN_A);
    const r = await callText(c, "hire_specialist", { ...AVA, one_line: "Website words" });
    assert.equal(
      r.text,
      "Ava is on the team now, on every team build, working after Maya. From the next team build, Ava's notes go to Devin and Sam.",
    );
    assert.equal(fake.agents.length, 1);
    assert.equal(fake.agents[0].blurb, "Website words");
    assert.equal(fake.agents[0].color, "#2A6F97");
    assert.deepEqual(fake.slots.map((s) => [s.anchor, s.project]), [["pm", null]]);
    const roster = await callText(c, "team_roster");
    assert.match(roster.text, /Maya the product manager, Ava the copywriter you hired, Theo the design director/);
    // A second Ava is refused; a second hire takes the next free colour.
    const again = await callText(c, "hire_specialist", AVA);
    assert.match(again.text, /already on the team or the bench/);
    await callText(c, "hire_specialist", { name: "Omar", title: "SEO Expert", brief: "You make it findable.", after: "designer" });
    assert.equal(fake.agents[1].color, "#9D4E15");
    assert.equal(fake.slots[1].anchor, "designer");
    assert.match((await callText(c, "team_roster")).text, /Ren the designer, Omar the SEO expert you hired, Devin/);
    await c.close();
  });

  test("hiring for one app seats them on that app only, and another org never sees them", async () => {
    const app = randomUUID();
    const c = await connect(TOKEN_A);
    const r = await callText(c, "hire_specialist", { ...AVA, app_id: app });
    assert.match(r.text, /on this app, working after Maya/);
    assert.equal(fake.slots[0].project, app);
    assert.match((await callText(c, "team_roster", { app_id: app })).text, /Ava the copywriter you hired/);
    assert.match((await callText(c, "team_roster")).text, /Hired before but not working on builds: Ava\./);
    // Without the app, firing asks which app instead of claiming Ava is idle.
    const vague = await callText(c, "fire_teammate", { who: "Ava" });
    assert.equal(vague.text, "Ava isn't on every build. If Ava works on one app, tell me which app.");
    assert.equal(fake.slots.length, 1);
    await callText(c, "fire_teammate", { who: "Ava", app_id: app });
    assert.equal(fake.slots.length, 0);
    await c.close();
    const b = await connect(TOKEN_B);
    assert.doesNotMatch((await callText(b, "team_roster")).text, /Ava/);
    await b.close();
  });

  test("letting one of the five go and bringing them back", async () => {
    const c = await connect(TOKEN_A);
    const gone = await callText(c, "fire_teammate", { who: "Theo" });
    assert.equal(gone.text, "Done, Theo is off the team. Team builds now go on without the look.");
    assert.deepEqual(fake.fired.map((f) => f.role), ["director"]);
    const roster = await callText(c, "team_roster");
    assert.doesNotMatch(roster.text, /Theo the design director/);
    assert.match(roster.text, /Let go: Theo\.$/);
    const back = await callText(c, "rehire_teammate", { who: "theo" });
    assert.equal(back.text, "Theo is back on the team.");
    assert.deepEqual(fake.fired, []);
    await c.close();
  });

  test("letting Sam go says nobody builds the app", async () => {
    const c = await connect(TOKEN_A);
    const r = await callText(c, "fire_teammate", { who: "Sam" });
    assert.match(r.text, /With Sam gone nobody builds the app, so team builds won't start until you bring Sam back\./);
    await c.close();
  });

  test("a hired specialist goes to the bench and comes back after whoever they pick", async () => {
    const c = await connect(TOKEN_A);
    await callText(c, "hire_specialist", AVA);
    const off = await callText(c, "fire_teammate", { who: "ava" });
    assert.equal(off.text, "Done, Ava is off the team. You can bring Ava back any time.");
    assert.equal(fake.slots.length, 0);
    assert.equal(fake.agents.length, 1); // benched, not deleted
    const back = await callText(c, "rehire_teammate", { who: "Ava", after: "director" });
    assert.equal(back.text, "Ava is back on the team, working after Theo.");
    assert.equal(fake.slots[0].anchor, "director");
    const twice = await callText(c, "rehire_teammate", { who: "Ava" });
    assert.equal(twice.text, "Ava is already on the team.");
    await c.close();
  });

  test("an unknown name hears who is on the team", async () => {
    const c = await connect(TOKEN_A);
    const r = await callText(c, "fire_teammate", { who: "Bob" });
    assert.match(r.text, /^There's nobody called Bob on the team\. Your team, in order: Maya/);
    assert.equal(fake.fired.length, 0);
    await c.close();
  });

  test("switched off, or a free plan hiring, both say why", async () => {
    const c = await connect(TOKEN_A);
    fake.agentsPaid = true;
    const free = await callText(c, "hire_specialist", AVA);
    assert.equal(free.result.isError, true);
    assert.match(free.text, /Upgrade to hire/);
    assert.equal(fake.agents.length, 0);
    // Letting someone go is free.
    assert.match((await callText(c, "fire_teammate", { who: "Ren" })).text, /^Done, Ren is off the team/);
    fake.agentsOff = true;
    for (const [name, args] of [
      ["team_roster", {}],
      ["interview_candidate", { ...AVA, question: "Hi?" }],
      ["hire_specialist", AVA],
      ["fire_teammate", { who: "Theo" }],
      ["rehire_teammate", { who: "Theo" }],
    ] as const) {
      const r = await callText(c, name, args);
      assert.equal(r.result.isError, true, name);
      assert.equal(r.text, "Hiring and firing your AI Team isn't switched on for your Shipd account yet.", name);
    }
    await c.close();
  });

  test("firing is marked destructive and the roster read-only", async () => {
    const c = await connect(TOKEN_A);
    const tools = (await c.listTools()).tools;
    // Shipd's voice backend refuses a turn whose tool schema is over 4000 bytes.
    for (const t of tools) assert.ok(JSON.stringify(t.inputSchema).length < 4000, `${t.name} schema too big`);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.fire_teammate.annotations?.destructiveHint, true);
    assert.equal(byName.team_roster.annotations?.readOnlyHint, true);
    assert.equal(byName.hire_specialist.annotations?.destructiveHint, false);
    await c.close();
  });
});

test("lists read the way people say them", () => {
  assert.equal(spokenList([]), "");
  assert.equal(spokenList(["A"]), "A");
  assert.equal(spokenList(["A", "B"]), "A and B");
  assert.equal(spokenList(["A", "B", "C"]), "A, B and C");
});

test("placeholder names are short and readable", () => {
  assert.equal(nameFromDescription("a booking site for my barbershop, with prices!"), "A Booking Site For My Barbershop");
  assert.equal(nameFromDescription("!!!"), "New App");
});

// ── a public server: what a stranger can and cannot make it do ────────────────

async function post(url: URL, body: string, token: string | null = TOKEN_A) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  return { status: res.status, type: res.headers.get("content-type") || "", text: await res.text() };
}

const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

describe("public hardening", () => {
  test("a batch is refused before anything reaches Shipd", async () => {
    const one = { jsonrpc: "2.0", method: "tools/call", params: { name: "list_apps", arguments: {} } };
    const batch = Array.from({ length: 100 }, (_, i) => ({ ...one, id: i }));
    const r = await post(mcpUrl, JSON.stringify(batch));
    assert.equal(r.status, 400);
    assert.match(r.text, /Batched requests are not supported/);
    assert.deepEqual(fake.auth, []);
  });

  test("an unreadable body gets a JSON-RPC error, never an HTML stack trace", async () => {
    const r = await post(mcpUrl, "{not json");
    assert.equal(r.status, 400);
    assert.match(r.type, /application\/json/);
    assert.doesNotMatch(r.text, /<html|at .*\.js/i);
  });

  test("a token Shipd refused is turned away for a minute without asking Shipd again", async () => {
    const stranger = "shp_" + "z".repeat(43);
    const first = await post(mcpUrl, JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_apps", arguments: {} },
    }), stranger);
    assert.equal(first.status, 200); // the tool says the token was not accepted
    const asked = fake.auth.filter((t) => t === stranger).length;
    assert.equal(asked, 1);
    const again = await post(mcpUrl, LIST_TOOLS, stranger);
    assert.equal(again.status, 401);
    assert.match(again.text, /didn't accept that token/);
    assert.equal(fake.auth.filter((t) => t === stranger).length, asked);
    assert.equal((await post(mcpUrl, LIST_TOOLS, TOKEN_A)).status, 200); // others unaffected
  });

  test("each token gets a fixed number of requests a minute, without using up anyone else's", async () => {
    const apiUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const tight = await listen(
      createApp({ apiUrl, appUrl: "https://shipd.test", port: 0, host: "127.0.0.1", allowedHosts: [], ratePerMin: 3 }),
    );
    const url = new URL(`http://127.0.0.1:${(tight.address() as AddressInfo).port}/mcp`);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(url, LIST_TOOLS)).status);
    const other = (await post(url, LIST_TOOLS, TOKEN_B)).status; // same address, other token
    tight.close();
    assert.deepEqual(codes, [200, 200, 200, 429]);
    assert.equal(other, 200);
  });

  test("a build id whose job is not a Shipd id never becomes a backend path", async () => {
    const c = await connect(TOKEN_A);
    const forged = Buffer.from(
      JSON.stringify({ v: 1, kind: "team", job: "../cancel", project: randomUUID(), prev: 0, t: 1 }),
    ).toString("base64url");
    fake.auth = [];
    const r = await callText(c, "check_build", { build_id: forged });
    assert.equal(r.text, "I don't recognise that build.");
    assert.deepEqual(fake.auth, []);
    await c.close();
  });
});

// ── asking one question before a build (elicitation) ─────────────────────────

async function connectAsking(
  token: string,
  answer: (req: ElicitRequest) => ElicitResult | Promise<ElicitResult>,
): Promise<{ client: Client; asked: ElicitRequest[] }> {
  const asked: ElicitRequest[] = [];
  const client = new Client(
    { name: "test-asking", version: "1.0.0" },
    { capabilities: { tasks: {}, elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push(req);
    return answer(req);
  });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return { client, asked };
}

describe("asking before a build", () => {
  test("a short request gets one question tailored to the app, and the answer goes into the build", async () => {
    const { client, asked } = await connectAsking(TOKEN_A, () => ({
      action: "accept",
      content: { audience: "Walk-in clients", must_haves: ["Online booking", "Price list"], notes: "Gold and black" },
    }));
    await startTask(client, "build_app", { description: "A booking site for my barbershop" });
    assert.equal(asked.length, 1);
    const params = asked[0].params as { message: string; requestedSchema: { properties: Record<string, any> } };
    assert.match(params.message, /^Quick question before I build/);
    assert.deepEqual(params.requestedSchema.properties.audience.enum, ["Walk-in clients", "Regulars", "Barbers", "Shop owner"]);
    assert.deepEqual(params.requestedSchema.properties.must_haves.items.enum, ["Online booking", "Price list", "Opening hours", "Gallery"]);
    assert.deepEqual(fake.clarifyCalls, ["A booking site for my barbershop"]);
    assert.equal(
      fake.prompts[0],
      "A booking site for my barbershop\n\nIt's for: Walk-in clients. Must have: Online booking, Price list. Gold and black",
    );
    await client.close();
  });

  test("a skip builds from the description as given", async () => {
    const { client, asked } = await connectAsking(TOKEN_A, () => ({ action: "decline" }));
    await startTask(client, "build_app", { description: "A booking site for my barbershop" });
    assert.equal(asked.length, 1);
    assert.deepEqual(fake.prompts, ["A booking site for my barbershop"]);
    await client.close();
  });

  test("a client that can't show a form is never asked", async () => {
    const client = await connect(TOKEN_A);
    await startTask(client, "build_app", { description: "A booking site for my barbershop" });
    assert.deepEqual(fake.clarifyCalls, []);
    assert.deepEqual(fake.prompts, ["A booking site for my barbershop"]);
    await client.close();
  });

  test("a detailed description, or answers the assistant already got, skip the question", async () => {
    const { client, asked } = await connectAsking(TOKEN_A, () => ({ action: "decline" }));
    const detailed =
      "A booking site for my barbershop in Lahore where walk-in clients and regulars can see prices, " +
      "pick a barber, choose a time slot, get a reminder by text and see the gallery of recent cuts.";
    await startTask(client, "build_app", { description: detailed });
    await startTask(client, "build_app", { description: "A barbershop site", answers: "For regulars, with online booking." });
    assert.equal(asked.length, 0);
    assert.deepEqual(fake.prompts, [detailed, "A barbershop site\n\nFor regulars, with online booking."]);
    await client.close();
  });

  test('"skip" from the assistant means build without asking, and is not added to the request', async () => {
    const { client, asked } = await connectAsking(TOKEN_A, () => ({ action: "decline" }));
    await startTask(client, "build_app", { description: "A barbershop site", answers: "skip" });
    await startTask(client, "build_with_team", { description: "A barbershop site", answers: "You decide." });
    assert.equal(asked.length, 0);
    assert.deepEqual(fake.prompts, ["A barbershop site"]);
    assert.deepEqual(fake.teamAnswers, [undefined]);
    await client.close();
  });

  test("the build tools tell the assistant to ask first when the request is thin", async () => {
    const client = await connect(TOKEN_A);
    const { tools } = await client.listTools();
    for (const name of ["build_app", "build_with_team"]) {
      const t = tools.find((x) => x.name === name)!;
      assert.match(t.description ?? "", /ask the person first/);
      assert.match(JSON.stringify(t.inputSchema), /skip/);
    }
    await client.close();
  });

  test("the team gets the answer as the person's answers", async () => {
    const { client } = await connectAsking(TOKEN_A, () => ({ action: "accept", content: { audience: "Regulars" } }));
    await startTask(client, "build_with_team", { description: "A booking site for my barbershop" });
    assert.deepEqual(fake.teamAnswers, ["It's for: Regulars."]);
    await client.close();
  });

  test("if Shipd can't tailor the question, it builds without asking", async () => {
    fake.clarifyFail = true;
    const { client, asked } = await connectAsking(TOKEN_A, () => ({ action: "decline" }));
    await startTask(client, "build_app", { description: "A booking site for my barbershop" });
    assert.equal(asked.length, 0);
    assert.deepEqual(fake.prompts, ["A booking site for my barbershop"]);
    await client.close();
  });
});

// ── sessions ──────────────────────────────────────────────────────────────────

async function rawRpc(token: string | null, body: unknown, sid?: string, method = "POST") {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sid) headers["Mcp-Session-Id"] = sid;
  const res = await fetch(mcpUrl, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined });
  return { status: res.status, sid: res.headers.get("mcp-session-id") ?? undefined, text: await res.text() };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

describe("sessions", () => {
  test("a session belongs to the token that opened it, and ends when the client says so", async () => {
    const init = await rawRpc(TOKEN_A, INIT);
    assert.equal(init.status, 200);
    assert.ok(init.sid);
    assert.equal((await rawRpc(TOKEN_A, LIST, init.sid)).status, 200);
    const stolen = await rawRpc(TOKEN_B, LIST, init.sid);
    assert.equal(stolen.status, 404);
    assert.match(stolen.text, /Session not found/);
    assert.equal((await rawRpc(TOKEN_B, null, init.sid, "DELETE")).status, 404);
    assert.equal((await rawRpc(TOKEN_A, null, init.sid, "DELETE")).status, 200);
    assert.equal((await rawRpc(TOKEN_A, LIST, init.sid)).status, 404);
  });

  test("a request with no session is still served on its own", async () => {
    const r = await rawRpc(TOKEN_A, LIST);
    assert.equal(r.status, 200);
    assert.match(r.text, /"build_app"/);
    assert.equal(r.sid, undefined);
  });
});


describe("sessions under pressure", () => {
  test("a token Shipd refuses never gets a session, and is then turned away without asking Shipd", async () => {
    const fakeToken = "shp_" + "q".repeat(43);
    const init = await rawRpc(fakeToken, INIT);
    assert.equal(init.status, 401);
    assert.equal(init.sid, undefined);
    const seen = fake.auth.filter((t) => t === fakeToken).length;
    assert.equal(seen, 1); // one check, at initialize
    assert.equal((await rawRpc(fakeToken, INIT)).status, 401);
    assert.equal(fake.auth.filter((t) => t === fakeToken).length, seen);
  });

  test("one token's sessions only ever push out its own oldest, never another token's", async () => {
    const theirs = await rawRpc(TOKEN_B, INIT);
    const mine: string[] = [];
    for (let i = 0; i < 6; i++) mine.push((await rawRpc(TOKEN_A, INIT)).sid!);
    assert.equal((await rawRpc(TOKEN_A, LIST, mine[0])).status, 404); // its own oldest went
    assert.equal((await rawRpc(TOKEN_A, LIST, mine[5])).status, 200);
    assert.equal((await rawRpc(TOKEN_B, LIST, theirs.sid)).status, 200);
  });

  test("a session waiting on a question is never the one pushed out", async () => {
    let answer!: (r: ElicitResult) => void;
    const { client, asked } = await connectAsking(TOKEN_A, () => new Promise<ElicitResult>((r) => (answer = r)));
    const started = startTask(client, "build_app", { description: "A booking site for my barbershop" });
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 6; i++) await rawRpc(TOKEN_A, INIT); // fill this token's sessions and more
    answer({ action: "accept", content: { audience: "Regulars" } });
    const task = await started;
    assert.notEqual(task.status, "failed");
    assert.deepEqual(fake.prompts, ["A booking site for my barbershop\n\nIt's for: Regulars."]);
    await client.close();
  });

  test("if the client gives up while the question is open, nothing is built", async () => {
    const { client, asked } = await connectAsking(
      TOKEN_A,
      () => new Promise<ElicitResult>((r) => setTimeout(() => r({ action: "decline" }), 1500)),
    );
    await assert.rejects(
      client.request(
        {
          method: "tools/call",
          params: { name: "build_app", arguments: { description: "A booking site for my barbershop" }, task: { ttl: 60_000 } },
        },
        CreateTaskResultSchema,
        { timeout: 300 },
      ),
    );
    assert.equal(asked.length, 1);
    await new Promise((r) => setTimeout(r, 1800)); // past the late answer
    assert.deepEqual(fake.projects, []);
    assert.deepEqual(fake.prompts, []);
    await client.close();
  });
});


// ── the live build card (MCP Apps) ────────────────────────────────────────────

const CARD = "ui://shipd/build-card.html";

describe("the live build card", () => {
  test("is listed, served as one self-contained MCP App page, and linked from the build tools", async () => {
    const c = await connect(TOKEN_A);
    const { resources } = await c.listResources();
    const listed = resources.find((r) => r.uri === CARD);
    assert.ok(listed, "the card is listed");
    const read = await c.readResource({ uri: CARD });
    const page = read.contents[0] as { mimeType: string; text: string };
    assert.equal(page.mimeType, "text/html;profile=mcp-app");
    assert.match(page.text, /^<!doctype html>/);
    assert.match(page.text, /globalThis\.ShipdMcpApps=\{[^}]*"App":/);
    // Nothing loaded from elsewhere: no host CSP exceptions needed.
    assert.doesNotMatch(page.text, /<script[^>]+src=|<link[^>]+href=|@import|<img[^>]+src="http/i);
    assert.doesNotMatch(page.text, /innerHTML/);
    const { tools } = await c.listTools();
    // The tools point at the card's content-named address (hosts keep a card
    // by its address, so a changed card must get a new one); the fixed
    // address the voice page reads serves the very same page.
    const uriOf = (t: { _meta?: unknown }) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
    const linked = tools.filter((t) => uriOf(t));
    // Not check_build: every "is it done?" would draw another card polling the same build.
    assert.deepEqual(linked.map((t) => t.name).sort(), ["build_app", "build_with_team", "edit_app"]);
    const current = uriOf(linked[0])!;
    assert.match(current, /^ui:\/\/shipd\/build-card-[0-9a-f]{10}\.html$/);
    for (const t of linked) {
      assert.equal(uriOf(t), current);
      assert.equal((t._meta as Record<string, unknown>)["ui/resourceUri"], current);
    }
    assert.ok(resources.find((r) => r.uri === current), "the current address is listed");
    const same = ((await c.readResource({ uri: current })).contents[0] as { text: string }).text;
    assert.equal(same, page.text);
    await c.close();
  });

  test("its two inline scripts are valid JavaScript (template escaping cannot break the page)", async () => {
    const vm = await import("node:vm");
    const c = await connect(TOKEN_A);
    const page = ((await c.readResource({ uri: CARD })).contents[0] as { text: string }).text;
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 2);
    for (const src of scripts) assert.doesNotThrow(() => new vm.Script(src));
    await c.close();
  });

  test("check_build tells the card where an AI Team build has got to", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients" });
    const job = Object.values(fake.jobs)[0];
    Object.assign(job, { stage: "designer", chars: 12_400 });
    job.stages![0].status = "done";
    job.stages![1].status = "done";
    job.stages![2].status = "working";
    const r = await callText(c, "check_build", { build_id: task.taskId });
    const sc = r.result.structuredContent as {
      kind: string; status: string; stage: string; chars: number; stages: { name: string; status: string }[];
    };
    assert.equal(sc.kind, "team");
    assert.equal(sc.status, "working");
    assert.equal(sc.stage, "designer");
    assert.equal(sc.chars, 12_400);
    assert.deepEqual(sc.stages.map((s) => `${s.name}:${s.status}`), ["Maya:done", "Theo:done", "Ren:working", "Sam:pending"]);
    await c.close();
  });

  test("a team with five hires still reports everyone, Sam last", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients" });
    const job = Object.values(fake.jobs)[0];
    const hires = ["Ava", "Omar", "Lina", "Kofi", "Mei"].map((name, i) => ({
      key: `custom:${i}0000000-0000-0000-0000-000000000000`, name, title: "Specialist", status: "pending",
    }));
    job.stages = [job.stages![0], ...hires, ...job.stages!.slice(1)];
    job.stage = hires[0].key;
    const r = await callText(c, "check_build", { build_id: task.taskId });
    const sc = r.result.structuredContent as { stage: string; stages: { key: string; name: string }[] };
    assert.equal(sc.stages.length, 9);
    assert.equal(sc.stages.at(-1)!.name, "Sam");
    // The stage key is cut the same way in both places, so the card still finds who is at work.
    assert.equal(sc.stages.find((s) => s.key === sc.stage)?.name, "Ava");
    await c.close();
  });
});


describe("the card's honest states", () => {
  test("a build Shipd can no longer show is 'unknown', never 'failed'", async () => {
    const c = await connect(TOKEN_A);
    const gone = encodeBuildId({ v: 1, kind: "build", job: randomUUID(), project: randomUUID(), prev: 0, t: 1 });
    const r = await callText(c, "check_build", { build_id: gone });
    assert.equal(r.result.isError, true);
    assert.equal((r.result.structuredContent as { status: string }).status, "unknown");
    assert.match(r.text, /^I can't see that build any more/);
    await c.close();
  });

  test("a 'started' id for another org's app is not found, like any other task", async () => {
    const a = await connect(TOKEN_A);
    const r = await a.callTool({ name: "build_app", arguments: { description: "a quick one" } });
    const ref = decodeBuildId((r.structuredContent as { build_id: string }).build_id)!;
    const ackId = encodeBuildId({ ...(ref as object), ack: 1 } as never);
    assert.equal((await a.experimental.tasks.getTask(ackId)).status, "completed");
    const b = await connect(TOKEN_B);
    await assert.rejects(b.experimental.tasks.getTask(ackId));
    await a.close();
    await b.close();
  });
});


// ── the voice page as a host ──────────────────────────────────────────────────

describe("the voice page", () => {
  test("a full-power signed-in session is never accepted here (the page gets a member token)", async () => {
    fake.auth = [];
    const r = await post(mcpUrl, LIST_TOOLS, SESSION_A);
    assert.equal(r.status, 401);
    assert.deepEqual(fake.auth, []); // never reached Shipd
  });

  test("Shipd's own web app may call it from the browser; other sites may not", async () => {
    const apiUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const srv = await listen(
      createApp({
        apiUrl, appUrl: "https://shipd.test", port: 0, host: "127.0.0.1", allowedHosts: [],
        ratePerMin: 1_000_000, corsOrigins: ["https://shipd.test"],
      }),
    );
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    const pre = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://shipd.test", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://shipd.test");
    assert.match(pre.headers.get("access-control-allow-headers") || "", /Authorization/);
    const call = await fetch(url, {
      method: "POST",
      headers: { Origin: "https://shipd.test", "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN_A}` },
      body: LIST_TOOLS,
    });
    assert.equal(call.status, 200);
    assert.equal(call.headers.get("access-control-allow-origin"), "https://shipd.test");
    assert.match(call.headers.get("access-control-expose-headers") || "", /Mcp-Session-Id/);
    const evil = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "POST" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const opaque = await fetch(url, { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "POST" } });
    assert.equal(opaque.status, 403);
    // A refused request still reaches the page as a readable error.
    const broken = await fetch(url, {
      method: "POST",
      headers: { Origin: "https://shipd.test", "Content-Type": "application/json", Authorization: `Bearer ${TOKEN_A}` },
      body: "{not json",
    });
    assert.equal(broken.status, 400);
    assert.equal(broken.headers.get("access-control-allow-origin"), "https://shipd.test");
    srv.close();
  });

  test("check_build carries the team's own voice lines, through to the finished build", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients" });
    const job = Object.values(fake.jobs)[0];
    job.voice = [
      { key: "pm", name: "Maya", text: "Maya here. I'm writing the plan." },
      { key: "pm", name: "Maya", text: "I've written the plan: 5 user stories." },
    ];
    job.voice_total = 2;
    const running = (await callText(c, "check_build", { build_id: task.taskId })).result.structuredContent as {
      voice: { name: string; text: string }[]; voice_total: number;
    };
    assert.equal(running.voice_total, 2);
    assert.deepEqual(running.voice.map((v) => `${v.name}: ${v.text}`), [
      "Maya: Maya here. I'm writing the plan.",
      "Maya: I've written the plan: 5 user stories.",
    ]);
    job.voice.push({ key: "engineer", name: "Sam", text: "It's built. Saving it now." });
    job.voice_total = 3;
    finish(Object.keys(fake.jobs)[0]);
    const done = (await callText(c, "check_build", { build_id: task.taskId })).result.structuredContent as {
      status: string; voice_total: number; voice: { text: string }[];
    };
    assert.equal(done.status, "completed");
    assert.equal(done.voice_total, 3);
    assert.equal(done.voice.at(-1)!.text, "It's built. Saving it now.");
    await c.close();
  });
});

describe("sign in with Shipd (OAuth)", () => {
  const ISSUER = "https://api.shipd.test";
  async function oauthServer() {
    const apiUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const srv = await listen(
      createApp({
        apiUrl, appUrl: "https://shipd.test", port: 0, host: "127.0.0.1", allowedHosts: [], ratePerMin: 1_000_000,
        oauthIssuer: ISSUER, publicUrl: "https://mcp.shipd.test",
      }),
    );
    return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
  }
  const listBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const rpcHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

  test("the metadata names Shipd as where a token comes from, for any origin", async () => {
    const { srv, base } = await oauthServer();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(base + path, { headers: { Origin: "https://claude.ai" } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const m = (await res.json()) as { resource: string; authorization_servers: string[] };
      assert.equal(m.resource, "https://mcp.shipd.test/mcp");
      assert.deepEqual(m.authorization_servers, [ISSUER]);
    }
    const pre = await fetch(base + "/.well-known/oauth-protected-resource/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "mcp-protocol-version" },
    });
    assert.equal(pre.status, 204);
    srv.close();
  });

  test("a 401 points at the metadata; a refused token also says invalid_token", async () => {
    const { srv, base } = await oauthServer();
    const none = await fetch(base + "/mcp", { method: "POST", headers: rpcHeaders, body: listBody });
    assert.equal(none.status, 401);
    const h = none.headers.get("www-authenticate") || "";
    assert.match(h, /resource_metadata="https:\/\/mcp\.shipd\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.doesNotMatch(h, /invalid_token/);
    const garbage = await fetch(base + "/mcp", { method: "POST", headers: { ...rpcHeaders, Authorization: "Bearer nope" }, body: listBody });
    assert.match(garbage.headers.get("www-authenticate") || "", /error="invalid_token"/);
    srv.close();
  });

  test("an expired token gets a 401 the client can refresh on, not a tool error", async () => {
    const { srv, base } = await oauthServer();
    const expired = "shp_" + "z".repeat(43); // Shipd says 401 to it
    const res = await fetch(base + "/mcp", { method: "POST", headers: { ...rpcHeaders, Authorization: `Bearer ${expired}` }, body: listBody });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") || "", /error="invalid_token"/);
    // A live token is checked once, then trusted for a while (no extra call per request).
    const before = fake.auth.length;
    for (let i = 0; i < 3; i++) {
      const ok = await fetch(base + "/mcp", { method: "POST", headers: { ...rpcHeaders, Authorization: `Bearer ${TOKEN_A}` }, body: listBody });
      assert.equal(ok.status, 200);
    }
    assert.equal(fake.auth.length - before, 1);
    srv.close();
  });

  test("without an issuer nothing changes: no metadata, the old 401", async () => {
    const res = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl));
    assert.equal(res.status, 404);
    const none = await fetch(mcpUrl, { method: "POST", headers: rpcHeaders, body: listBody });
    assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="shipd"');
  });
});


describe("hands-free in a spoken conversation (watch_build)", () => {
  test("it returns the team's new lines, waits for the next ones, and says when the app is ready", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients", answers: "skip" });
    const job = Object.values(fake.jobs)[0];
    job.voice = [
      { key: "pm", name: "Maya", text: "Maya here. I'm writing the plan." },
      { key: "pm", name: "Maya", text: "It's for walk-in clients." },
    ];
    job.voice_total = 2;
    const firstCall = await callText(c, "watch_build", { build_id: task.taskId, wait_seconds: 5 });
    const first = firstCall.result.structuredContent as {
      new_lines: { name: string; text: string }[]; voice_total: number; status: string;
    };
    // No card in a spoken conversation: the first call says where to watch.
    assert.match(firstCall.text, /watch the team work at shipd\.test\/live/);
    assert.match(c.getInstructions() ?? "", /watch the team work at shipd\.test\/live/);
    assert.equal(first.status, "working");
    assert.deepEqual(first.new_lines.map((l) => l.text), ["Maya here. I'm writing the plan.", "It's for walk-in clients."]);
    assert.equal(first.voice_total, 2);

    // Nothing new: it waits, and returns as soon as the next line is said.
    setTimeout(() => {
      job.voice!.push({ key: "director", name: "Theo", text: "Theo here. I'm choosing the look and feel." });
      job.voice_total = 3;
    }, 1000);
    const t0 = Date.now();
    const nextCall = await callText(c, "watch_build", { build_id: task.taskId, heard: 2, wait_seconds: 20 });
    const next = nextCall.result.structuredContent as {
      new_lines: { name: string }[]; voice_total: number;
    };
    assert.doesNotMatch(nextCall.text, /\/live/); // said once, not every call
    assert.ok(Date.now() - t0 < 10_000);
    assert.deepEqual(next.new_lines.map((l) => l.name), ["Theo"]);
    assert.equal(next.voice_total, 3);

    finish(Object.keys(fake.jobs)[0]);
    const done = await callText(c, "watch_build", { build_id: task.taskId, heard: 3, wait_seconds: 5 });
    assert.equal((done.result.structuredContent as { status: string }).status, "completed");
    assert.match(done.text, /ready/);
    await c.close();
  });

  test("Shipd's own voice page never gets it (it speaks the team itself)", async () => {
    const apiUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const srv = await listen(
      createApp({ apiUrl, appUrl: "https://shipd.test", port: 0, host: "127.0.0.1", allowedHosts: [], ratePerMin: 1_000_000, corsOrigins: ["https://shipd.test"] }),
    );
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    const list = async (origin?: string) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...(origin ? { Origin: origin } : {}),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      return res.text();
    };
    const fromPage = await list("https://shipd.test");
    assert.doesNotMatch(fromPage, /watch_build|speak_line/);
    assert.match(fromPage, /tell_team/); // the voice page's backend knows this one
    assert.match(await list(), /watch_build/);
    assert.match(await list(), /speak_line/);
    srv.close();
  });
});

describe("talking to the team mid-build (tell_team)", () => {
  test("the note reaches the build and the team member answers by name", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients", answers: "skip" });
    const r = await callText(c, "tell_team", { build_id: task.taskId, to: "Theo", note: "make it darker" });
    assert.equal(r.result.isError, undefined);
    assert.equal(r.text, "Theo: Darker it is, I'll hand it to Ren and Sam.");
    const sc = r.result.structuredContent as { to: string; name: string; taken: boolean; by: string[] };
    assert.deepEqual([sc.to, sc.name, sc.taken, sc.by], ["director", "Theo", true, ["Ren", "Sam"]]);
    assert.deepEqual(fake.notes.map((n) => [n.to, n.text]), [["Theo", "make it darker"]]);

    // Finished: Shipd's own sentence, said as it is.
    finish(Object.keys(fake.jobs)[0]);
    const late = await callText(c, "tell_team", { build_id: task.taskId, to: "Theo", note: "darker" });
    assert.equal(late.result.isError, true);
    assert.match(late.text, /finished this build/);
    await c.close();
  });

  test("a quick build has nobody to talk to, and a switched-off account says so", async () => {
    const c = await connect(TOKEN_A);
    const quick = await startTask(c, "build_app", { description: "A todo list for my class", answers: "skip" });
    const r = await callText(c, "tell_team", { build_id: quick.taskId, to: "Theo", note: "darker" });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /isn't a running team build/);

    const team = await startTask(c, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients", answers: "skip" });
    fake.notesOff = true;
    try {
      const off = await callText(c, "tell_team", { build_id: team.taskId, to: "Theo", note: "darker" });
      assert.equal(off.result.isError, true);
      assert.match(off.text, /isn't switched on/);
    } finally {
      fake.notesOff = false;
    }
    await c.close();
  });

  test("another account cannot talk to someone else's team", async () => {
    const a = await connect(TOKEN_A);
    const task = await startTask(a, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients", answers: "skip" });
    const b = await connect(TOKEN_B);
    const r = await callText(b, "tell_team", { build_id: task.taskId, to: "Theo", note: "make it pink" });
    assert.equal(r.result.isError, true);
    assert.equal(fake.notes.length, 0);
    await a.close();
    await b.close();
  });
});

describe("the build card's team room", () => {
  test("it has a team chat and a Listen button, both left out on the voice page", async () => {
    const { cardHtml } = await import("../src/card.js");
    const html = cardHtml();
    assert.match(html, /Team chat/);
    assert.match(html, /id="listen"/);
    assert.match(html, /shipdVoice === true/);
  });
});


describe("the team's own voices in the card (speak_line)", () => {
  test("it returns the line as audio in that person's voice, through Shipd", async () => {
    const c = await connect(TOKEN_A);
    const r = await c.callTool({ name: "speak_line", arguments: { voice: "pm", text: "It's for walk-in clients." } });
    const audio = (r.content as { type: string; data?: string; mimeType?: string }[])[0];
    assert.equal(audio.type, "audio");
    assert.equal(audio.mimeType, "audio/mpeg");
    assert.equal(Buffer.from(audio.data!, "base64").toString(), "ID3-fake-mp3");
    assert.deepEqual(fake.spoken, ["pm: It's for walk-in clients."]);
    await c.close();
  });

  test("with voices off for the account it says so (the card falls back to the device's voices)", async () => {
    fake.voiceOff = true;
    const c = await connect(TOKEN_A);
    const r = await c.callTool({ name: "speak_line", arguments: { voice: "pm", text: "Hello." } });
    assert.equal(r.isError, true);
    await c.close();
  });

  test("only known speakers", async () => {
    const c = await connect(TOKEN_A);
    const r = await c.callTool({ name: "speak_line", arguments: { voice: "someone", text: "Hello." } });
    assert.equal(r.isError, true);
    assert.deepEqual(fake.spoken, []);
    await c.close();
  });
});

describe("a chat reopened later (the card is drawn again from the old result)", () => {
  test("check_build carries when the build started, so the card shows the real time", async () => {
    const c = await connect(TOKEN_A);
    const before = Date.now();
    const task = await startTask(c, "build_with_team", { description: "A booking site for a barbershop, for walk-in clients", answers: "skip" });
    const sc = (await callText(c, "check_build", { build_id: task.taskId })).result.structuredContent as { started_at: number; updated_at: string };
    assert.ok(sc.started_at >= before - 5 && sc.started_at <= Date.now());
    assert.ok(Date.parse(sc.updated_at) > 0);
    await c.close();
  });

  test("after Shipd forgets the job (an hour on), a saved app still comes back as the result", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "A booking site for a barbershop, for walk-in clients", answers: "skip" });
    const jobId = Object.keys(fake.jobs)[0];
    finish(jobId);
    delete fake.jobs[jobId]; // the backend's job record expired
    const r = (await callText(c, "check_build", { build_id: task.taskId })).result;
    const sc = r.structuredContent as { status: string; version: number; link: string };
    assert.equal(r.isError, undefined);
    assert.equal(sc.status, "completed");
    assert.equal(sc.version, 1);
    assert.match(sc.link, /^https:\/\/shipd\.test\/builder\?project=/);
    await c.close();
  });

  test("with nothing saved it is still 'unknown', never a made-up success", async () => {
    const c = await connect(TOKEN_A);
    const task = await startTask(c, "build_app", { description: "A booking site for a barbershop, for walk-in clients", answers: "skip" });
    delete fake.jobs[Object.keys(fake.jobs)[0]];
    const sc = (await callText(c, "check_build", { build_id: task.taskId })).result.structuredContent as { status: string };
    assert.equal(sc.status, "unknown");
    await c.close();
  });

  test("the card checks before it shows anyone at work, and keeps the build's own times", async () => {
    const { cardHtml } = await import("../src/card.js");
    const html = cardHtml();
    assert.match(html, /Checking on your build/);
    assert.match(html, /sc\.started_at/);
    assert.match(html, /sc\.updated_at/);
  });
});

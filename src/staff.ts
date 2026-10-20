// Staffing the AI Team by conversation: who is on it, interviewing a new
// specialist before hiring them, hiring them into the pipeline, and letting
// anyone go (or bringing them back). The same Shipd routes as the builder's
// Team office, so a hire made here shows up there, and the reverse.
//
// A hired specialist is a "deliverable" seat: they work after the teammate
// they follow, and their notes go to Devin and Sam (in the builder, and in a
// build_with_team build). Interviews and hires are paid, like the office;
// letting someone go is free.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ShipdError, undash, type ShipdClient, type TeamRoster, type TeamSeat } from "./shipd.js";

/** The built-in five, by the names people say. Kai (the Forward Engineer)
 * works on connected repositories and is not part of these builds. */
export const DEFAULTS: Record<string, { key: string; name: string; does: string }> = {
  maya: { key: "pm", name: "Maya", does: "the plan" },
  theo: { key: "director", name: "Theo", does: "the look" },
  ren: { key: "designer", name: "Ren", does: "the screens" },
  devin: { key: "backend", name: "Devin", does: "the backend" },
  sam: { key: "engineer", name: "Sam", does: "the app itself" },
};
const DEFAULT_KEYS = new Set(Object.values(DEFAULTS).map((d) => d.key));
const AFTER = ["pm", "director", "designer", "backend"] as const;
const AFTER_NAME: Record<(typeof AFTER)[number], string> = {
  pm: "Maya",
  director: "Theo",
  designer: "Ren",
  backend: "Devin",
};

function said(message: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: undash(message) }], ...(structured ? { structuredContent: structured } : {}) };
}

function refused(err: unknown, offMessage: string): CallToolResult {
  // The custom-agents switch answers a plain 404 ("Custom agents are not enabled.").
  if (err instanceof ShipdError && err.status === 404 && /not enabled/i.test(err.detail ?? "")) {
    return { content: [{ type: "text", text: offMessage }], isError: true };
  }
  const message = err instanceof ShipdError ? err.message : "Something went wrong talking to Shipd.";
  return { content: [{ type: "text", text: undash(message) }], isError: true };
}

const OFF = "Hiring and firing your AI Team isn't switched on for your Shipd account yet.";

function listed(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The people who work in these builds, in order (no Kai). */
export function team(roster: TeamRoster): TeamSeat[] {
  return roster.pipeline.filter((s) => s.kind === "custom" || DEFAULT_KEYS.has(s.key));
}

/** How each of the five is said out loud. */
const SAID_AS: Record<string, string> = {
  pm: "the product manager",
  director: "the design director",
  designer: "the designer",
  backend: "the backend engineer",
  engineer: "the frontend engineer",
};

/** "Copywriter" -> "copywriter", "SEO Expert" -> "SEO expert". */
function spokenTitle(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .map((w) => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w))
    .join(" ");
}

/** "Your team, in order: Maya the product manager, Ava the copywriter you hired, ..." */
export function rosterLine(roster: TeamRoster): string {
  const seats = team(roster);
  const parts = seats.map((s) => {
    if (s.kind === "custom") {
      const title = spokenTitle(s.title || "");
      return title ? `${s.name} the ${title} you hired` : `${s.name}, a specialist you hired`;
    }
    return `${s.name} ${SAID_AS[s.key] ?? spokenTitle(s.title || "")}`;
  });
  let line = parts.length ? `Your team, in order: ${listed(parts)}.` : "Nobody is on your team right now.";
  const gone = roster.fired.filter((f) => DEFAULT_KEYS.has(f.key)).map((f) => f.name);
  if (gone.length) line += ` Let go: ${listed(gone)}.`;
  const bench = roster.benched.map((b) => b.name);
  if (bench.length) line += ` Hired before but not working on builds: ${listed(bench)}.`;
  return line;
}

/** Who "who" means: one of the five, or someone they hired. */
export function resolve(who: string, roster: TeamRoster): { kind: "default"; key: string; name: string } | { kind: "custom"; id: string; name: string; seated: boolean; scope?: string } | null {
  const name = who.trim().toLowerCase().replace(/^(the\s+)?/, "");
  const d = DEFAULTS[name];
  if (d) return { kind: "default", key: d.key, name: d.name };
  const seat = roster.pipeline.find((s) => s.kind === "custom" && s.name.trim().toLowerCase() === name);
  if (seat?.agentId) return { kind: "custom", id: seat.agentId, name: seat.name, seated: true, scope: seat.scope };
  const benched = roster.benched.find((b) => b.name.trim().toLowerCase() === name);
  if (benched) return { kind: "custom", id: benched.id, name: benched.name, seated: false };
  return null;
}

const candidateShape = {
  name: z.string().min(1).max(60).describe('Their first name ("Ava").'),
  title: z.string().min(1).max(60).describe('Their job title ("Copywriter").'),
  brief: z
    .string()
    .min(1)
    .max(2000)
    .describe("What they own and how they work, in the second person, written from what the person wants (\"You write the website's words for a home bakery: warm, short, in the owner's voice.\")."),
};

export function registerStaffTools(server: McpServer, client: ShipdClient): void {
  server.registerTool(
    "team_roster",
    {
      title: "Who is on the AI Team",
      description:
        "Who works on the person's AI Team builds, in order (Maya the product manager, Theo the design director, Ren the designer, Devin the backend engineer, Sam the engineer, and anyone they hired), plus who they let go.",
      inputSchema: {
        app_id: z.string().uuid().optional().describe("An app, to include people hired just for it."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app_id }) => {
      try {
        const roster = await client.teamRoster(app_id);
        return said(rosterLine(roster), {
          team: team(roster).map((s) => ({ name: s.name, title: s.title, kind: s.kind, after: s.anchor ?? null })),
          let_go: roster.fired.filter((f) => DEFAULT_KEYS.has(f.key)).map((f) => f.name),
          bench: roster.benched.map((b) => b.name),
        });
      } catch (err) {
        return refused(err, OFF);
      }
    },
  );

  server.registerTool(
    "interview_candidate",
    {
      title: "Interview a new specialist",
      description:
        "Interview someone before hiring them onto the AI Team (a copywriter, an SEO expert, a brand strategist...). Draft the candidate from what the person wants: a name, a job title and a brief. Pass the person's question; the candidate answers in character (on Shipd's voice page, in their own voice: then say nothing yourself). Keep the same name, title and brief for every question in one interview and pass the earlier turns as history. Nothing is saved: hire_specialist hires them.",
      inputSchema: {
        ...candidateShape,
        question: z.string().min(1).max(500).describe("The person's question, in their words."),
        history: z
          .array(z.object({ role: z.enum(["user", "candidate"]), text: z.string().max(1200) }))
          .max(12)
          .optional()
          .describe("Earlier questions (user) and answers (candidate) in this interview."),
        voice: z
          .enum(["woman", "man"])
          .optional()
          .describe("Which of the two candidate voices suits the name you gave them; keep it for the whole interview."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name, title, brief, question, history, voice }) => {
      try {
        const answer = await client.interviewCandidate({ name, title, instructions: brief }, question, history ?? []);
        if (!answer.trim()) throw new ShipdError(502, "The candidate couldn't answer just now. Ask again.");
        return said(`${name}: ${answer}`, {
          name,
          title,
          answer: undash(answer),
          voice: voice === "man" ? "specialist_m" : "specialist",
        });
      } catch (err) {
        return refused(err, OFF);
      }
    },
  );

  server.registerTool(
    "hire_specialist",
    {
      title: "Hire a specialist",
      description:
        "Hire someone onto the AI Team, usually after an interview (use the same name, title and brief). They work after the teammate they follow and hand their notes to Devin and Sam, from the next team build on: after pm (Maya's plan) suits copy and strategy, after director (Theo's look) suits brand, after designer (Ren's screens) suits accessibility or content, after backend (Devin's API) suits data or integrations.",
      inputSchema: {
        ...candidateShape,
        after: z.enum(AFTER).default("pm").describe("Whose work they follow."),
        one_line: z.string().max(120).optional().describe("What they do, in a few words, for the team office."),
        app_id: z.string().uuid().optional().describe("Hire them for one app only; leave out to hire them for every build."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, title, brief, after, one_line, app_id }) => {
      try {
        const roster = await client.teamRoster(app_id);
        if (resolve(name, roster)) {
          return said(`Someone called ${name} is already on the team or the bench. Pick another name, or bring ${name} back with rehire_teammate.`);
        }
        const taken = new Set(roster.pipeline.map((s) => s.color).filter(Boolean));
        const color = roster.colors.find((c) => !taken.has(c)) ?? roster.colors[0] ?? "";
        const agent = await client.createAgent({ name, title, instructions: brief, blurb: one_line ?? title, color });
        await client.seatAgent(agent.id, after, app_id);
        const scope = app_id ? "on this app" : "on every team build";
        return said(
          `${name} is on the team now, ${scope}, working after ${AFTER_NAME[after]}. From the next team build, ${name}'s notes go to Devin and Sam.`,
          { name, title, after, agent_id: agent.id, scope: app_id ? "app" : "all" },
        );
      } catch (err) {
        return refused(err, OFF);
      }
    },
  );

  server.registerTool(
    "fire_teammate",
    {
      title: "Let a teammate go",
      description:
        "Take someone off the AI Team: one of the five (Maya, Theo, Ren, Devin, Sam) or someone they hired. Team builds then skip their part. It can be undone with rehire_teammate. Letting Sam go means nobody builds the app, so say so before you do it.",
      inputSchema: {
        who: z.string().min(1).max(40).describe('Their name ("Theo").'),
        app_id: z.string().uuid().optional().describe("Only on this app; leave out for every build."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ who, app_id }) => {
      try {
        const roster = await client.teamRoster(app_id);
        const person = resolve(who, roster);
        if (!person) return said(`There's nobody called ${who} on the team. ${rosterLine(roster)}`);
        if (person.kind === "default") {
          await client.setDefaultFired(person.key, true, app_id);
          const d = Object.values(DEFAULTS).find((x) => x.key === person.key)!;
          const after =
            person.key === "engineer"
              ? " With Sam gone nobody builds the app, so team builds won't start until you bring Sam back."
              : ` Team builds now go on without ${d.does}.`;
          return said(`Done, ${person.name} is off the team${app_id ? " on this app" : ""}.${after}`, { who: person.name, fired: true });
        }
        if (!person.seated) {
          // Without an app, the roster only shows seats on every build; someone
          // hired for one app reads as benched here.
          return said(
            app_id
              ? `${person.name} isn't working on this app right now.`
              : `${person.name} isn't on every build. If ${person.name} works on one app, tell me which app.`,
          );
        }
        await client.seatAgent(person.id, null, person.scope === "project" ? app_id : undefined);
        return said(`Done, ${person.name} is off the team. You can bring ${person.name} back any time.`, { who: person.name, fired: true });
      } catch (err) {
        return refused(err, OFF);
      }
    },
  );

  server.registerTool(
    "rehire_teammate",
    {
      title: "Bring a teammate back",
      description:
        "Bring back someone who was let go: one of the five, or someone hired earlier (they follow the teammate in `after`, Maya by default).",
      inputSchema: {
        who: z.string().min(1).max(40).describe('Their name ("Theo").'),
        after: z.enum(AFTER).optional().describe("For someone they hired: whose work they follow."),
        app_id: z.string().uuid().optional().describe("Only on this app; leave out for every build."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ who, after, app_id }) => {
      try {
        const roster = await client.teamRoster(app_id);
        const person = resolve(who, roster);
        if (!person) return said(`There's nobody called ${who} to bring back. ${rosterLine(roster)}`);
        if (person.kind === "default") {
          await client.setDefaultFired(person.key, false, app_id);
          return said(`${person.name} is back on the team.`, { who: person.name, fired: false });
        }
        if (person.seated) return said(`${person.name} is already on the team.`);
        const anchor = after ?? "pm";
        await client.seatAgent(person.id, anchor, app_id);
        return said(`${person.name} is back on the team, working after ${AFTER_NAME[anchor]}.`, { who: person.name, fired: false, after: anchor });
      } catch (err) {
        return refused(err, OFF);
      }
    },
  );
}

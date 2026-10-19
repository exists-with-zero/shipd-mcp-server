// One quick question before a build (MCP elicitation, form mode).
//
// When a description is short, Shipd asks who the app is for and what it must
// do, with options tailored to that app (Shipd's own pre-build questionnaire),
// and builds with the answer. It only asks a client that said it can show a
// form (or speak one), only on a session (the answer has to come back to this
// server), and never blocks a build: a skip, a timeout or any failure just
// builds from the description as given. The one exception: if the client gave
// up on the call while the question was open, nothing is built (see
// gaveUp in server.ts), because nobody would ever hear about that build.

import type { CreateTaskRequestHandlerExtra } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ShipdClient } from "./shipd.js";

/** A description with at least this many words already says enough. */
export const DETAILED_WORDS = 30;
/** How long to wait for the person before building anyway. Under the 60 s a
 * client (the TypeScript SDK's default) gives a call before giving up on it. */
export const ANSWER_WAIT_MS = 50_000;
const OPTIONS_WAIT_MS = 8_000;

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function options(list: unknown, max: number): string[] {
  if (!Array.isArray(list)) return [];
  const out = list.map((o) => clip(o, 40)).filter(Boolean);
  return [...new Set(out)].slice(0, max);
}

export function shouldAsk(description: string, answers?: string): boolean {
  if (answers?.trim()) return false; // the assistant already asked
  return description.trim().split(/\s+/).length < DETAILED_WORDS;
}

/** The answer, written the way a person would add it to their request. */
export function answersText(content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  const who = clip(content.audience, 60);
  if (who) parts.push(`It's for: ${who}.`);
  const must = Array.isArray(content.must_haves)
    ? content.must_haves.map((m) => clip(m, 40)).filter(Boolean).slice(0, 6)
    : [];
  if (must.length) parts.push(`Must have: ${must.join(", ")}.`);
  const notes = clip(content.notes, 300);
  if (notes) parts.push(notes);
  return parts.join(" ");
}

/**
 * Ask, and return what the person added ("" when they skipped or nothing
 * could be asked). Never throws.
 */
export async function askBeforeBuilding(
  server: McpServer,
  client: ShipdClient,
  extra: CreateTaskRequestHandlerExtra,
  description: string,
  answers?: string,
): Promise<string> {
  if (!shouldAsk(description, answers)) return "";
  // Form support: the 2025-11-25 `{ form: {} }`, or the older bare `{}`.
  const can = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (!can || (Object.keys(can).length > 0 && !can.form)) return "";
  if (!extra.sessionId) return ""; // no session: the answer could not reach us

  let audience: string[] = [];
  let features: string[] = [];
  try {
    const q = await Promise.race([
      client.clarify(description),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow")), OPTIONS_WAIT_MS)),
    ]);
    audience = options(q.audience, 4);
    features = options(q.features, 6);
  } catch {
    return ""; // no tailored options: build rather than ask a vague question
  }
  if (audience.length < 2) return "";

  try {
    const result = await extra.sendRequest(
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Quick question before I build: who is it for, and what must it do? Skip it and I'll decide.",
          requestedSchema: {
            type: "object",
            properties: {
              audience: { type: "string", title: "Who is it for?", enum: audience },
              ...(features.length >= 2
                ? {
                    must_haves: {
                      type: "array",
                      title: "Must-haves",
                      items: { type: "string", enum: features },
                    },
                  }
                : {}),
              notes: { type: "string", title: "Anything else?", maxLength: 300 },
            },
          },
        },
      },
      ElicitResultSchema,
      // The call's own signal: if the client gives up, so does the question.
      { timeout: ANSWER_WAIT_MS, signal: extra.signal },
    );
    return result.action === "accept" ? answersText(result.content) : "";
  } catch {
    return ""; // timed out or the client failed: build anyway
  }
}

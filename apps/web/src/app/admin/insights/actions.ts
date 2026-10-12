"use server";
/**
 * admin-insights: suggestion accept (→ a proposal to confirm) / dismiss, and confirming that proposal. ops+.
 * No revalidate: the card keeps its own state through accept → confirm; the stats do not change from these.
 */
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import type { Actor } from "@/services/kernel";
import { isServiceError, type ServiceErrorCode, userMessage } from "@/services/kernel/errors";
import { acceptSuggestion, dismissSuggestion, excludeDay } from "@/services/learning/insights";
import { confirm } from "@/services/mcp/proposals";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: ServiceErrorCode };

const field = (form: FormData, k: string) => String(form.get(k) ?? "");

async function run<T extends object>(
  form: FormData,
  fn: (actor: Actor, workspaceId: string) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const { actor, workspace } = await requireAdmin({ w: (form.get("w") as string | null) ?? null, minRole: "ops" });
    const out = await fn(actor, workspace.id);
    return { ok: true, ...out };
  } catch (e) {
    // requireAdmin redirects by throwing; let Next handle that
    if (e instanceof Error && "digest" in e) throw e;
    if (!isServiceError(e)) {
      console.error("admin-insights action failed", e);
      return { ok: false, error: userMessage(e) };
    }
    // the card needs GONE / STALE_VERSION to offer a fresh proposal
    return { ok: false, error: userMessage(e), code: e.code };
  }
}

export async function acceptSuggestionAction(_: unknown, form: FormData) {
  return run(form, async (actor, workspaceId) => {
    const r = await acceptSuggestion(db(), actor, { workspaceId, suggestionId: field(form, "suggestionId") });
    return { proposalCode: r.proposalCode, summary: r.summary };
  });
}

export async function dismissSuggestionAction(_: unknown, form: FormData) {
  return run(form, async (actor, workspaceId) => {
    await dismissSuggestion(db(), actor, { workspaceId, suggestionId: field(form, "suggestionId") });
    return {};
  });
}

export async function confirmProposalAction(_: unknown, form: FormData) {
  return run(form, async (actor) => {
    const r = await confirm(db(), actor, { code: field(form, "code") }, new Date());
    return { summary: r.summary };
  });
}

/** "Don't learn from this day" (SPEC §6a): e.g. a road closure. */
export async function excludeDayAction(_: unknown, form: FormData) {
  return run(form, async (actor, workspaceId) => {
    const date = field(form, "date");
    await excludeDay(db(), actor, { workspaceId, date, reason: field(form, "reason").trim() || null });
    return { date };
  });
}

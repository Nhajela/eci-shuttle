import { formatIst } from "@eci-shuttle/shared";
import type { Metadata } from "next";
import {
  AddMemberForm,
  AlertPrefsForm,
  CreateTokenForm,
  RevokeTokenButton,
  RoleForm,
} from "@/components/admin/people/forms";
import {
  personName,
  ROLE_HINT,
  ROLE_LABEL,
  subscriberRows,
  tokenStatus,
  tokenUsed,
} from "@/components/admin/people/people";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { getAlertPrefs } from "@/services/alerts/prefs";
import { listMembers } from "@/services/catalog/people";
import { listSpots } from "@/services/catalog/spots";
import { listTokens } from "@/services/mcp/tokens";
import { subscriberCounts } from "@/services/subscriptions/subscriptions";

/** admin-people (SPEC §7): Admins and roles, alert settings, MCP tokens, subscriber counts. Components live in components/admin/people/. */
export const metadata: Metadata = { title: "People" };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { person, workspace, role, actor } = await requireAdmin({ w });
  const now = new Date();
  const input = { workspaceId: workspace.id };
  const [members, prefs, tokens, counts, spots] = await Promise.all([
    listMembers(db(), actor, input),
    getAlertPrefs(db(), actor, input),
    listTokens(db(), actor),
    subscriberCounts(db(), actor, input, now),
    listSpots(db(), actor, { ...input, includeArchived: true }),
  ]);
  const slug = workspace.slug;
  const isAdmin = role === "admin";
  const subs = subscriberRows(counts, spots);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:grid md:grid-cols-2 md:items-start">
      <h1 className="text-xl font-semibold md:col-span-2">People</h1>

      <Card>
        <CardHeader>
          <CardTitle>Team in {workspace.name}</CardTitle>
          <CardDescription>
            {isAdmin ? "Change roles or add someone by Telegram username." : "Only admins can change roles."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col divide-y">
            {members.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 py-3 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{personName(m.person)}</span>
                  {m.personId === person.id && <Badge variant="secondary">You</Badge>}
                  {m.person.blockedBotAt && <Badge variant="destructive">Blocked the bot</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{ROLE_LABEL[m.role]}</span> · {ROLE_HINT[m.role]}
                </p>
                {isAdmin && <RoleForm w={slug} personId={m.personId} role={m.role} isSelf={m.personId === person.id} />}
              </li>
            ))}
          </ul>
          {isAdmin && (
            <div className="border-t pt-4">
              <h2 className="mb-3 font-medium">Add someone</h2>
              <AddMemberForm w={slug} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle>Your alerts</CardTitle>
          <CardDescription>What the bot sends you for {workspace.name}. Only you see these.</CardDescription>
        </CardHeader>
        <CardContent>
          <AlertPrefsForm
            w={slug}
            kinds={prefs.kinds}
            quietFrom={prefs.quietFrom}
            quietTo={prefs.quietTo}
            version={prefs.version}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your MCP tokens</CardTitle>
          <CardDescription>
            For AI agents like Claude Code. A token acts as you, in every workspace you belong to.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CreateTokenForm w={slug} />
          {tokens.length > 0 && (
            <ul className="flex flex-col divide-y border-t">
              {tokens.map((t) => {
                const status = tokenStatus(t, now.getTime());
                return (
                  <li key={t.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{t.name}</span>
                      <Badge variant={status === "active" ? "outline" : "secondary"}>
                        {t.kind === "oauth" ? (t.client ?? "OAuth") : "Personal"}
                      </Badge>
                      {status !== "active" && <Badge variant="destructive">{status}</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      <code>{t.prefix}…</code> · Created {formatIst(t.createdAt)} · {tokenUsed(t)}
                      {t.expiresAt && status === "active" && ` · Expires ${formatIst(t.expiresAt)}`}
                    </p>
                    {status === "active" && <RevokeTokenButton w={slug} tokenId={t.id} />}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attendee subscribers</CardTitle>
          <CardDescription>Open bot subscriptions right now.</CardDescription>
        </CardHeader>
        <CardContent>
          {subs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody has subscribed yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {subs.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 py-3 first:pt-0">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-right text-sm text-muted-foreground">
                    {s.notices} notices · {s.arrivalAlerts} arrival alerts
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

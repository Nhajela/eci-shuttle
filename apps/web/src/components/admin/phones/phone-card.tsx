"use client";

import type { Role } from "@eci-shuttle/shared";
import { cn } from "cn";
import { useState } from "react";
import {
  assignPhoneAction,
  cancelDirectiveAction,
  forceActiveAction,
  killPhoneAction,
  labelPhoneAction,
  movePhoneAction,
  nudgePhoneAction,
  phoneUpdateAction,
  revokePhoneAction,
  silencePhoneAction,
} from "@/app/admin/phones/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmButton } from "./confirm-button";
import { useAction } from "./use-action";
import {
  agoText,
  directiveText,
  istInputValue,
  istWhen,
  type PhoneView,
  phoneProblems,
  phoneStatus,
  type Tone,
} from "./view";

type Option = { id: string; name: string };

const TONE: Record<Tone, string> = {
  ok: "bg-emerald-600/15 text-emerald-800 dark:text-emerald-300",
  warn: "bg-amber-500/20 text-amber-900 dark:text-amber-200",
  bad: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

const SELECT =
  "h-11 w-full rounded-(--radius-field) border border-input bg-background px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export function PhoneCard({
  h,
  now,
  w,
  role,
  vehicles,
  moveTargets,
  workspaceTarget,
}: {
  h: PhoneView;
  now: number;
  w: string;
  role: Role;
  vehicles: Option[];
  moveTargets: Option[];
  workspaceTarget: string | null;
}) {
  const d = h.device;
  const status = phoneStatus(h, now);
  const problems = phoneProblems(h, now);
  const { pending, run } = useAction();
  const canOps = role !== "viewer" && !d.revokedAt;
  const isAdmin = role === "admin" && !d.revokedAt;

  const [label, setLabel] = useState(d.label);
  const [vehicleId, setVehicleId] = useState(h.vehicle?.id ?? "");
  const [silenceUntil, setSilenceUntil] = useState(istInputValue(now + 3_600_000));
  const [hours, setHours] = useState("2");
  const [updateId, setUpdateId] = useState(d.targetUpdateId ?? "");
  const [moveTo, setMoveTo] = useState(moveTargets[0]?.id ?? "");
  const target = d.targetUpdateId ?? workspaceTarget;
  const id = d.id;

  return (
    <Card size="sm" className={cn(d.revokedAt && "opacity-70")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="min-w-0 break-words">{d.label}</CardTitle>
          <Badge className={TONE[status.tone]}>{status.label}</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {h.vehicle ? h.vehicle.name : "No vehicle"} · seen {agoText(h.lastSyncAgoS)}
          {d.battery !== null && ` · ${Math.round(d.battery)}%${d.charging ? " charging" : ""}`}
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {problems.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-lg bg-amber-500/10 p-2 text-sm">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Told</dt>
          <dd>
            {h.desiredMode} · config v{d.configVersion}
          </dd>
          <dt className="text-muted-foreground">Reports</dt>
          <dd>
            {d.reportedMode ?? "nothing yet"} · config v{d.reportedConfigVersion ?? "–"}
          </dd>
          <dt className="text-muted-foreground">App</dt>
          <dd className="min-w-0 break-all">
            {d.appVersion ?? "?"} · {d.updateId ? <span className="font-mono">{d.updateId}</span> : "built-in"}
            {target && target !== d.updateId && (
              <>
                {" "}
                → <span className="font-mono">{target}</span>
              </>
            )}
          </dd>
          {d.model && (
            <>
              <dt className="text-muted-foreground">Model</dt>
              <dd>{d.model}</dd>
            </>
          )}
          {d.killedAt && (
            <>
              <dt className="text-muted-foreground">Killed</dt>
              <dd>{istWhen(d.killedAt, now)} · only the driver's Resume clears it</dd>
            </>
          )}
        </dl>

        {h.activeDirectives.map((x) => (
          <div key={x.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted p-2 text-sm">
            <span>{directiveText(x, now)}</span>
            {canOps && (
              <Button
                variant="outline"
                className="h-11"
                disabled={pending}
                onClick={() => run(() => cancelDirectiveAction(w, x.id), "Cancelled")}
              >
                Cancel
              </Button>
            )}
          </div>
        ))}

        {canOps && (
          <>
            <Button
              variant="secondary"
              className="h-11"
              disabled={pending}
              onClick={() => run(() => nudgePhoneAction(w, id), "Nudge sent: the phone syncs now")}
            >
              Nudge (sync now)
            </Button>

            <details className="group rounded-lg border p-3">
              <summary className="-m-3 flex min-h-11 cursor-pointer items-center p-3 font-medium">More actions</summary>
              <div className="mt-3 flex flex-col gap-4">
                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => silencePhoneAction(w, id, silenceUntil), "Silenced");
                  }}
                >
                  <Label htmlFor={`silence-${id}`}>Silence until (IST)</Label>
                  <div className="flex gap-2">
                    <Input
                      id={`silence-${id}`}
                      type="datetime-local"
                      value={silenceUntil}
                      onChange={(e) => setSilenceUntil(e.target.value)}
                      required
                    />
                    <Button type="submit" className="h-11" disabled={pending}>
                      Silence
                    </Button>
                  </div>
                </form>

                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => forceActiveAction(w, id, Number(hours)), "Tracking forced on");
                  }}
                >
                  <Label htmlFor={`force-${id}`}>Force active for (hours)</Label>
                  <div className="flex gap-2">
                    <Input
                      id={`force-${id}`}
                      type="number"
                      inputMode="decimal"
                      min="0.5"
                      max="48"
                      step="0.5"
                      value={hours}
                      onChange={(e) => setHours(e.target.value)}
                      required
                    />
                    <Button type="submit" className="h-11" disabled={pending}>
                      Force active
                    </Button>
                  </div>
                </form>

                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => assignPhoneAction(w, id, vehicleId || null), vehicleId ? "Assigned" : "Unassigned");
                  }}
                >
                  <Label htmlFor={`vehicle-${id}`}>Vehicle</Label>
                  <div className="flex gap-2">
                    <select
                      id={`vehicle-${id}`}
                      className={SELECT}
                      value={vehicleId}
                      onChange={(e) => setVehicleId(e.target.value)}
                    >
                      <option value="">No vehicle</option>
                      {vehicles.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" className="h-11" disabled={pending || vehicleId === (h.vehicle?.id ?? "")}>
                      Save
                    </Button>
                  </div>
                </form>

                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => labelPhoneAction(w, id, label), "Renamed");
                  }}
                >
                  <Label htmlFor={`label-${id}`}>Label</Label>
                  <div className="flex gap-2">
                    <Input
                      id={`label-${id}`}
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      maxLength={100}
                      required
                    />
                    <Button type="submit" className="h-11" disabled={pending || label.trim() === d.label}>
                      Save
                    </Button>
                  </div>
                </form>

                {isAdmin && (
                  <>
                    <form
                      className="flex flex-col gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(
                          () => phoneUpdateAction(w, id, updateId),
                          updateId.trim() ? "Updating now" : "Follows the workspace update",
                        );
                      }}
                    >
                      <Label htmlFor={`update-${id}`}>Update this phone now (blank = follow the workspace)</Label>
                      <div className="flex gap-2">
                        <Input
                          id={`update-${id}`}
                          value={updateId}
                          onChange={(e) => setUpdateId(e.target.value)}
                          placeholder={workspaceTarget ?? "EAS update id"}
                          className="font-mono"
                          autoComplete="off"
                        />
                        <Button type="submit" className="h-11" disabled={pending}>
                          Set
                        </Button>
                      </div>
                    </form>

                    <div className="flex flex-col gap-2 border-t pt-4">
                      {moveTargets.length > 0 && (
                        <ConfirmButton
                          label="Move to another workspace"
                          title={`Move ${d.label}?`}
                          description="Its vehicle and any silence or force-active are cleared. It picks up the new workspace's config on its next sync."
                          confirmLabel="Move"
                          disabled={pending}
                          onConfirm={() => run(() => movePhoneAction(w, id, moveTo), "Moved")}
                        >
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`move-${id}`}>To</Label>
                            <select
                              id={`move-${id}`}
                              className={SELECT}
                              value={moveTo}
                              onChange={(e) => setMoveTo(e.target.value)}
                            >
                              {moveTargets.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </ConfirmButton>
                      )}
                      {!d.killedAt && (
                        <ConfirmButton
                          label="Kill tracking"
                          title={`Kill ${d.label}?`}
                          description="The phone stops tracking on its next sync and stays stopped. Only the driver can resume it, with the Resume button in the app."
                          confirmLabel="Kill"
                          disabled={pending}
                          onConfirm={() => run(() => killPhoneAction(w, id), "Killed")}
                        />
                      )}
                      <ConfirmButton
                        label="Revoke (lost phone / driver left)"
                        title={`Revoke ${d.label}?`}
                        description="Its token stops working and it leaves its vehicle. To use this phone again it must be paired again."
                        confirmLabel="Revoke"
                        disabled={pending}
                        onConfirm={() => run(() => revokePhoneAction(w, id), "Revoked")}
                      />
                    </div>
                  </>
                )}
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

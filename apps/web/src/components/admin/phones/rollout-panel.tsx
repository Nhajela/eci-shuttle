"use client";

import { useState } from "react";
import { rolloutAction } from "@/app/admin/phones/actions";
import { ConfirmButton } from "@/components/admin/shell/confirm-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "./use-action";

/** admin: OTA target for every phone in this workspace (SPEC §5). Phones apply it only while idle. */
export function RolloutPanel({
  w,
  workspaceName,
  isLive,
  target,
  phoneCount,
}: {
  w: string;
  workspaceName: string;
  isLive: boolean;
  target: string | null;
  phoneCount: number;
}) {
  const [updateId, setUpdateId] = useState(target ?? "");
  const { pending, run } = useAction();
  const next = updateId.trim();

  return (
    <Card>
      <CardHeader>
        <CardTitle>App update</CardTitle>
        <CardDescription>
          {target ? (
            <>
              Phones here should run <span className="font-mono break-all">{target}</span>.
            </>
          ) : (
            "No update targeted: phones keep what they run."
          )}{" "}
          {isLive ? "Try an update on the test phones first." : "Test phones: roll out here first, then on live."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rollout-id">EAS update id</Label>
          <Input
            id="rollout-id"
            value={updateId}
            onChange={(e) => setUpdateId(e.target.value)}
            placeholder="e.g. 3f1c…"
            className="font-mono"
            autoComplete="off"
          />
        </div>
        <ConfirmButton
          label={`Roll out to all ${phoneCount} phones`}
          question={`Roll out to ${workspaceName}?`}
          description={`Every phone in ${workspaceName} downloads ${next || "nothing"} and applies it the next time it is idle. To roll back, roll out the previous id.`}
          confirmLabel="Roll out"
          variant="default"
          disabled={pending || !next || next === target}
          onConfirm={() => run(() => rolloutAction(w, next), "Rollout started")}
        />
        {target && (
          <Button
            variant="outline"
            className="h-11"
            disabled={pending}
            onClick={() => run(() => rolloutAction(w, ""), "Stopped targeting an update")}
          >
            Stop targeting
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

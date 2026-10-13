"use client";
/** admin-live: one vehicle on the Live board, with its flags and the phone quick actions. */
import { istHHMM } from "@eci-shuttle/shared";
import { AlertTriangle, BatteryMedium, Clock, Route, Smartphone } from "lucide-react";
import { nudgeAction, silenceAction } from "@/app/admin/live/actions";
import { ConfirmButton } from "@/components/admin/shell/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { VehicleCard as Card_ } from "./board";
import { useQuick } from "./quick";

const PHASE_TONE: Record<Card_["phase"], string> = {
  at_spot: "bg-[var(--teal-tint)] text-[var(--teal-deep)]",
  en_route: "bg-[var(--blue-tint)] text-[var(--blue-deep)]",
  offline: "bg-orange-100 text-orange-800",
  off_duty: "bg-muted text-muted-foreground",
};

export function VehicleCard({ card, w, canAct }: { card: Card_; w: string | null; canAct: boolean }) {
  const { pending, run } = useQuick();
  const flagged = card.problems.length > 0;
  return (
    <Card className={flagged ? "ring-2 ring-orange-500/60" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          {card.colour && <span aria-hidden className="size-3 rounded-full" style={{ background: card.colour }} />}
          {card.name}
          <Badge className={PHASE_TONE[card.phase]}>
            {card.phaseText}
            {card.etaText && ` · ${card.etaText}`}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {flagged && (
          <ul className="flex flex-col gap-1 rounded-lg bg-orange-50 p-2 text-sm text-orange-900">
            {card.problems.map((p) => (
              <li key={`${p.kind}:${p.message}`} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {p.message}
              </li>
            ))}
          </ul>
        )}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          <div className="col-span-2 flex min-w-0 items-start gap-1.5">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dt className="sr-only">Last seen</dt>
            <dd>
              {card.locationText}
              {card.checkInText && ` · ${card.checkInText}`}
            </dd>
          </div>
          <Fact icon={<BatteryMedium className="size-4" />} label="Battery" value={card.batteryText ?? "–"} />
          <Fact icon={<Route className="size-4" />} label="Service" value={card.serviceName ?? "None now"} />
          <Fact icon={<Smartphone className="size-4" />} label="Phone" value={card.phoneLabel ?? "No phone"} />
        </dl>
        {card.silencedUntilText && (
          <p className="text-sm text-muted-foreground">Silenced till {card.silencedUntilText}</p>
        )}
        {canAct && card.deviceId && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="h-11"
              disabled={pending}
              onClick={() => run(() => nudgeAction(w, card.deviceId as string), `Nudged ${card.phoneLabel}`)}
            >
              Nudge
            </Button>
            <ConfirmButton
              label="Silence 1h"
              question={`Silence ${card.name} till ${istHHMM(Date.now() + 3_600_000)}?`}
              variant="default"
              disabled={pending}
              onConfirm={() =>
                run(() => silenceAction(w, card.deviceId as string, 1), `${card.name} silenced for an hour`)
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <dt className="sr-only">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

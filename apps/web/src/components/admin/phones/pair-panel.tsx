"use client";

import { useState } from "react";
import { createPairingCodeAction } from "@/app/admin/phones/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "./use-action";

type Pairing = { code: string; qrUrl: string; expiresIst: string; qrDataUrl: string };

/** admin: make a pairing code; the driver app scans the QR or types the 6 digits. */
export function PairPanel({ w, workspaceName }: { w: string; workspaceName: string }) {
  const [label, setLabel] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const { pending, run } = useAction();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pair a phone</CardTitle>
        <CardDescription>
          The phone joins {workspaceName}. Open the driver app and scan, or type the code.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {pairing ? (
          <div className="flex flex-col items-center gap-2 text-center">
            {/* biome-ignore lint/performance/noImgElement: a generated data URL, nothing for next/image to optimise */}
            <img src={pairing.qrDataUrl} alt={`QR code for pairing code ${pairing.code}`} className="size-64" />
            <p className="font-mono text-4xl tracking-[0.3em]">{pairing.code}</p>
            <p className="text-muted-foreground text-sm">Valid until {pairing.expiresIst}. Works once.</p>
            <Button variant="outline" className="h-11 w-full" onClick={() => setPairing(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => createPairingCodeAction(w, label),
                undefined,
                (d) => d && setPairing(d),
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pair-label">Label (optional)</Label>
              <Input
                id="pair-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Raju's phone"
                maxLength={80}
              />
            </div>
            <Button type="submit" className="h-11" disabled={pending}>
              {pending ? "Making code…" : "Make pairing code"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

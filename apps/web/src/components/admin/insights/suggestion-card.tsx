"use client";
/** admin-insights: one timetable suggestion. Accept makes a proposal; nothing changes until it is confirmed. */
import { useActionState, useState } from "react";
import { acceptSuggestionAction, confirmProposalAction, dismissSuggestionAction } from "@/app/admin/insights/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

type Props = { id: string; summary: string; meta: string; w: string; canDecide: boolean };

/** A proposal lives 10 min; once it expired or went stale, remount the body so Accept makes a fresh one. */
export function SuggestionCard(props: Props) {
  const [round, setRound] = useState(0);
  return <SuggestionBody key={round} {...props} onRetry={() => setRound((r) => r + 1)} />;
}

function SuggestionBody(props: Props & { onRetry: () => void }) {
  const [accepted, accept, accepting] = useActionState(acceptSuggestionAction, null);
  const [dismissed, dismiss, dismissing] = useActionState(dismissSuggestionAction, null);
  const [confirmed, confirmIt, confirming] = useActionState(confirmProposalAction, null);
  const error = [confirmed, dismissed, accepted].find((r) => r && !r.ok);
  const expired = confirmed && !confirmed.ok && (confirmed.code === "GONE" || confirmed.code === "STALE_VERSION");

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-[15px] leading-snug">{props.summary}</CardTitle>
        <CardDescription>{props.meta}</CardDescription>
      </CardHeader>
      {(accepted?.ok || error) && (
        <CardContent className="space-y-2 text-sm">
          {accepted?.ok && !confirmed?.ok && (
            <p>
              Proposal <span className="font-mono">{accepted.proposalCode}</span>: {accepted.summary}. Nothing changes
              until you confirm (valid 10 min).
            </p>
          )}
          {confirmed?.ok && <p className="font-medium">Done: {confirmed.summary}</p>}
          {error && !error.ok && (
            <p role="alert" className="text-destructive">
              {error.error}
            </p>
          )}
        </CardContent>
      )}
      {props.canDecide && !confirmed?.ok && !dismissed?.ok && (
        <CardFooter className="gap-2">
          {expired ? (
            <Button type="button" className="h-11 px-5" onClick={props.onRetry}>
              Propose again
            </Button>
          ) : accepted?.ok ? (
            <form action={confirmIt}>
              <input type="hidden" name="w" value={props.w} />
              <input type="hidden" name="code" value={accepted.proposalCode} />
              <Button type="submit" className="h-11 px-5" disabled={confirming}>
                {confirming ? "Applying…" : "Confirm change"}
              </Button>
            </form>
          ) : (
            <form action={accept}>
              <input type="hidden" name="w" value={props.w} />
              <input type="hidden" name="suggestionId" value={props.id} />
              <Button type="submit" className="h-11 px-5" disabled={accepting}>
                {accepting ? "Preparing…" : "Accept"}
              </Button>
            </form>
          )}
          <form action={dismiss}>
            <input type="hidden" name="w" value={props.w} />
            <input type="hidden" name="suggestionId" value={props.id} />
            <Button type="submit" variant="outline" className="h-11 px-5" disabled={dismissing}>
              Dismiss
            </Button>
          </form>
        </CardFooter>
      )}
      {dismissed?.ok && <CardContent className="text-sm text-muted-foreground">Dismissed.</CardContent>}
    </Card>
  );
}

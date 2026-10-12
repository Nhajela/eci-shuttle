"use client";
/** admin-people client forms. Each posts to a server action in app/admin/people/actions.ts and toasts the result. */
import { AlertKind, Role } from "@eci-shuttle/shared";
import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { createTokenAction, revokeTokenAction, setAlertPrefsAction, setRoleAction } from "@/app/admin/people/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ActionResult, ALERT_KIND_LABEL, ROLE_LABEL } from "./people";

type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

function useAction(action: Action) {
  const [state, run, pending] = useActionState(action, null);
  useEffect(() => {
    if (!state) return;
    if (!state.ok) toast.error(state.error);
    else if (state.message) toast.success(state.message);
  }, [state]);
  return [state, run, pending] as const;
}

const SELECT = "h-11 w-full rounded-md border border-input bg-background px-3 text-base";

export function RoleForm({ w, personId, role, isSelf }: { w: string; personId: string; role: Role; isSelf: boolean }) {
  const [, run, pending] = useAction(setRoleAction);
  const [, remove, removing] = useAction(setRoleAction);
  return (
    <div className="flex flex-col gap-2">
      <form action={run} className="flex flex-col gap-2">
        <input type="hidden" name="w" value={w} />
        <input type="hidden" name="personId" value={personId} />
        <Label className="sr-only" htmlFor={`role-${personId}`}>
          Role
        </Label>
        <select id={`role-${personId}`} name="role" defaultValue={role} className={SELECT}>
          {Role.options.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <Button type="submit" size="lg" disabled={pending}>
          Save role
        </Button>
      </form>
      <form action={remove}>
        <input type="hidden" name="w" value={w} />
        <input type="hidden" name="personId" value={personId} />
        <input type="hidden" name="role" value="" />
        <Button
          type="submit"
          size="lg"
          variant="destructive"
          className="w-full"
          disabled={removing}
          onClick={(e) => {
            if (!confirm(isSelf ? "Remove yourself from this workspace?" : "Remove this person from this workspace?"))
              e.preventDefault();
          }}
        >
          Remove from workspace
        </Button>
      </form>
    </div>
  );
}

export function AddMemberForm({ w }: { w: string }) {
  const [, run, pending] = useAction(setRoleAction);
  return (
    <form action={run} className="flex flex-col gap-3">
      <input type="hidden" name="w" value={w} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-username">Telegram username</Label>
        <Input
          id="add-username"
          name="username"
          required
          placeholder="@username"
          autoCapitalize="none"
          autoCorrect="off"
          className="h-11 text-base"
        />
        <p className="text-sm text-muted-foreground">They need to have messaged the bot once.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-role">Role</Label>
        <select id="add-role" name="role" defaultValue="ops" className={SELECT}>
          {Role.options.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" size="lg" disabled={pending}>
        Add to workspace
      </Button>
    </form>
  );
}

export function AlertPrefsForm({
  w,
  kinds,
  quietFrom,
  quietTo,
  version,
}: {
  w: string;
  kinds: AlertKind[];
  quietFrom: string | null;
  quietTo: string | null;
  version: number | null;
}) {
  const [, run, pending] = useAction(setAlertPrefsAction);
  return (
    <form action={run} className="flex flex-col">
      <input type="hidden" name="w" value={w} />
      <input type="hidden" name="version" value={version ?? ""} />
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm text-muted-foreground">Telegram me about</legend>
        {AlertKind.options.map((k) => (
          <label key={k} className="flex min-h-11 items-center gap-3 border-b py-2 last:border-b-0">
            <input type="checkbox" name="kinds" value={k} defaultChecked={kinds.includes(k)} className="size-5" />
            <span>{ALERT_KIND_LABEL[k]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="mt-4 flex flex-col gap-2">
        <legend className="mb-1 text-sm text-muted-foreground">
          Quiet hours (IST). Alerts wait until they end. Leave both empty for none.
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quiet-from">From</Label>
            <Input id="quiet-from" name="quietFrom" type="time" defaultValue={quietFrom ?? ""} className="h-11" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quiet-to">To</Label>
            <Input id="quiet-to" name="quietTo" type="time" defaultValue={quietTo ?? ""} className="h-11" />
          </div>
        </div>
      </fieldset>
      <div className="sticky bottom-0 -mx-4 mt-4 border-t bg-background px-4 py-3">
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          Save alert settings
        </Button>
      </div>
    </form>
  );
}

export function CreateTokenForm({ w }: { w: string }) {
  const [state, run, pending] = useAction(createTokenAction);
  const [copied, setCopied] = useState(false);
  const token = state?.ok ? state.token : undefined;
  return (
    <div className="flex flex-col gap-3">
      {token && (
        <div className="flex flex-col gap-2 rounded-md border border-primary p-3">
          <p className="text-sm font-medium">Copy this token now. It won't be shown again.</p>
          <code className="break-all rounded bg-muted p-2 text-sm">{token}</code>
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(token);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy token"}
          </Button>
        </div>
      )}
      <form action={run} className="flex flex-col gap-3" onSubmit={() => setCopied(false)}>
        <input type="hidden" name="w" value={w} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="token-name">Name</Label>
          <Input
            id="token-name"
            name="name"
            required
            maxLength={100}
            placeholder="e.g. Claude Code on my laptop"
            className="h-11 text-base"
          />
        </div>
        <Button type="submit" size="lg" disabled={pending}>
          Create token
        </Button>
      </form>
    </div>
  );
}

export function RevokeTokenButton({ w, tokenId }: { w: string; tokenId: string }) {
  const [, run, pending] = useAction(revokeTokenAction);
  return (
    <form action={run}>
      <input type="hidden" name="w" value={w} />
      <input type="hidden" name="tokenId" value={tokenId} />
      <Button
        type="submit"
        size="lg"
        variant="destructive"
        disabled={pending}
        onClick={(e) => {
          if (!confirm("Revoke this token? Anything using it stops working.")) e.preventDefault();
        }}
      >
        Revoke
      </Button>
    </form>
  );
}

"use client";
import Link from "next/link";
import { useActionState } from "react";
import { type ActionState, createWorkspaceAction } from "@/app/admin/workspaces/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** New test workspace: slug + name. The creator becomes its admin. */
export function CreateWorkspaceForm({ w }: { w: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createWorkspaceAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="w" value={w} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ws-name">Name</Label>
        <Input id="ws-name" name="name" required maxLength={100} placeholder="Test 2" className="h-11" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ws-slug">Slug</Label>
        <Input
          id="ws-slug"
          name="slug"
          required
          pattern="[a-z0-9][a-z0-9\-]{1,30}"
          placeholder="test-2"
          autoCapitalize="none"
          autoCorrect="off"
          className="h-11"
        />
        <p className="text-muted-foreground text-sm">Lowercase letters, digits and dashes. Its page: /w/slug</p>
      </div>
      <Button type="submit" disabled={pending} className="h-11">
        {pending ? "Creating…" : "Create test workspace"}
      </Button>
      {state && (
        <p role="status" className={state.ok ? "text-sm" : "text-destructive text-sm"}>
          {state.message}{" "}
          {state.slug && (
            <Link href={`/admin/workspaces?w=${state.slug}`} className="underline">
              Switch to it
            </Link>
          )}
        </p>
      )}
    </form>
  );
}

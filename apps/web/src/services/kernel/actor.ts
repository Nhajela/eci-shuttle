import type { ActorChannel, ActorKind, Role } from "@eci-shuttle/shared";

/**
 * Who is acting (SPEC §7a). Adapters build it before calling any service; services never read sessions,
 * headers or tokens themselves.
 *
 * - admin: a person (id = people.id) acting in `workspaceId` with their `role` there.
 * - device: a phone (id = devices.id) acting on itself (sync, resume, permission changes).
 * - system: a worker job or bootstrap (id = job name, e.g. "watchdog"); bypasses role checks.
 */
export type Actor = {
  kind: ActorKind;
  id: string;
  workspaceId?: string;
  role?: Role;
  channel: ActorChannel;
  /** MCP client name, e.g. "claude.ai" */
  client?: string;
  /** snapshotted into audit_log.actor_label (a name, a phone label, a job name) */
  label?: string;
  /** set by MCP confirm: every mutation it runs carries the proposal id into the audit log */
  proposalId?: string;
  /** optional reason, e.g. from shuttle_propose { reason } */
  reason?: string;
};

export const systemActor = (job: string, channel: ActorChannel = "worker"): Actor => ({
  kind: "system",
  id: job,
  channel,
  label: job,
});

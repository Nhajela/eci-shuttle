/**
 * MCP write changes (SPEC §7a). `shuttle_propose { workspace, changes: McpChange[], reason? }` validates these,
 * `shuttle_confirm { code }` runs them in one transaction, each through the same service function admin uses.
 */
import { z } from "zod";
import {
  checkException,
  NoticeCreateFields,
  NoticeEndFields,
  PairingCodeCreateFields,
  PhoneAssignFields,
  PhoneForceActiveFields,
  PhoneKillFields,
  PhoneLabelFields,
  PhoneMoveWorkspaceFields,
  PhoneNudgeFields,
  PhoneRevokeFields,
  PhoneSilenceFields,
  RouteCreateFields,
  RouteUpdateFields,
  ServiceCreateFields,
  ServiceExceptionFields,
  ServiceUpdateFields,
  ServiceVehicleAssignFields,
  ServiceVehicleUnassignFields,
  SpotArchiveFields,
  SpotCreateFields,
  SpotUpdateFields,
  VehicleCreateFields,
  VehicleUpdateFields,
  WorkspaceCreateFields,
} from "./inputs";

const change = <K extends string, T extends z.ZodRawShape>(kind: K, fields: z.ZodObject<T>) =>
  fields.extend({ kind: z.literal(kind) });

export const McpChange = z.discriminatedUnion("kind", [
  change("spot.create", SpotCreateFields),
  change("spot.update", SpotUpdateFields),
  change("spot.archive", SpotArchiveFields),
  change("route.create", RouteCreateFields),
  change("route.update", RouteUpdateFields),
  change("service.create", ServiceCreateFields),
  change("service.update", ServiceUpdateFields),
  change("service.exception", ServiceExceptionFields).superRefine(checkException),
  change("service_vehicle.assign", ServiceVehicleAssignFields),
  change("service_vehicle.unassign", ServiceVehicleUnassignFields),
  change("vehicle.create", VehicleCreateFields),
  change("vehicle.update", VehicleUpdateFields),
  change("phone.label", PhoneLabelFields),
  change("phone.assign", PhoneAssignFields),
  change("phone.silence", PhoneSilenceFields),
  change("phone.force_active", PhoneForceActiveFields),
  change("phone.nudge", PhoneNudgeFields),
  change("phone.kill", PhoneKillFields),
  change("phone.revoke", PhoneRevokeFields),
  change("phone.move_workspace", PhoneMoveWorkspaceFields),
  change("pairing_code.create", PairingCodeCreateFields),
  change("notice.create", NoticeCreateFields),
  change("notice.end", NoticeEndFields),
  change("workspace.create", WorkspaceCreateFields),
]);
export type McpChange = z.infer<typeof McpChange>;
export type McpChangeKind = McpChange["kind"];

export const ProposeInput = z.object({
  /** workspace slug */
  workspace: z.string(),
  changes: z.array(McpChange).min(1).max(50),
  reason: z.string().trim().max(500).optional(),
});
export type ProposeInput = z.infer<typeof ProposeInput>;

export const ConfirmInput = z.object({ code: z.string().min(1) });
export type ConfirmInput = z.infer<typeof ConfirmInput>;

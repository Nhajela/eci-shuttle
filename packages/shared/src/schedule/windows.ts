import type { ServiceDef, ServiceExceptionDef, ServiceVehicleDef, VehicleWindow } from "../contracts";
import { notImplemented } from "../notImplemented";

/**
 * When each vehicle should be tracking between `from` and `to` (epoch ms). Feeds the device config
 * (§4 schedule: Window[48h]) and the watchdog's "expected active". Pure.
 *
 * - For every service day overlapping [from, to): the service window startTime..endTime (cross-midnight aware),
 *   widened by `padMin` on both sides (default 15), skipped on non-running days and `cancel_day` exceptions.
 *   A departure moved/added outside the window (shift/add exceptions) widens that day's window to cover that
 *   departure time ± pad.
 * - Intersected with each service_vehicles row [startsAt, endsAt) for that service: a vehicle only tracks while
 *   assigned. Services with no assigned vehicles produce nothing.
 * - Clipped to [from, to). Per vehicle, overlapping or touching windows are merged and their serviceIds unioned.
 * - Result sorted by vehicleId, then startsAt.
 */
export function trackingWindows(
  serviceVehicles: ServiceVehicleDef[],
  services: ServiceDef[],
  exceptions: ServiceExceptionDef[],
  from: number,
  to: number,
  padMin = 15,
): VehicleWindow[] {
  return notImplemented(serviceVehicles, services, exceptions, from, to, padMin);
}

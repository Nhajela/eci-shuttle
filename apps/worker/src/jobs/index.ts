/** Every scheduled job (SPEC §2b). Job owners edit only their own file; adding a job is a contract change. */
import type { Job } from "../job";
import { arrivalAlerts } from "./arrival-alerts";
import { cleanup } from "./cleanup";
import { heartbeat } from "./heartbeat";
import { learning } from "./learning";
import { notices } from "./notices";
import { queue } from "./queue";
import { updates } from "./updates";
import { watchdog } from "./watchdog";
import { windows } from "./windows";

export const jobs: Job[] = [heartbeat, watchdog, windows, arrivalAlerts, updates, notices, queue, learning, cleanup];

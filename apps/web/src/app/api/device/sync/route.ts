/** web-device: POST /api/device/sync (SPEC §4): devices/sync.authenticateDevice + syncDevice. */
export const dynamic = "force-dynamic";

const notYet = () => Response.json({ error: "not implemented" }, { status: 501 });

export const POST = notYet;

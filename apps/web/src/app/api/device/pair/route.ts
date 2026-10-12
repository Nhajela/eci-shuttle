/** web-device: POST /api/device/pair (SPEC §4): devices/pairing.pairDevice. */
export const dynamic = "force-dynamic";

const notYet = () => Response.json({ error: "not implemented" }, { status: 501 });

export const POST = notYet;

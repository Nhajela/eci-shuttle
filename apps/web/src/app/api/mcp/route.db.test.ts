import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { people } from "@/db/schema";
import type { Workspace } from "@/db/types";
import { buildContext } from "@/mcp/context";
import { PHASE_TEXT } from "@/mcp/initialize";
import { GUIDES, NO_WORKSPACES, RULES, SERVER_INSTRUCTIONS } from "@/mcp/text";
import { createPersonalToken, revokeToken } from "@/services/mcp/tokens";

// Services owned by other tasks are faked here: this file tests the adapter (auth, context, tools, text).
const fake = vi.hoisted(() => ({
  workspaces: [] as unknown[],
  problemsFail: false,
}));
vi.mock("@/services/catalog/workspaces", () => ({ listMyWorkspaces: async () => fake.workspaces }));
vi.mock("@/services/auth/actor", () => ({
  adminActor: async (_db: unknown, i: { personId: string; workspaceId: string; channel: string; client?: string }) => {
    const ws = (fake.workspaces as (Workspace & { role: string })[]).find((w) => w.id === i.workspaceId);
    if (!ws) throw Object.assign(new Error("no membership"), { code: "FORBIDDEN" });
    return {
      kind: "admin",
      id: i.personId,
      workspaceId: i.workspaceId,
      role: ws.role,
      channel: i.channel,
      client: i.client,
    };
  },
}));
vi.mock("@/services/catalog/vehicles", () => ({
  listVehicles: async () => [
    { id: "v1", name: "Bus 1", active: true },
    { id: "v2", name: "Bus 2", active: true },
    { id: "v3", name: "Old van", active: false },
  ],
}));
vi.mock("@/services/ingest/ingest", () => ({
  vehicleStates: async () => [{ vehicleId: "v1", phase: "en_route", lastPingAt: new Date("2026-10-12T04:08:00Z") }],
}));
vi.mock("@/services/catalog/schedule", () => ({
  getSchedule: async () => [
    {
      date: "2026-10-12",
      services: [
        {
          service: { name: "Riva ↔ Circle" },
          departures: [{ at: Date.parse("2026-10-12T16:40:00Z") }, { at: Date.parse("2026-10-12T01:30:00Z") }],
        },
        { service: { name: "Party shuttle" }, departures: [] },
      ],
    },
  ],
}));
vi.mock("@/services/alerts/watchdog", () => ({
  detectProblems: async () => {
    if (fake.problemsFail) throw new Error("boom");
    return [{ message: "Bus 2 has been silent", since: new Date("2026-10-12T03:55:00Z") }];
  },
}));
vi.mock("@/services/learning/insights", () => ({
  listSuggestions: async () => [{ summary: "Shift the 09:40 from Riva to 09:50?" }],
}));

const db = () => testDb();
const NOW = new Date("2026-10-12T04:10:00Z");

beforeEach(() => {
  fake.workspaces = [];
  fake.problemsFail = false;
});

async function person() {
  const live = await makeWorkspace(db(), { name: "ECI Live" });
  const test = await makeWorkspace(db(), { name: "Sandbox" });
  const { person, actor } = await makeAdmin(db(), test.id, "ops");
  await db().update(people).set({ username: "naman", firstName: "Naman" }).where(eq(people.id, person.id));
  fake.workspaces = [
    { ...live, isLive: true, role: "admin" },
    { ...test, role: "ops" },
  ];
  const { token, row } = await createPersonalToken(db(), actor, { name: "laptop" });
  return { person, actor, token, row, live, test };
}

const post = async (headers: Record<string, string>, body: unknown = {}) => {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    }),
  );
};

async function connect(token: string) {
  const { POST } = await import("./route");
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"), {
    fetch: (url: string | URL | Request, init?: RequestInit) => POST(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

describe("/api/mcp auth", () => {
  it("401 with the protected-resource metadata pointer; invalid_token when one was presented", async () => {
    const none = await post({});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"',
    );
    const bad = await post({ authorization: "Bearer shs_nope" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("a revoked token is refused", async () => {
    const { token, row, actor } = await person();
    await revokeToken(db(), actor, { tokenId: row.id }, new Date());
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("GET is 405", async () => {
    const { GET } = await import("./route");
    expect(GET().status).toBe(405);
  });
});

describe("/api/mcp tools", () => {
  it("lists shuttle_initialize and shuttle_guide, with the server instructions", async () => {
    const { token } = await person();
    const client = await connect(token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["shuttle_initialize", "shuttle_guide"]));
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await client.close();
  });

  it("shuttle_initialize: who, workspaces with roles, snapshot, rules, tools", async () => {
    const { token, live, test } = await person();
    const client = await connect(token);
    const t = text(await client.callTool({ name: "shuttle_initialize", arguments: {} }));
    expect(t).toContain("Naman (@naman), connected via laptop");
    expect(t).toMatch(/Now: \w{3} \d+ \w{3}, \d\d:\d\d IST/);
    expect(t).toContain(`## ECI Live (\`${live.slug}\`, LIVE: what attendees see): you are admin`);
    expect(t).toContain(`## Sandbox (\`${test.slug}\`, test): you are ops`);
    expect(t).toContain(`- Bus 1: ${PHASE_TEXT.en_route} (last seen`);
    expect(t).toContain(`- Bus 2: ${PHASE_TEXT.off_duty}`);
    expect(t).not.toContain("Old van");
    expect(t).toContain("- Riva ↔ Circle: 2 departures, 07:00–22:10");
    expect(t).toContain("- Party shuttle: no departures");
    expect(t).toContain("- Bus 2 has been silent (since 09:25)");
    expect(t).toContain("- Shift the 09:40 from Riva to 09:50?");
    expect(t).toContain(RULES);
    expect(t).toContain("`shuttle_guide`");
    await client.close();
  });

  it("a failing snapshot part says so, the rest still shows", async () => {
    const { token } = await person();
    fake.problemsFail = true;
    const client = await connect(token);
    const r = await client.callTool({ name: "shuttle_initialize", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Open problems: couldn't load right now.");
    expect(text(r)).toContain("- Bus 1:");
    await client.close();
  });

  it("no memberships → says to ask an admin", async () => {
    const { token } = await person();
    fake.workspaces = [];
    const client = await connect(token);
    expect(text(await client.callTool({ name: "shuttle_initialize", arguments: {} }))).toContain(NO_WORKSPACES);
    await client.close();
  });

  it("shuttle_guide returns the topic; changes lists every kind with its role and required fields", async () => {
    const { token } = await person();
    const client = await connect(token);
    const t = text(await client.callTool({ name: "shuttle_guide", arguments: { topic: "changes" } }));
    expect(t).toContain(GUIDES.changes);
    expect(t).toContain("- `spot.update` (ops): spotId*, version, name");
    expect(t).toContain("- `phone.kill` (admin): deviceId*");
    expect(t).toContain("- `service.exception` (ops): serviceId*, date*, type*, departure, minutes, note");
    expect(text(await client.callTool({ name: "shuttle_guide", arguments: { topic: "notices" } }))).toBe(
      GUIDES.notices,
    );
    await client.close();
  });

  it("serves a 2025-era initialize handshake as JSON", async () => {
    const { token } = await person();
    const res = await post(
      { authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-11-25" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).result.serverInfo.name).toBe("eci-shuttle");
  });
});

describe("buildContext.inWorkspace", () => {
  it("defaults to live, else the only one; unknown slug or ambiguity is a ToolError", async () => {
    const { person: p, live, test } = await person();
    const ctx = await buildContext(db(), p, { client: null, name: "laptop" }, NOW);
    expect(ctx.client).toBe("laptop");
    expect((await ctx.inWorkspace()).workspace.id).toBe(live.id);
    const r = await ctx.inWorkspace(test.slug);
    expect(r.actor).toMatchObject({ kind: "admin", id: p.id, workspaceId: test.id, role: "ops", channel: "mcp" });
    await expect(ctx.inWorkspace("nope")).rejects.toThrow(/^NOT_FOUND: You have no workspace "nope"/);

    fake.workspaces = [
      { ...live, role: "admin" },
      { ...test, role: "ops" },
    ];
    const noLive = await buildContext(db(), p, { client: "claude.ai", name: "claude.ai" }, NOW);
    await expect(noLive.inWorkspace()).rejects.toThrow(/^INVALID: You have several workspaces/);
    fake.workspaces = [{ ...test, role: "ops" }];
    const one = await buildContext(db(), p, { client: "claude.ai", name: "x" }, NOW);
    expect(one.client).toBe("claude.ai");
    expect((await one.inWorkspace()).workspace.id).toBe(test.id);
    fake.workspaces = [];
    const none = await buildContext(db(), p, { client: null, name: "x" }, NOW);
    await expect(none.inWorkspace()).rejects.toThrow(/^FORBIDDEN: You aren't a member/);
  });
});

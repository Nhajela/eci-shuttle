import { createHash } from "node:crypto";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { memberships } from "@/db/schema";
import type { Person } from "@/db/types";
import { NO_WORKSPACES } from "@/mcp/text";
import { authenticateMcp } from "@/services/mcp/tokens";
import { GET as asMeta } from "../../../.well-known/oauth-authorization-server/[[...rest]]/route";
import { GET as prMeta } from "../../../.well-known/oauth-protected-resource/[[...rest]]/route";
import { GET as authorizeGet, POST as authorizePost } from "./authorize/route";
import { POST as register } from "./register/route";
import { POST as token } from "./token/route";

process.env.TOKEN_SECRETS = "oauth-route-test-secret-at-least-32-chars";
const session = vi.hoisted(() => ({ person: null as Person | null }));
vi.mock("@/lib/session", () => ({ currentPerson: async () => session.person }));
// ponytail: stand-in for svc-auth's resolveWorkspace (still a stub): any membership → that workspace, none → null
vi.mock("@/services/auth/actor", () => ({
  resolveWorkspace: async (d: Db, personId: string) => {
    const [m] = await d.select().from(memberships).where(eq(memberships.personId, personId));
    return m ? { workspace: { id: m.workspaceId }, role: m.role } : null;
  },
}));

const O = "http://localhost:3000";
const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "x".repeat(60);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const db = () => testDb();

/** A person with an admin membership in a fresh workspace. */
async function member(over: Partial<Person> = {}) {
  const person = await makePerson(db(), over);
  const ws = await makeWorkspace(db());
  await db().insert(memberships).values({ personId: person.id, workspaceId: ws.id, role: "admin" });
  return person;
}

beforeEach(() => {
  session.person = null;
});

async function registered(name = "claude.ai") {
  const res = await register(
    new Request(`${O}/api/mcp/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CB], client_name: name }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

const authorizeUrl = (clientId: string, over: Record<string, string> = {}) =>
  `${O}/api/mcp/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CB,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "s1",
    ...over,
  })}`;

const allow = (url: string, decision = "allow", originHeader = O) =>
  authorizePost(
    new Request(url, {
      method: "POST",
      headers: { origin: originHeader, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ decision }),
    }),
  );

describe("metadata", () => {
  it("serves both well-known documents with CORS", async () => {
    const as = asMeta();
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    expect(await as.json()).toMatchObject({ issuer: O, token_endpoint: `${O}/api/mcp/oauth/token` });
    expect(await prMeta().json()).toMatchObject({ resource: `${O}/api/mcp`, authorization_servers: [O] });
  });
});

describe("register", () => {
  it("rejects a non-https redirect", async () => {
    const res = await register(
      new Request(`${O}/api/mcp/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });
});

describe("authorize", () => {
  it("an unregistered redirect gets an error page, never a redirect", async () => {
    const { client_id } = await registered();
    const res = await authorizeGet(new Request(authorizeUrl(client_id, { redirect_uri: "https://evil.example/cb" })));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("logged out → /login?next=<this authorize URL>", async () => {
    const { client_id } = await registered();
    const url = authorizeUrl(client_id);
    const res = await authorizeGet(new Request(url));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.pathname).toBe("/login");
    expect(`${O}${loc.searchParams.get("next")}`).toBe(url);
  });

  it("logged in → a consent page, unframeable, with the client name escaped", async () => {
    session.person = await member({ firstName: "Naman" });
    const { client_id } = await registered("<script>x</script>");
    const res = await authorizeGet(new Request(authorizeUrl(client_id)));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // no-referrer would make browsers post the Allow form with `Origin: null`, which the POST refuses
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("<b>Naman</b>");
  });

  it("POST from another origin is refused; Cancel → access_denied with state", async () => {
    session.person = await member();
    const { client_id } = await registered();
    const evil = await allow(authorizeUrl(client_id), "allow", "https://evil.example");
    expect(evil.status).toBe(400);
    const deny = await allow(authorizeUrl(client_id), "deny");
    const loc = new URL(deny.headers.get("location") as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(CB);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ error: "access_denied", state: "s1", iss: O });
  });

  it("someone with no workspace membership gets a 403 page and no code", async () => {
    session.person = await makePerson(db());
    const { client_id } = await registered();
    const get = await authorizeGet(new Request(authorizeUrl(client_id)));
    expect(get.status).toBe(403);
    const html = await get.text();
    expect(html).toContain(NO_WORKSPACES.replaceAll("'", "&#39;"));
    expect(html).not.toContain("<form");
    const post = await allow(authorizeUrl(client_id));
    expect(post.status).toBe(403);
    expect(post.headers.get("location")).toBeNull();
  });
});

describe("full connect: register → authorize → token → bearer", () => {
  it("issues a token bound to the logged-in person", async () => {
    const person = await member();
    session.person = person;
    const { client_id } = await registered();
    const res = await allow(authorizeUrl(client_id));
    expect(res.status).toBe(303);
    const back = new URL(res.headers.get("location") as string);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("iss")).toBe(O);
    const code = back.searchParams.get("code") as string;

    const form = (over: Record<string, string> = {}) =>
      token(
        new Request(`${O}/api/mcp/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            code_verifier: VERIFIER,
            client_id,
            redirect_uri: CB,
            ...over,
          }),
        }),
      );

    const wrong = await form({ code_verifier: "y".repeat(60) });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("invalid_grant");
    expect((await (await form({ grant_type: "refresh_token" })).json()).error).toBe("unsupported_grant_type");

    const good = await form();
    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("no-store");
    const body = await good.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 30 * 24 * 3600 });
    const auth = await authenticateMcp(db(), `Bearer ${body.access_token}`, new Date());
    expect(auth.person.id).toBe(person.id);
    expect(auth.token.client).toBe("claude.ai");
  });

  it("accepts a JSON token request too", async () => {
    session.person = await member();
    const { client_id } = await registered();
    const code = new URL((await allow(authorizeUrl(client_id))).headers.get("location") as string).searchParams.get(
      "code",
    );
    const res = await token(
      new Request(`${O}/api/mcp/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: VERIFIER,
          client_id,
          redirect_uri: CB,
        }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

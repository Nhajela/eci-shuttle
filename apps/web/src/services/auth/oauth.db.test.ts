import { createHash } from "node:crypto";
import { makePerson } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import { authenticateMcp } from "../mcp/tokens";
import { exchangeAuthCode, issueAuthCode, OAUTH_TOKEN_TTL_MS, registerClient } from "./oauth";

process.env.TOKEN_SECRETS = "oauth-db-test-secret-at-least-32-characters";
const SECRETS = [process.env.TOKEN_SECRETS];
const db = () => testDb();
const NOW = new Date("2026-10-12T04:10:00Z");
const VERIFIER = "a".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CB = "https://claude.ai/api/mcp/auth_callback";

async function setup() {
  const person = await makePerson(db());
  const { client_id } = registerClient({ redirect_uris: [CB], client_name: "claude.ai" }, SECRETS);
  const code = issueAuthCode(
    { personId: person.id, clientId: client_id, redirectUri: CB, codeChallenge: CHALLENGE },
    SECRETS,
    NOW.getTime(),
  );
  return { person, clientId: client_id, code };
}

describe("exchangeAuthCode", () => {
  it("a valid code + verifier → a 30-day bearer token bound to the person, named after the client", async () => {
    const { person, clientId, code } = await setup();
    const r = await exchangeAuthCode(db(), { code, codeVerifier: VERIFIER, clientId, redirectUri: CB }, NOW);
    expect(r).toMatchObject({ token_type: "Bearer", expires_in: OAUTH_TOKEN_TTL_MS / 1000 });
    const auth = await authenticateMcp(db(), r.access_token, NOW);
    expect(auth.person.id).toBe(person.id);
    expect(auth.token).toMatchObject({ kind: "oauth", client: "claude.ai" });
    expect(auth.token.expiresAt).toEqual(new Date(NOW.getTime() + OAUTH_TOKEN_TTL_MS));
  });

  it("INVALID on a wrong verifier, client, redirect, or an expired code", async () => {
    const { clientId, code } = await setup();
    const ok = { code, codeVerifier: VERIFIER, clientId, redirectUri: CB };
    const cases = [
      { ...ok, codeVerifier: "b".repeat(64) },
      { ...ok, clientId: "other" },
      { ...ok, redirectUri: "https://claude.ai/other" },
      { ...ok, code: "garbage" },
    ];
    for (const c of cases) await expect(exchangeAuthCode(db(), c, NOW)).rejects.toMatchObject({ code: "INVALID" });
    const late = new Date(NOW.getTime() + 5 * 60_000);
    await expect(exchangeAuthCode(db(), ok, late)).rejects.toMatchObject({ code: "INVALID" });
  });
});

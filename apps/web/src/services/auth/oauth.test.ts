import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { issueOAuthToken } = vi.hoisted(() => ({ issueOAuthToken: vi.fn() }));
vi.mock("../mcp/tokens", () => ({ issueOAuthToken }));

import type { Db } from "@/db";
import {
  authorizationServerMetadata,
  exchangeAuthCode,
  issueAuthCode,
  OAUTH_CODE_TTL_MS,
  OAUTH_TOKEN_TTL_MS,
  protectedResourceMetadata,
  registerClient,
  validateAuthorize,
} from "./oauth";

const SECRETS = ["k".repeat(32)];
const URI = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const now = 1_790_000_000_000;

beforeEach(() => {
  process.env.TOKEN_SECRETS = SECRETS.join(",");
  issueOAuthToken.mockReset().mockResolvedValue({ token: "shs_x", row: {} });
});

const authParams = (clientId: string, over = {}) => ({
  response_type: "code" as const,
  client_id: clientId,
  redirect_uri: URI,
  code_challenge: challenge,
  code_challenge_method: "S256" as const,
  state: "st",
  ...over,
});

describe("oauth", () => {
  it("registers https and localhost clients, refuses others", () => {
    const c = registerClient({ redirect_uris: [URI, "http://localhost:6274/cb"], client_name: "claude.ai" }, SECRETS);
    expect(c).toMatchObject({ client_name: "claude.ai", redirect_uris: [URI, "http://localhost:6274/cb"] });
    expect(c.token_endpoint_auth_method).toBe("none");
    expect(() => registerClient({ redirect_uris: ["http://evil.com/cb"] }, SECRETS)).toThrow(
      expect.objectContaining({ code: "INVALID" }),
    );
    expect(() => registerClient({ redirect_uris: [] }, SECRETS)).toThrow(expect.objectContaining({ code: "INVALID" }));
  });

  it("validates authorize params against the registered client", () => {
    const { client_id } = registerClient({ redirect_uris: [URI], client_name: "claude.ai" }, SECRETS);
    expect(validateAuthorize(authParams(client_id), SECRETS, now)).toEqual({
      clientName: "claude.ai",
      redirectUri: URI,
      state: "st",
      codeChallenge: challenge,
    });
    const bad = [
      authParams(client_id, { redirect_uri: "https://evil.com/cb" }),
      authParams("forged"),
      authParams(client_id, { code_challenge_method: "plain" }),
    ];
    for (const p of bad)
      expect(() => validateAuthorize(p as never, SECRETS, now)).toThrow(expect.objectContaining({ code: "INVALID" }));
  });

  it("exchanges a code with the right verifier for a token", async () => {
    const { client_id } = registerClient({ redirect_uris: [URI], client_name: "claude.ai" }, SECRETS);
    const code = issueAuthCode(
      { personId: "p1", clientId: client_id, redirectUri: URI, codeChallenge: challenge },
      SECRETS,
      now,
    );
    const at = new Date(now + 1000);
    const db = {} as Db;
    const r = await exchangeAuthCode(db, { code, codeVerifier: verifier, clientId: client_id, redirectUri: URI }, at);
    expect(r).toEqual({ access_token: "shs_x", token_type: "Bearer", expires_in: OAUTH_TOKEN_TTL_MS / 1000 });
    expect(issueOAuthToken).toHaveBeenCalledWith(
      db,
      { personId: "p1", client: "claude.ai", expiresAt: new Date(at.getTime() + OAUTH_TOKEN_TTL_MS) },
      at,
    );
  });

  it("refuses a wrong verifier, client or redirect, an expired code, or a client id used as a code", async () => {
    const { client_id } = registerClient({ redirect_uris: [URI] }, SECRETS);
    const other = registerClient({ redirect_uris: [URI] }, SECRETS).client_id;
    const code = issueAuthCode(
      { personId: "p1", clientId: client_id, redirectUri: URI, codeChallenge: challenge },
      SECRETS,
      now,
    );
    const ok = { code, codeVerifier: verifier, clientId: client_id, redirectUri: URI };
    const cases: [typeof ok, number][] = [
      [{ ...ok, codeVerifier: "w".repeat(50) }, now],
      [{ ...ok, clientId: other }, now],
      [{ ...ok, redirectUri: "https://claude.ai/other" }, now],
      [ok, now + OAUTH_CODE_TTL_MS + 1],
      [{ ...ok, code: client_id }, now],
    ];
    for (const [input, t] of cases)
      await expect(exchangeAuthCode({} as Db, input, new Date(t))).rejects.toMatchObject({ code: "INVALID" });
    expect(issueOAuthToken).not.toHaveBeenCalled();
  });

  it("publishes metadata under the origin", () => {
    const o = "https://x.test";
    expect(authorizationServerMetadata(o)).toMatchObject({
      issuer: o,
      authorization_endpoint: `${o}/api/mcp/oauth/authorize`,
      token_endpoint: `${o}/api/mcp/oauth/token`,
      registration_endpoint: `${o}/api/mcp/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(protectedResourceMetadata(o)).toMatchObject({ resource: `${o}/api/mcp`, authorization_servers: [o] });
  });
});

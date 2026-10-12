import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  issueAuthCode,
  protectedResourceMetadata,
  registerClient,
  validateAuthorize,
} from "./oauth";
import { unseal } from "./seal";

const SECRETS = ["oauth-test-secret-at-least-32-characters"];
const NOW = 1_760_000_000_000;
const VERIFIER = "v".repeat(50);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CB = "https://claude.ai/api/mcp/auth_callback";

const client = () =>
  registerClient({ redirect_uris: [CB, "http://localhost:8123/cb"], client_name: "claude.ai" }, SECRETS);
const params = (over: Record<string, string> = {}) => ({
  response_type: "code" as const,
  client_id: client().client_id,
  redirect_uri: CB,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256" as const,
  state: "st",
  ...over,
});

describe("registerClient", () => {
  it("returns a sealed client id and the RFC 7591 shape", () => {
    const c = client();
    expect(c).toMatchObject({
      client_name: "claude.ai",
      redirect_uris: [CB, "http://localhost:8123/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
    expect(unseal(c.client_id, SECRETS, NOW)).toEqual({ redirectUris: c.redirect_uris, name: "claude.ai" });
    expect(registerClient({ redirect_uris: [CB] }, SECRETS).client_name).toBeNull();
  });

  it.each(["http://evil.example/cb", "javascript:alert(1)", "https://claude.ai/cb#frag", "ftp://x/cb"])(
    "refuses redirect %s as INVALID",
    (uri) => {
      expect(() => registerClient({ redirect_uris: [uri] }, SECRETS)).toThrow(
        expect.objectContaining({ code: "INVALID" }),
      );
    },
  );

  it("accepts http on 127.0.0.1", () => {
    expect(registerClient({ redirect_uris: ["http://127.0.0.1:9/cb"] }, SECRETS).redirect_uris).toHaveLength(1);
  });
});

describe("validateAuthorize", () => {
  it("returns what the consent page and code need", () => {
    expect(validateAuthorize(params(), SECRETS, NOW)).toEqual({
      clientName: "claude.ai",
      redirectUri: CB,
      state: "st",
      codeChallenge: CHALLENGE,
    });
    const { state: _s, ...noState } = params();
    expect(validateAuthorize(noState, SECRETS, NOW).state).toBeNull();
  });

  it("a loopback redirect may use another port (RFC 8252)", () => {
    expect(validateAuthorize(params({ redirect_uri: "http://localhost:5555/cb" }), SECRETS, NOW).redirectUri).toBe(
      "http://localhost:5555/cb",
    );
  });

  it.each([
    ["an unknown client", { client_id: "garbage" }],
    ["an unregistered redirect", { redirect_uri: "https://evil.example/cb" }],
    ["another loopback path", { redirect_uri: "http://localhost:8123/other" }],
    ["a plain challenge method", { code_challenge_method: "plain" }],
    ["a malformed challenge", { code_challenge: `${"*".repeat(43)}` }],
    ["response_type token", { response_type: "token" }],
  ])("INVALID for %s", (_label, over) => {
    expect(() => validateAuthorize(params(over as Record<string, string>), SECRETS, NOW)).toThrow(
      expect.objectContaining({ code: "INVALID" }),
    );
  });

  it("a client id sealed with a rotated-out secret no longer opens", () => {
    expect(() => validateAuthorize(params(), ["another-secret-at-least-32-characters-x"], NOW)).toThrow(
      expect.objectContaining({ code: "INVALID" }),
    );
  });
});

describe("issueAuthCode", () => {
  it("seals person, client, redirect and challenge for 5 minutes", () => {
    const input = { personId: "p1", clientId: "c1", redirectUri: CB, codeChallenge: CHALLENGE };
    const code = issueAuthCode(input, SECRETS, NOW);
    expect(unseal(code, SECRETS, NOW + 299_000)).toEqual(input);
    expect(unseal(code, SECRETS, NOW + 300_000)).toBeNull();
  });
});

describe("metadata", () => {
  it("authorization server (RFC 8414)", () => {
    expect(authorizationServerMetadata("https://x.test")).toMatchObject({
      issuer: "https://x.test",
      authorization_endpoint: "https://x.test/api/mcp/oauth/authorize",
      token_endpoint: "https://x.test/api/mcp/oauth/token",
      registration_endpoint: "https://x.test/api/mcp/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("protected resource (RFC 9728)", () => {
    expect(protectedResourceMetadata("https://x.test")).toMatchObject({
      resource: "https://x.test/api/mcp",
      authorization_servers: ["https://x.test"],
      bearer_methods_supported: ["header"],
    });
  });
});

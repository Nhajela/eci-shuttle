/**
 * web-mcp: OAuth /authorize (SPEC §7a: "Connect" → Telegram login → a token bound to that admin).
 * GET: check the client and redirect URI first (never redirect to an unchecked URI), send logged-out people to
 * /login?next=<this URL>, else show "Allow <client>?". POST (same URL, same-origin only): Allow → a sealed code back
 * to the client; Cancel → access_denied.
 */
import { env, origin } from "@/lib/env";
import { currentPerson } from "@/lib/session";
import { issueAuthCode, validateAuthorize } from "@/services/auth/oauth";
import { isServiceError } from "@/services/kernel";

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ECI Shuttle</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}b{color:var(--fg)}
form{display:flex;flex-direction:column;gap:8px;margin-top:16px}
button{min-height:44px;border-radius:8px;font:inherit;font-weight:600;border:1px solid var(--line);background:transparent;color:var(--fg)}
button[value=allow]{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><main><div class="card"><h1>${esc(title)}</h1>${body}</div></main></body></html>`,
    { status, headers: PAGE_HEADERS },
  );
}

const errorPage = (message: string) =>
  page("Can't connect", `<p>${esc(message)}</p><p>Go back to your app and connect again.</p>`, 400);

function backToClient(redirectUri: string, params: Record<string, string | null>): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", origin());
  return new Response(null, { status: 303, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

function check(request: Request) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams);
  try {
    return { url, params, ok: validateAuthorize(params as never, env.tokenSecrets(), Date.now()) } as const;
  } catch (e) {
    if (isServiceError(e)) return { url, params, error: e.message } as const;
    throw e;
  }
}

const toLogin = (url: URL) =>
  new Response(null, {
    status: 303,
    headers: { Location: `${origin()}/login?next=${encodeURIComponent(url.pathname + url.search)}` },
  });

export async function GET(request: Request): Promise<Response> {
  const c = check(request);
  if (!c.ok) return errorPage(c.error);
  const person = await currentPerson();
  if (!person) return toLogin(c.url);
  const who = esc(person.firstName ?? (person.username ? `@${person.username}` : "you"));
  const client = esc(c.ok.clientName ?? "An MCP client");
  return page(
    "Connect to ECI Shuttle?",
    `<p><b>${client}</b> wants to act as <b>${who}</b> in ECI Shuttle.</p>
<p>It can read everything your role allows in your workspaces, and make changes after you confirm each one in the chat. Every change is logged under your name.</p>
<p>You can revoke it any time in admin → People. It expires in 30 days.</p>
<form method="post" action="${esc(c.url.pathname + c.url.search)}">
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Cancel</button>
</form>`,
  );
}

export async function POST(request: Request): Promise<Response> {
  // the session cookie is SameSite=Lax, but check the origin too: only our own consent page may post here
  if (request.headers.get("origin") !== origin()) return errorPage("This request didn't come from the consent page.");
  const c = check(request);
  if (!c.ok) return errorPage(c.error);
  const state = c.ok.state;
  const form = await request.formData().catch(() => null);
  if (form?.get("decision") !== "allow")
    return backToClient(c.ok.redirectUri, { error: "access_denied", error_description: "Cancelled.", state });
  const person = await currentPerson();
  if (!person) return toLogin(c.url);
  const code = issueAuthCode(
    {
      personId: person.id,
      clientId: c.params.client_id,
      redirectUri: c.ok.redirectUri,
      codeChallenge: c.ok.codeChallenge,
    },
    env.tokenSecrets(),
    Date.now(),
  );
  return backToClient(c.ok.redirectUri, { code, state });
}

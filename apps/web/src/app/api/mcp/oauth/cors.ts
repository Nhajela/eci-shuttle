/** web-mcp: CORS for the OAuth endpoints and metadata (browser-based connectors call them cross-origin). */
export const CORS = { "Access-Control-Allow-Origin": "*" } as const;

export const preflight = (methods: string) => () =>
  new Response(null, {
    status: 204,
    headers: { ...CORS, "Access-Control-Allow-Methods": methods, "Access-Control-Allow-Headers": "content-type" },
  });

// Types for setup-bot.mjs (the web package has allowJs off), so its test type-checks.
export declare const COMMANDS: { command: string; description: string }[];
export declare function setupBot(opts: {
  token: string;
  origin: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<string>;

/**
 * svc-bot: the GIF moments (SPEC §6c). Files live in the app's public dir and are served from the one origin:
 * never a hardcoded host. Sent as TelegramPayload.animation with the text as caption (deliver.ts falls back to
 * text when Telegram refuses the file, so a missing GIF never loses a message).
 */
import { origin } from "@/lib/env";

export type Gif = "welcome" | "on-the-way" | "break" | "goodnight";

/** `https://<origin>/gifs/<name>.gif` */
export const gifUrl = (name: Gif): string => `${origin()}/gifs/${name}.gif`;

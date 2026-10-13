/**
 * svc-bot: the Telegram shapes the bot reads (only the fields used) and what handlers return. Handlers are
 * functions over the service layer: they never call Telegram themselves; the webhook adapter performs a
 * BotReply right away (bot/deliver.sendNow), and anything later goes through the outbox.
 */
import type { Db } from "@/db";
import type { Person, Workspace } from "@/db/types";
import type { TelegramButton, TelegramPayload } from "../kernel";

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
export type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
export type TgMessage = {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
  /** set on edited_message updates (seconds) */
  edit_date?: number;
  /** live_period is set while it is a live location; heading 1..360, horizontal_accuracy 0..1500 m */
  location?: {
    latitude: number;
    longitude: number;
    horizontal_accuracy?: number;
    live_period?: number;
    heading?: number;
  };
};
export type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
export type TgChatMemberUpdated = { chat: TgChat; from: TgUser; new_chat_member: { status: string } };
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  /** every live-location update arrives as an edit of the first location message */
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  /** status "kicked" in a private chat = the person blocked the bot */
  my_chat_member?: TgChatMemberUpdated;
};

/** What a handler wants done now. */
export type BotReply = {
  /** sent in order (kind "reply" unless set), logged in telegram_messages */
  send: TelegramPayload[];
  /** stops the button spinner; text shows as a toast (or an alert box when showAlert) */
  answerCallback?: { callbackQueryId: string; text?: string; showAlert?: boolean };
  /** replace the pressed message's text and buttons (confirm steps, the /notice wizard) */
  edit?: { chatId: number; messageId: number; html: string; buttons?: TelegramButton[][] };
};

export type BotContext = {
  db: Db;
  now: Date;
  /** the sender, upserted from Telegram */
  person: Person;
  /** the chat to answer in */
  chatId: number;
  /**
   * The workspace the bot speaks for: the live one. Admin commands take an optional trailing workspace slug
   * ("/status test") and resolve it with auth/actor.resolveWorkspace.
   */
  workspace: Workspace;
};

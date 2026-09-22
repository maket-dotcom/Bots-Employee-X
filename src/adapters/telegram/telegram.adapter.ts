import { Bot, Context } from 'grammy';
import type { Chat, Message } from 'grammy/types';
import { PlatformAdapter } from '../types';
import { ingestMessage, applyMessageEdit } from '../../core/ingest';
import { NormalizedAttachment, NormalizedMessage } from '../../core/types';

/**
 * Telegram adapter — long polling, so no public URL is required.
 *
 * IMPORTANT setup step: by default Telegram bots do NOT receive regular group
 * messages (only commands). Either disable privacy mode via @BotFather
 * (/setprivacy -> Disable) or make the bot a group admin.
 */
export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const;
  private bot: Bot;
  private allowedChatIds: Set<string> | null;

  constructor(botToken: string, allowedChatIds: string[] = []) {
    this.bot = new Bot(botToken);
    // null = open mode (no restriction); Set = strict allowlist
    this.allowedChatIds = allowedChatIds.length > 0 ? new Set(allowedChatIds) : null;

    // Bot's own membership changed (added to / removed from a chat).
    // If someone adds the bot to a chat that is not on the allowlist, leave it.
    this.bot.on('my_chat_member', async (ctx) => {
      const update = ctx.myChatMember;
      const status = update.new_chat_member.status;
      const joined = status === 'member' || status === 'administrator' || status === 'restricted';
      if (joined && !this.isChatAllowed(update.chat)) {
        const title = 'title' in update.chat ? update.chat.title : '';
        console.warn(
          `[telegram] bot was added to unauthorized chat ${update.chat.id} "${title}" ` +
            `by user ${update.from.id} (@${update.from.username ?? 'unknown'}) — leaving`
        );
        try {
          await ctx.api.leaveChat(update.chat.id);
        } catch (err) {
          console.error('[telegram] failed to leave unauthorized chat:', err);
        }
      }
    });

    this.bot.on('message', async (ctx) => {
      // Safety net: never ingest from (and don't stay in) unauthorized chats,
      // e.g. chats joined before the allowlist was configured.
      if (!this.isChatAllowed(ctx.message.chat)) {
        console.warn(
          `[telegram] message from unauthorized chat ${ctx.message.chat.id} — leaving, not ingesting`
        );
        await ctx.leaveChat().catch(() => undefined);
        return;
      }
      try {
        await ingestMessage(this.normalize(ctx, ctx.message));
      } catch (err) {
        console.error('[telegram] failed to ingest message:', err);
      }
    });

    this.bot.on('edited_message', async (ctx) => {
      const edited = ctx.editedMessage;
      if (!edited) return;
      if (!this.isChatAllowed(edited.chat)) return;
      try {
        await applyMessageEdit({
          platform: 'telegram',
          platformChatId: String(edited.chat.id),
          platformMessageId: String(edited.message_id),
          text: edited.text ?? edited.caption,
          editedAt: edited.edit_date ? new Date(edited.edit_date * 1000) : new Date(),
          raw: edited,
        });
      } catch (err) {
        console.error('[telegram] failed to apply edit:', err);
      }
    });

    this.bot.catch((err) => {
      console.error('[telegram] bot error:', err.message);
    });
  }

  private isChatAllowed(chat: Chat): boolean {
    if (chat.type === 'private') return true; // DMs with the bot are always fine
    if (!this.allowedChatIds) return true; // open mode
    return this.allowedChatIds.has(String(chat.id));
  }

  private normalize(ctx: Context, msg: Message): NormalizedMessage {
    const chat = msg.chat;
    const from = msg.from;

    return {
      platform: 'telegram',
      platformMessageId: String(msg.message_id),
      platformChatId: String(chat.id),
      platformUserId: from ? String(from.id) : 'unknown',
      chatName: 'title' in chat ? chat.title : undefined,
      chatType: chat.type,
      senderName: from
        ? [from.first_name, from.last_name].filter(Boolean).join(' ')
        : undefined,
      senderUsername: from?.username,
      senderIsBot: from?.is_bot ?? false,
      text: msg.text ?? msg.caption,
      attachments: this.extractAttachments(msg),
      replyToMessageId: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
      sentAt: new Date(msg.date * 1000),
      raw: msg,
    };
  }

  private extractAttachments(msg: Message): NormalizedAttachment[] {
    const attachments: NormalizedAttachment[] = [];

    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      attachments.push({
        type: 'photo',
        platformFileId: largest.file_id,
        size: largest.file_size,
      });
    }
    if (msg.document) {
      attachments.push({
        type: 'document',
        name: msg.document.file_name,
        mimeType: msg.document.mime_type,
        size: msg.document.file_size,
        platformFileId: msg.document.file_id,
      });
    }
    if (msg.video) {
      attachments.push({
        type: 'video',
        mimeType: msg.video.mime_type,
        size: msg.video.file_size,
        platformFileId: msg.video.file_id,
      });
    }
    if (msg.voice) {
      attachments.push({
        type: 'voice',
        mimeType: msg.voice.mime_type,
        size: msg.voice.file_size,
        platformFileId: msg.voice.file_id,
      });
    }
    if (msg.audio) {
      attachments.push({
        type: 'audio',
        name: msg.audio.title,
        mimeType: msg.audio.mime_type,
        size: msg.audio.file_size,
        platformFileId: msg.audio.file_id,
      });
    }
    if (msg.sticker) {
      attachments.push({
        type: 'sticker',
        name: msg.sticker.emoji,
        platformFileId: msg.sticker.file_id,
      });
    }

    return attachments;
  }

  async start(): Promise<void> {
    // bot.start() resolves only when polling stops, so don't await it
    if (!this.allowedChatIds) {
      console.warn(
        '[telegram] TELEGRAM_ALLOWED_CHAT_IDS is not set — the bot will accept ANY group ' +
          'it is added to. Set it (and disable "Allow groups?" via @BotFather /setjoingroups) ' +
          'to lock the bot to your own groups.'
      );
    }
    this.bot.start({
      allowed_updates: ['message', 'edited_message', 'my_chat_member'],
      onStart: (me) => {
        console.log(`[telegram] polling started as @${me.username}`);
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}

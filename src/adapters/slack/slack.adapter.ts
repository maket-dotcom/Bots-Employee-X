import bolt from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { PlatformAdapter } from '../types';
import { ingestMessage, applyMessageEdit, markMessageDeleted } from '../../core/ingest';
import { NormalizedAttachment, NormalizedMessage } from '../../core/types';

/**
 * Slack adapter — Socket Mode, so no public URL is required.
 *
 * Required app config (api.slack.com/apps):
 *  - Socket Mode enabled, app-level token with `connections:write` (SLACK_APP_TOKEN, xapp-...)
 *  - Bot token scopes: channels:history, groups:history, users:read, channels:read, groups:read
 *  - Event subscriptions (bot events): message.channels, message.groups
 *  - Invite the bot to each channel it should read: /invite @botname
 */
export class SlackAdapter implements PlatformAdapter {
  readonly platform = 'slack' as const;
  private app: bolt.App;
  private userCache = new Map<string, { displayName?: string; username?: string; isBot?: boolean }>();
  private channelCache = new Map<string, { name?: string; type?: string }>();

  constructor(botToken: string, appToken: string) {
    this.app = new bolt.App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: bolt.LogLevel.WARN,
    });

    this.app.event('message', async ({ event, client }) => {
      try {
        const ev = event as Record<string, any>;

        if (ev.subtype === 'message_changed') {
          await applyMessageEdit({
            platform: 'slack',
            platformChatId: String(ev.channel),
            platformMessageId: String(ev.message?.ts),
            text: ev.message?.text,
            editedAt: new Date(),
            raw: ev,
          });
          return;
        }

        if (ev.subtype === 'message_deleted') {
          await markMessageDeleted({
            platform: 'slack',
            platformChatId: String(ev.channel),
            platformMessageId: String(ev.deleted_ts),
            deletedAt: new Date(),
          });
          return;
        }

        // Skip other system subtypes (channel_join, etc.) but keep plain
        // messages, bot messages, thread replies and file shares.
        if (ev.subtype && !['bot_message', 'file_share', 'thread_broadcast'].includes(ev.subtype)) {
          return;
        }

        await ingestMessage(await this.normalize(ev, client));
      } catch (err) {
        console.error('[slack] failed to process message event:', err);
      }
    });
  }

  private async normalize(ev: Record<string, any>, client: WebClient): Promise<NormalizedMessage> {
    const userId: string = ev.user ?? ev.bot_id ?? 'unknown';
    const userInfo = await this.resolveUser(userId, client);
    const channelInfo = await this.resolveChannel(String(ev.channel), client);

    const attachments: NormalizedAttachment[] = (ev.files ?? []).map((f: any) => ({
      type: 'file',
      name: f.name,
      mimeType: f.mimetype,
      size: f.size,
      platformFileId: f.id,
      url: f.url_private,
    }));

    return {
      platform: 'slack',
      platformMessageId: String(ev.ts),
      platformChatId: String(ev.channel),
      platformUserId: userId,
      chatName: channelInfo.name,
      chatType: channelInfo.type,
      senderName: userInfo.displayName,
      senderUsername: userInfo.username,
      senderIsBot: userInfo.isBot ?? Boolean(ev.bot_id),
      text: ev.text,
      attachments,
      threadId: ev.thread_ts && ev.thread_ts !== ev.ts ? String(ev.thread_ts) : undefined,
      replyToMessageId: ev.thread_ts && ev.thread_ts !== ev.ts ? String(ev.thread_ts) : undefined,
      sentAt: new Date(parseFloat(ev.ts) * 1000),
      raw: ev,
    };
  }

  private async resolveUser(userId: string, client: WebClient) {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!;
    let info: { displayName?: string; username?: string; isBot?: boolean } = {};
    try {
      const res = await client.users.info({ user: userId });
      info = {
        displayName: res.user?.profile?.display_name || res.user?.real_name,
        username: res.user?.name,
        isBot: res.user?.is_bot,
      };
    } catch {
      // bot_id senders and deactivated users can fail lookup; store id only
    }
    this.userCache.set(userId, info);
    return info;
  }

  private async resolveChannel(channelId: string, client: WebClient) {
    if (this.channelCache.has(channelId)) return this.channelCache.get(channelId)!;
    let info: { name?: string; type?: string } = {};
    try {
      const res = await client.conversations.info({ channel: channelId });
      info = {
        name: res.channel?.name,
        type: res.channel?.is_private ? 'private_channel' : 'public_channel',
      };
    } catch {
      // ignore; store id only
    }
    this.channelCache.set(channelId, info);
    return info;
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log('[slack] socket mode connection established');
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

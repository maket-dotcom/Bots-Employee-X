import { TeamsActivityHandler, TurnContext, Activity } from 'botbuilder';
import { ingestMessage, applyMessageEdit, markMessageDeleted } from '../../core/ingest';
import { NormalizedAttachment, NormalizedMessage } from '../../core/types';

/**
 * Teams activity handler.
 *
 * NOTE: to receive ALL channel messages (not only @mentions), the Teams app
 * manifest must include the RSC permission `ChannelMessage.Read.Group`
 * (see manifest/manifest.template.json) and a team owner must consent when
 * installing the app to the team.
 */
export class IngestionBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      try {
        await ingestMessage(this.normalize(context.activity));
      } catch (err) {
        console.error('[teams] failed to ingest message:', err);
      }
      await next();
    });

    this.onMessageUpdate(async (context, next) => {
      const a = context.activity;
      try {
        await applyMessageEdit({
          platform: 'teams',
          platformChatId: a.conversation?.id ?? 'unknown',
          platformMessageId: a.id ?? 'unknown',
          text: a.text,
          editedAt: a.timestamp ? new Date(a.timestamp) : new Date(),
          raw: a,
        });
      } catch (err) {
        console.error('[teams] failed to apply edit:', err);
      }
      await next();
    });

    this.onMessageDelete(async (context, next) => {
      const a = context.activity;
      try {
        await markMessageDeleted({
          platform: 'teams',
          platformChatId: a.conversation?.id ?? 'unknown',
          platformMessageId: a.id ?? 'unknown',
          deletedAt: new Date(),
        });
      } catch (err) {
        console.error('[teams] failed to mark deletion:', err);
      }
      await next();
    });
  }

  private normalize(a: Activity): NormalizedMessage {
    const attachments: NormalizedAttachment[] = (a.attachments ?? [])
      .filter((att) => att.contentType !== 'text/html')
      .map((att) => ({
        type: att.contentType ?? 'file',
        name: att.name,
        url: att.contentUrl,
      }));

    return {
      platform: 'teams',
      platformMessageId: a.id ?? 'unknown',
      platformChatId: a.conversation?.id ?? 'unknown',
      platformUserId: a.from?.aadObjectId ?? a.from?.id ?? 'unknown',
      chatName: (a.channelData as any)?.team?.name ?? a.conversation?.name,
      chatType: a.conversation?.conversationType,
      senderName: a.from?.name,
      senderIsBot: Boolean((a.from as any)?.role === 'bot'),
      text: TurnContext.removeRecipientMention(a) || a.text,
      attachments,
      replyToMessageId: a.replyToId,
      threadId: a.conversation?.id?.includes(';messageid=')
        ? a.conversation.id.split(';messageid=')[1]
        : undefined,
      sentAt: a.timestamp ? new Date(a.timestamp) : new Date(),
      raw: a,
    };
  }
}

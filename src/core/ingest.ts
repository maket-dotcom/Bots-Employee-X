import { MessageModel } from '../models/message.model';
import { ChatModel } from '../models/chat.model';
import { UserModel } from '../models/user.model';
import { MessageDeletion, MessageEdit, NormalizedMessage } from './types';

/**
 * Store a new message. Idempotent: re-delivery of the same platform message
 * (webhook retries, reconnects) is a no-op thanks to the unique index.
 */
export async function ingestMessage(msg: NormalizedMessage): Promise<void> {
  const messageUpsert = MessageModel.updateOne(
    {
      platform: msg.platform,
      platformChatId: msg.platformChatId,
      platformMessageId: msg.platformMessageId,
    },
    {
      $setOnInsert: {
        platformUserId: msg.platformUserId,
        chatName: msg.chatName,
        chatType: msg.chatType,
        senderName: msg.senderName,
        senderUsername: msg.senderUsername,
        senderIsBot: msg.senderIsBot ?? false,
        text: msg.text,
        attachments: msg.attachments ?? [],
        replyToMessageId: msg.replyToMessageId,
        threadId: msg.threadId,
        sentAt: msg.sentAt,
        raw: msg.raw,
      },
    },
    { upsert: true }
  );

  const chatUpsert = ChatModel.updateOne(
    { platform: msg.platform, platformChatId: msg.platformChatId },
    {
      $setOnInsert: { firstSeenAt: msg.sentAt },
      $set: {
        ...(msg.chatName ? { name: msg.chatName } : {}),
        ...(msg.chatType ? { type: msg.chatType } : {}),
      },
      $max: { lastMessageAt: msg.sentAt },
      $inc: { messageCount: 1 },
    },
    { upsert: true }
  );

  const userUpsert = UserModel.updateOne(
    { platform: msg.platform, platformUserId: msg.platformUserId },
    {
      $setOnInsert: { firstSeenAt: msg.sentAt, isBot: msg.senderIsBot ?? false },
      $set: {
        ...(msg.senderName ? { displayName: msg.senderName } : {}),
        ...(msg.senderUsername ? { username: msg.senderUsername } : {}),
      },
      $max: { lastSeenAt: msg.sentAt },
      $inc: { messageCount: 1 },
    },
    { upsert: true }
  );

  await Promise.all([messageUpsert, chatUpsert, userUpsert]);
}

/**
 * Apply an edit to an existing message, preserving the previous text in
 * editHistory. If the original was never captured (bot added after the fact),
 * the edit is stored as a new message.
 */
export async function applyMessageEdit(edit: MessageEdit): Promise<void> {
  const existing = await MessageModel.findOne({
    platform: edit.platform,
    platformChatId: edit.platformChatId,
    platformMessageId: edit.platformMessageId,
  });

  if (!existing) {
    await MessageModel.updateOne(
      {
        platform: edit.platform,
        platformChatId: edit.platformChatId,
        platformMessageId: edit.platformMessageId,
      },
      {
        $setOnInsert: {
          platformUserId: 'unknown',
          text: edit.text,
          sentAt: edit.editedAt,
          editedAt: edit.editedAt,
          raw: edit.raw,
        },
      },
      { upsert: true }
    );
    return;
  }

  await MessageModel.updateOne(
    { _id: existing._id },
    {
      $set: { text: edit.text, editedAt: edit.editedAt, raw: edit.raw },
      $push: { editHistory: { text: existing.text, replacedAt: edit.editedAt } },
    }
  );
}

/** Soft-delete: keep the document, flag it. Part 2 may care about deletions. */
export async function markMessageDeleted(del: MessageDeletion): Promise<void> {
  await MessageModel.updateOne(
    {
      platform: del.platform,
      platformChatId: del.platformChatId,
      platformMessageId: del.platformMessageId,
    },
    { $set: { isDeleted: true, deletedAt: del.deletedAt } }
  );
}

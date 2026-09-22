export type Platform = 'telegram' | 'slack' | 'teams';

export interface NormalizedAttachment {
  /** e.g. photo, document, video, voice, audio, sticker, file, link */
  type: string;
  name?: string;
  mimeType?: string;
  size?: number;
  /** Platform-specific file identifier (Telegram file_id, Slack file id, Teams contentUrl, ...) */
  platformFileId?: string;
  url?: string;
}

export interface NormalizedMessage {
  platform: Platform;
  platformMessageId: string;
  platformChatId: string;
  platformUserId: string;
  chatName?: string;
  chatType?: string;
  senderName?: string;
  senderUsername?: string;
  senderIsBot?: boolean;
  text?: string;
  attachments?: NormalizedAttachment[];
  /** Message this one replies to / thread root, if any */
  replyToMessageId?: string;
  threadId?: string;
  sentAt: Date;
  /** Untouched original platform payload, for Part 2 analysis */
  raw: unknown;
}

export interface MessageEdit {
  platform: Platform;
  platformMessageId: string;
  platformChatId: string;
  text?: string;
  editedAt: Date;
  raw: unknown;
}

export interface MessageDeletion {
  platform: Platform;
  platformMessageId: string;
  platformChatId: string;
  deletedAt: Date;
}

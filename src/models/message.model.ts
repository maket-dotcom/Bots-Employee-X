import { Schema, model } from 'mongoose';

const attachmentSchema = new Schema(
  {
    type: { type: String, required: true },
    name: String,
    mimeType: String,
    size: Number,
    platformFileId: String,
    url: String,
  },
  { _id: false }
);

const messageSchema = new Schema(
  {
    platform: { type: String, required: true, enum: ['telegram', 'slack', 'teams'] },
    platformMessageId: { type: String, required: true },
    platformChatId: { type: String, required: true },
    platformUserId: { type: String, required: true },
    chatName: String,
    chatType: String,
    senderName: String,
    senderUsername: String,
    senderIsBot: { type: Boolean, default: false },
    text: String,
    attachments: { type: [attachmentSchema], default: [] },
    replyToMessageId: String,
    threadId: String,
    sentAt: { type: Date, required: true },
    editedAt: Date,
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    /** History of previous text values when a message is edited */
    editHistory: {
      type: [
        new Schema(
          { text: String, replacedAt: { type: Date, required: true } },
          { _id: false }
        ),
      ],
      default: [],
    },
    raw: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'messages' }
);

// Idempotency: a platform message can only exist once
messageSchema.index(
  { platform: 1, platformChatId: 1, platformMessageId: 1 },
  { unique: true }
);
messageSchema.index({ platform: 1, platformChatId: 1, sentAt: -1 });
messageSchema.index({ sentAt: -1 });

export const MessageModel = model('Message', messageSchema);

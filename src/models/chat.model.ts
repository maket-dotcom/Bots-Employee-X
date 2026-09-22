import { Schema, model } from 'mongoose';

const chatSchema = new Schema(
  {
    platform: { type: String, required: true, enum: ['telegram', 'slack', 'teams'] },
    platformChatId: { type: String, required: true },
    name: String,
    type: String,
    firstSeenAt: { type: Date, required: true },
    lastMessageAt: Date,
    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'chats' }
);

chatSchema.index({ platform: 1, platformChatId: 1 }, { unique: true });

export const ChatModel = model('Chat', chatSchema);

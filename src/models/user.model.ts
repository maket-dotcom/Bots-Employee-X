import { Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    platform: { type: String, required: true, enum: ['telegram', 'slack', 'teams'] },
    platformUserId: { type: String, required: true },
    displayName: String,
    username: String,
    isBot: { type: Boolean, default: false },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: Date,
    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'users' }
);

userSchema.index({ platform: 1, platformUserId: 1 }, { unique: true });

export const UserModel = model('User', userSchema);

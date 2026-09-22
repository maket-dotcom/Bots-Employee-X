import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  mongoUri: required('MONGO_URI'),

  telegram: {
    enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    // Comma-separated chat ids the bot may live in. When set, the bot
    // immediately leaves any group/supergroup/channel not on this list.
    // When empty/unset, the bot accepts every chat (open mode).
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  },

  slack: {
    enabled: Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN),
    botToken: process.env.SLACK_BOT_TOKEN ?? '',
    appToken: process.env.SLACK_APP_TOKEN ?? '',
  },

  teams: {
    enabled: Boolean(process.env.MICROSOFT_APP_ID),
    appId: process.env.MICROSOFT_APP_ID ?? '',
    appPassword: process.env.MICROSOFT_APP_PASSWORD ?? '',
    appType: process.env.MICROSOFT_APP_TYPE ?? 'MultiTenant',
    tenantId: process.env.MICROSOFT_APP_TENANT_ID ?? '',
    port: Number(process.env.TEAMS_PORT ?? 3978),
  },
};

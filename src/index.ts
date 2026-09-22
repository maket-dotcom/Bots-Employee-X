import { config } from './config';
import { connectDb, disconnectDb } from './db/connection';
import { PlatformAdapter } from './adapters/types';
import { TelegramAdapter } from './adapters/telegram/telegram.adapter';
import { SlackAdapter } from './adapters/slack/slack.adapter';
import { TeamsAdapter } from './adapters/teams/teams.adapter';

async function main(): Promise<void> {
  await connectDb(config.mongoUri);

  const adapters: PlatformAdapter[] = [];

  if (config.telegram.enabled) {
    adapters.push(
      new TelegramAdapter(config.telegram.botToken, config.telegram.allowedChatIds)
    );
  }
  if (config.slack.enabled) {
    adapters.push(new SlackAdapter(config.slack.botToken, config.slack.appToken));
  }
  if (config.teams.enabled) {
    adapters.push(new TeamsAdapter(config.teams));
  }

  if (adapters.length === 0) {
    console.warn(
      'No adapters enabled. Set TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN+SLACK_APP_TOKEN, ' +
        'or MICROSOFT_APP_ID in .env to enable a platform.'
    );
  }

  for (const adapter of adapters) {
    await adapter.start();
    console.log(`[core] ${adapter.platform} adapter started`);
  }

  const shutdown = async (signal: string) => {
    console.log(`\n[core] received ${signal}, shutting down...`);
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch (err) {
        console.error(`[core] error stopping ${adapter.platform} adapter:`, err);
      }
    }
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[core] fatal startup error:', err);
  process.exit(1);
});

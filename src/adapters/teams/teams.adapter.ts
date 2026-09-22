import express from 'express';
import type { Server } from 'http';
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
} from 'botbuilder';
import { PlatformAdapter } from '../types';
import { IngestionBot } from './teams.bot';

export interface TeamsAdapterConfig {
  appId: string;
  appPassword: string;
  appType: string;
  tenantId: string;
  port: number;
}

/**
 * Teams adapter — Bot Framework messaging endpoint on /api/messages.
 *
 * Unlike Telegram/Slack, Teams REQUIRES a public HTTPS endpoint. For local
 * development use a dev tunnel (e.g. `ngrok http 3978` or VS dev tunnels) and
 * set the Azure Bot's messaging endpoint to https://<tunnel>/api/messages.
 *
 * Setup checklist (when credentials are available):
 *  1. Azure portal -> create an "Azure Bot" resource (or App Registration).
 *     -> gives MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD.
 *  2. Set messaging endpoint to https://<public-host>/api/messages.
 *  3. Enable the Microsoft Teams channel on the bot resource.
 *  4. Fill manifest/manifest.template.json placeholders, zip it with icons,
 *     upload to Teams (Apps -> Manage your apps -> Upload a custom app).
 *  5. Team owner installs it to the team and consents to RSC permissions —
 *     after that the bot receives every channel message without @mention.
 */
export class TeamsAdapter implements PlatformAdapter {
  readonly platform = 'teams' as const;
  private adapter: CloudAdapter;
  private bot: IngestionBot;
  private server?: Server;
  private config: TeamsAdapterConfig;

  constructor(config: TeamsAdapterConfig) {
    this.config = config;

    const auth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: config.appId,
      MicrosoftAppPassword: config.appPassword,
      MicrosoftAppType: config.appType,
      MicrosoftAppTenantId: config.tenantId || undefined,
    } as ConfigurationBotFrameworkAuthenticationOptions);

    this.adapter = new CloudAdapter(auth);
    this.adapter.onTurnError = async (_context, error) => {
      console.error('[teams] turn error:', error);
    };

    this.bot = new IngestionBot();
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });

    app.post('/api/messages', async (req, res) => {
      await this.adapter.process(req, res, (context) => this.bot.run(context));
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(this.config.port, () => {
        console.log(
          `[teams] messaging endpoint listening on http://localhost:${this.config.port}/api/messages`
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

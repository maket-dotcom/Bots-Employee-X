# Bots-Employee-X

Multi-platform group-chat ingestion bot. Add the bot to a Telegram group, Slack channel, or Teams team and it captures every message (including edits and deletes) into MongoDB for later analysis (Part 2).

## Architecture

```
Telegram ──► telegram adapter ─┐
Slack    ──► slack adapter    ─┼─► normalizer ─► ingest pipeline ─► MongoDB
Teams    ──► teams adapter    ─┘                 (idempotent upserts)
```

- One service, one adapter per platform (`src/adapters/*`). Adding a new platform = implementing the `PlatformAdapter` interface.
- Every message is normalized to a common shape (`src/core/types.ts`) and stored with the untouched original payload in `raw`.
- Collections: `messages`, `chats`, `users`. A unique index on `(platform, platformChatId, platformMessageId)` makes ingestion idempotent — webhook retries never duplicate.
- Edits preserve previous text in `editHistory`; deletes are soft (`isDeleted: true`).

## Setup

```bash
npm install
cp .env.example .env   # then fill in values
npm run dev
```

Adapters auto-enable based on which env vars are set. With none set, the app starts and just connects to Mongo.

### Telegram

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. **Required:** `/setprivacy` → select the bot → **Disable** (otherwise the bot only sees commands, not group messages). Alternatively make the bot a group admin.
3. Add the bot to the group. Done — uses long polling, no public URL needed.

#### Locking the bot to your own groups

Anyone who knows the bot's username can add it to their group. Two layers stop that:

1. **Allowlist (in this app):** set `TELEGRAM_ALLOWED_CHAT_IDS` to the chat ids of your groups (comma-separated). The bot immediately leaves any other chat it is added to and never ingests from it. To find a group's chat id: add the bot in open mode (var unset) and read the id from the `[telegram]` logs or the `chats` collection — group ids are negative numbers like `-1001234567890` — then put them in the allowlist and restart.
2. **BotFather (at Telegram level):** once the bot is in all your groups, send `/setjoingroups` to @BotFather and choose **Disable**. After that Telegram itself blocks *anyone* (including you) from adding the bot to new groups — the bot stays in the groups it is already in. Re-enable temporarily whenever you need to add it somewhere new.

Use both: BotFather stops new adds outright; the allowlist protects while joining is enabled and evicts the bot from anything unauthorized.

### Slack

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps).
2. Enable **Socket Mode**; create an app-level token with `connections:write` → `SLACK_APP_TOKEN` (`xapp-...`).
3. OAuth scopes (Bot Token): `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`.
4. Event Subscriptions → bot events: `message.channels`, `message.groups`.
5. Install to workspace → `SLACK_BOT_TOKEN` (`xoxb-...`).
6. In each channel to capture: `/invite @botname`.

### Microsoft Teams

Requires a public HTTPS endpoint (use `ngrok http 3978` or a VS dev tunnel during development).

1. Azure portal → create an **Azure Bot** resource → copy `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD`.
2. Set the bot's messaging endpoint to `https://<public-host>/api/messages`.
3. Enable the **Microsoft Teams** channel on the bot resource.
4. Fill the placeholders in `src/adapters/teams/manifest/manifest.template.json`, zip it together with `color.png` (192×192) and `outline.png` (32×32), and upload it in Teams as a custom app.
5. A **team owner** installs the app to the team and consents to the RSC permission `ChannelMessage.Read.Group` — this is what lets the bot read all channel messages without being @mentioned.

## MCP server — ask questions about your team's conversations

`src/mcp/server.ts` exposes the message database as MCP tools, so Claude (Desktop or Code) can answer things like *"what is going on with publisher X?"*, *"summarize the last 24h across all groups"*, or *"what has Rahul been discussing this week?"* — across **Telegram, Slack, and Teams** in one place.

| Tool | What it answers |
|---|---|
| `activity_summary` | What's going on: volume per platform, busiest chats, most active people, per-day trend |
| `list_chats` | Which groups are being captured, how active each is |
| `search_messages` | Where a topic/advertiser/publisher/deal is being discussed |
| `get_conversation` | Full chronological transcript of one group (by name or id) |
| `team_member_activity` | What a specific person said, where, and how much |
| `get_thread` | One discussion end-to-end: a message, its replies, and surrounding context |

It reads `MONGO_URI` from the project's `.env`. Read-only — the server never writes to the database. Two ways to run it:

**stdio (per-client, no port).** The MCP client spawns the process on demand:

```bash
claude mcp add bots-employee-x -- npx tsx /path/to/Bots-Employee-X/src/mcp/server.ts
```

**HTTP on port 3979 (always-on service, e.g. under pm2).** Setting `MCP_PORT` switches the transport; the endpoint is `http://localhost:3979/mcp` (health check at `/health`). This is what `ecosystem.config.cjs` runs (`bots-employee-x-mcp` app; requires `npm run build` first):

```bash
pm2 start ecosystem.config.cjs --only bots-employee-x-mcp
claude mcp add --transport http bots-employee-x http://localhost:3979/mcp
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled build |
| `npm run typecheck` | Type-check without emitting |
| `npm run mcp` | Run the MCP server (stdio) for Claude Desktop / Claude Code |

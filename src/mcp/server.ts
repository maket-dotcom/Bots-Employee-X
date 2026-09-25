/**
 * MCP server exposing the Bots-Employee-X message database as tools.
 *
 * Lets an MCP client (Claude Desktop / Claude Code) answer questions like
 * "what is my team talking about with publisher X?", "what happened in the
 * last 24h?", "show me the negotiation thread in group Y" — across Telegram,
 * Slack, and Teams, which all land in the same normalized collections.
 *
 * Transports:
 *   stdio (default): npm run mcp            — client spawns the process, no port
 *   http:            MCP_PORT=3979 npm run mcp   — long-running service (pm2),
 *                    endpoint http://localhost:3979/mcp, health at /health
 */
import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { connectDb, disconnectDb } from '../db/connection';
import { MessageModel } from '../models/message.model';
import { ChatModel } from '../models/chat.model';
import { UserModel } from '../models/user.model';

// stdio transport: stdout is reserved for the MCP protocol. Anything the app
// (or mongoose) writes via console.log would corrupt it — send it to stderr.
console.log = console.error;
console.warn = console.error;
console.info = console.error;

const PLATFORMS = ['telegram', 'slack', 'teams'] as const;
const platformParam = z
  .enum(PLATFORMS)
  .optional()
  .describe('Limit to one platform; omit for all (telegram, slack, teams)');

/** Accepts ISO dates ("2026-09-20") or relative windows ("7d", "24h"). */
function parseSince(since?: string): Date | undefined {
  if (!since) return undefined;
  const rel = /^(\d+)([dh])$/.exec(since.trim());
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2] === 'd' ? n * 86_400_000 : n * 3_600_000;
    return new Date(Date.now() - ms);
  }
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) throw new Error(`Cannot parse date: "${since}" (use ISO date, "7d", or "24h")`);
  return d;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const trim = (text: unknown, max = 500): string => {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? s.slice(0, max) + '…' : s;
};

type MsgDoc = {
  platform: string;
  platformMessageId: string;
  platformChatId: string;
  chatName?: string;
  senderName?: string;
  senderUsername?: string;
  senderIsBot?: boolean;
  text?: string;
  attachments?: { type: string; name?: string }[];
  replyToMessageId?: string;
  threadId?: string;
  sentAt: Date;
  editedAt?: Date;
  isDeleted?: boolean;
};

function formatMessage(m: MsgDoc) {
  return {
    platform: m.platform,
    chat: m.chatName ?? m.platformChatId,
    chatId: m.platformChatId,
    messageId: m.platformMessageId,
    sender: m.senderName ?? m.senderUsername ?? 'unknown',
    sentAt: m.sentAt?.toISOString(),
    text: trim(m.text),
    ...(m.attachments?.length ? { attachments: m.attachments.map((a) => a.type) } : {}),
    ...(m.replyToMessageId ? { replyTo: m.replyToMessageId } : {}),
    ...(m.threadId ? { threadId: m.threadId } : {}),
    ...(m.editedAt ? { edited: true } : {}),
    ...(m.isDeleted ? { deleted: true } : {}),
  };
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Builds a fresh McpServer with all tools registered. A factory (rather than a
 * module-level singleton) because the HTTP transport in stateless mode needs
 * an independent server instance per request.
 */
function createServer(): McpServer {
  const server = new McpServer({ name: 'bots-employee-x', version: '0.1.0' });

  // -------------------------------------------------------------- list_chats
  server.tool(
    'list_chats',
    'List the groups/channels the bot is capturing, with activity stats. Use this first to discover chat names and ids.',
    {
      platform: platformParam,
      active_since: z.string().optional().describe('Only chats with messages since this ISO date or window like "7d"/"24h"'),
    },
    async ({ platform, active_since }) => {
      const q: Record<string, unknown> = {};
      if (platform) q.platform = platform;
      const since = parseSince(active_since);
      if (since) q.lastMessageAt = { $gte: since };

      const chats = await ChatModel.find(q).sort({ lastMessageAt: -1 }).limit(200).lean();
      return json(
        chats.map((c) => ({
          platform: c.platform,
          chatId: c.platformChatId,
          name: c.name ?? '(unnamed)',
          type: c.type,
          messageCount: c.messageCount,
          lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        }))
      );
    }
  );

  // --------------------------------------------------------- search_messages
  server.tool(
    'search_messages',
    'Full-text search across all captured messages (Telegram, Slack, Teams). Good for finding where a topic, advertiser, publisher, or deal is being discussed.',
    {
      query: z.string().min(1).describe('Text to search for (case-insensitive substring match)'),
      platform: platformParam,
      chat_id: z.string().optional().describe('Limit to one chat (platformChatId from list_chats)'),
      sender: z.string().optional().describe('Limit to messages whose sender name/username contains this'),
      since: z.string().optional().describe('ISO date or window like "7d"/"24h"'),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ query, platform, chat_id, sender, since, limit }) => {
      const q: Record<string, unknown> = {
        text: { $regex: escapeRegex(query), $options: 'i' },
        isDeleted: { $ne: true },
      };
      if (platform) q.platform = platform;
      if (chat_id) q.platformChatId = chat_id;
      if (sender) {
        const r = { $regex: escapeRegex(sender), $options: 'i' };
        q.$or = [{ senderName: r }, { senderUsername: r }];
      }
      const s = parseSince(since);
      if (s) q.sentAt = { $gte: s };

      const messages = await MessageModel.find(q).sort({ sentAt: -1 }).limit(limit).lean<MsgDoc[]>();
      return json({ matches: messages.length, messages: messages.map(formatMessage) });
    }
  );

  // -------------------------------------------------------- get_conversation
  server.tool(
    'get_conversation',
    'Read a chat as a chronological transcript — what the team and the counterparty actually said. Accepts a chat id or a chat name fragment.',
    {
      chat: z.string().describe('platformChatId, or part of the chat name (e.g. "Publisher ABC")'),
      platform: platformParam,
      since: z.string().optional().describe('ISO date or window like "2d"/"12h"; default last 100 messages'),
      limit: z.number().int().min(1).max(300).default(100),
    },
    async ({ chat, platform, since, limit }) => {
      const chatQ: Record<string, unknown> = {
        $or: [{ platformChatId: chat }, { name: { $regex: escapeRegex(chat), $options: 'i' } }],
      };
      if (platform) chatQ.platform = platform;
      const chats = await ChatModel.find(chatQ).lean();
      if (chats.length === 0) return json({ error: `No chat matched "${chat}". Use list_chats to see options.` });
      if (chats.length > 1) {
        return json({
          error: 'Multiple chats matched — specify one by chatId',
          candidates: chats.map((c) => ({ platform: c.platform, chatId: c.platformChatId, name: c.name })),
        });
      }

      const c = chats[0];
      const msgQ: Record<string, unknown> = { platform: c.platform, platformChatId: c.platformChatId };
      const s = parseSince(since);
      if (s) msgQ.sentAt = { $gte: s };

      const messages = await MessageModel.find(msgQ).sort({ sentAt: -1 }).limit(limit).lean<MsgDoc[]>();
      messages.reverse(); // chronological
      return json({
        chat: { platform: c.platform, chatId: c.platformChatId, name: c.name },
        messages: messages.map(formatMessage),
      });
    }
  );

  // ---------------------------------------------------------- activity_summary
  server.tool(
    'activity_summary',
    'Overview of what is going on: message volume per platform, busiest chats, most active people, and daily volume. Start here for "what happened lately?".',
    {
      since: z.string().default('7d').describe('ISO date or window like "7d"/"24h"'),
      platform: platformParam,
    },
    async ({ since, platform }) => {
      const s = parseSince(since)!;
      const match: Record<string, unknown> = { sentAt: { $gte: s }, isDeleted: { $ne: true } };
      if (platform) match.platform = platform;

      const [byPlatform, topChats, topSenders, byDay] = await Promise.all([
        MessageModel.aggregate([
          { $match: match },
          { $group: { _id: '$platform', messages: { $sum: 1 } } },
          { $sort: { messages: -1 } },
        ]),
        MessageModel.aggregate([
          { $match: match },
          {
            $group: {
              _id: { platform: '$platform', chatId: '$platformChatId' },
              chatName: { $last: '$chatName' },
              messages: { $sum: 1 },
              lastMessageAt: { $max: '$sentAt' },
            },
          },
          { $sort: { messages: -1 } },
          { $limit: 15 },
        ]),
        MessageModel.aggregate([
          { $match: { ...match, senderIsBot: { $ne: true } } },
          {
            $group: {
              _id: { platform: '$platform', userId: '$platformUserId' },
              name: { $last: '$senderName' },
              username: { $last: '$senderUsername' },
              messages: { $sum: 1 },
              chats: { $addToSet: '$platformChatId' },
            },
          },
          { $sort: { messages: -1 } },
          { $limit: 15 },
        ]),
        MessageModel.aggregate([
          { $match: match },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$sentAt' } }, messages: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
      ]);

      return json({
        window: { since: s.toISOString(), platform: platform ?? 'all' },
        byPlatform: byPlatform.map((p) => ({ platform: p._id, messages: p.messages })),
        busiestChats: topChats.map((c) => ({
          platform: c._id.platform,
          chatId: c._id.chatId,
          name: c.chatName ?? '(unnamed)',
          messages: c.messages,
          lastMessageAt: c.lastMessageAt?.toISOString(),
        })),
        mostActivePeople: topSenders.map((u) => ({
          platform: u._id.platform,
          name: u.name ?? u.username ?? u._id.userId,
          messages: u.messages,
          activeInChats: u.chats.length,
        })),
        messagesPerDay: byDay.map((d) => ({ date: d._id, messages: d.messages })),
      });
    }
  );

  // ------------------------------------------------------ team_member_activity
  server.tool(
    'team_member_activity',
    'What a specific person has been saying and where — across Telegram, Slack, and Teams. Matches by name or username.',
    {
      person: z.string().min(1).describe('Name or username fragment, e.g. "rahul"'),
      since: z.string().default('7d').describe('ISO date or window like "7d"/"24h"'),
      limit: z.number().int().min(1).max(100).default(30).describe('Max recent messages to return'),
    },
    async ({ person, since, limit }) => {
      const r = { $regex: escapeRegex(person), $options: 'i' };
      const s = parseSince(since)!;

      const users = await UserModel.find({ $or: [{ displayName: r }, { username: r }] }).lean();
      const msgQ = {
        $or: [{ senderName: r }, { senderUsername: r }],
        sentAt: { $gte: s },
        isDeleted: { $ne: true },
      };

      const [perChat, recent] = await Promise.all([
        MessageModel.aggregate([
          { $match: msgQ },
          {
            $group: {
              _id: { platform: '$platform', chatId: '$platformChatId' },
              chatName: { $last: '$chatName' },
              messages: { $sum: 1 },
              lastMessageAt: { $max: '$sentAt' },
            },
          },
          { $sort: { messages: -1 } },
        ]),
        MessageModel.find(msgQ).sort({ sentAt: -1 }).limit(limit).lean<MsgDoc[]>(),
      ]);

      return json({
        matchedIdentities: users.map((u) => ({
          platform: u.platform,
          name: u.displayName ?? u.username,
          totalMessages: u.messageCount,
          lastSeenAt: u.lastSeenAt?.toISOString(),
        })),
        activityByChat: perChat.map((c) => ({
          platform: c._id.platform,
          chat: c.chatName ?? c._id.chatId,
          messages: c.messages,
          lastMessageAt: c.lastMessageAt?.toISOString(),
        })),
        recentMessages: recent.map(formatMessage),
      });
    }
  );

  // ---------------------------------------------------------------- get_thread
  server.tool(
    'get_thread',
    'Fetch a message with its full reply thread and surrounding context — for reading one discussion (e.g. a negotiation) end to end.',
    {
      platform: z.enum(PLATFORMS),
      chat_id: z.string().describe('platformChatId the message belongs to'),
      message_id: z.string().describe('platformMessageId of any message in the thread'),
      context: z.number().int().min(0).max(50).default(10).describe('Also include this many messages before/after by time'),
    },
    async ({ platform, chat_id, message_id, context }) => {
      const base = { platform, platformChatId: chat_id };
      const root = await MessageModel.findOne({ ...base, platformMessageId: message_id }).lean<MsgDoc | null>();
      if (!root) return json({ error: 'Message not found' });

      const threadKey = root.threadId ?? root.replyToMessageId ?? root.platformMessageId;
      const [thread, before, after] = await Promise.all([
        MessageModel.find({
          ...base,
          $or: [
            { platformMessageId: threadKey },
            { threadId: threadKey },
            { replyToMessageId: threadKey },
          ],
        })
          .sort({ sentAt: 1 })
          .lean<MsgDoc[]>(),
        MessageModel.find({ ...base, sentAt: { $lt: root.sentAt } }).sort({ sentAt: -1 }).limit(context).lean<MsgDoc[]>(),
        MessageModel.find({ ...base, sentAt: { $gt: root.sentAt } }).sort({ sentAt: 1 }).limit(context).lean<MsgDoc[]>(),
      ]);

      return json({
        message: formatMessage(root),
        thread: thread.map(formatMessage),
        contextBefore: before.reverse().map(formatMessage),
        contextAfter: after.map(formatMessage),
      });
    }
  );

  return server;
}

// ----------------------------------------------------------- stdio transport
async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  // When the client disconnects (transport close or stdin EOF), exit —
  // otherwise the open mongoose connection keeps the process alive forever.
  const shutdown = () => {
    void disconnectDb().finally(() => process.exit(0));
  };
  transport.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  await createServer().connect(transport);
  console.error('[mcp] bots-employee-x MCP server ready (stdio)');
}

// ------------------------------------------------------------ http transport
async function startHttp(port: number): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', endpoint: '/mcp' });
  });

  // Stateless Streamable HTTP: a fresh server+transport pair per request, so
  // concurrent clients (whole team) can query without session bookkeeping.
  app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-push stream or session to terminate.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.listen(port, () => {
    console.error(`[mcp] bots-employee-x MCP server ready at http://localhost:${port}/mcp`);
  });
}

// ----------------------------------------------------------------------- main
(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('[mcp] MONGO_URI is required (set it in .env)');
    process.exit(1);
  }
  await connectDb(uri);

  const port = Number(process.env.MCP_PORT ?? 0);
  if (port > 0) {
    await startHttp(port);
  } else {
    await startStdio();
  }
})().catch((err) => {
  console.error('[mcp] fatal:', err);
  process.exit(1);
});

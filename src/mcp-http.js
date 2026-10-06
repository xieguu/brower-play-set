import path from 'node:path';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpBridge } from './mcp.js';
import { profiles } from './store.js';
import { launch, close } from './browser.js';
import { reserve } from './activity.js';
import { ARTIFACT_DIR, VERSION } from './config.js';
import { scopedLogger, bus, logger } from './logger.js';
import { AppError } from './errors.js';

const sessions = new Map();

async function cleanup(entry) {
  if (!entry.closing) {
    sessions.delete(entry.id);
    entry.closing = (async () => {
      try { await entry.bridge.close(); await close(entry.profileId); }
      finally { entry.release(); bus.emit('sessions'); }
    })();
  }
  return entry.closing;
}

export function mcpSessions() { return [...sessions.values()].map(({ profileId, id }) => ({ profileId, sessionId: id })); }

export async function disconnectMcp(profileId) {
  const entries = [...sessions.values()].filter(entry => entry.profileId === profileId);
  for (const entry of entries) { await entry.server.close(); await cleanup(entry); }
  return entries.length;
}

export async function closeAllMcp() {
  for (const entry of [...sessions.values()]) { await entry.server.close(); await cleanup(entry); }
}

/** Stateful Streamable HTTP transport; each connection exclusively owns one Profile. */
export async function handleMcp(req, res) {
  const profileId = req.params.id;
  const profile = profiles.get(profileId);
  if (!profile) throw new AppError('Profile 不存在', 404);
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.profileId !== profileId) throw new AppError('MCP 会话不存在或不属于此 Profile', 404);
    await entry.transport.handleRequest(req, res, req.body);
    return;
  }
  if (req.method !== 'POST' || !isInitializeRequest(req.body)) throw new AppError('请先初始化 MCP 会话');
  const id = crypto.randomUUID();
  const release = reserve(profileId, { kind: 'mcp', sessionId: id });
  const log = scopedLogger(profile);
  let entry;
  try {
    const bridge = await createMcpBridge(async () => (await launch(profile)).context,
      path.join(ARTIFACT_DIR, profileId, `mcp-${id}`), log);
    const server = new Server({ name: `browser-play-set-${profileId}`, version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => bridge.tools());
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try { return await bridge.call(request.params.name, request.params.arguments || {}, extra.signal); }
      catch (error) { log.error(`MCP 操作失败：${error.message}`); return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true });
    entry = { id, profileId, bridge, server, transport, release };
    sessions.set(id, entry);
    server.onclose = () => { cleanup(entry).catch(error => logger.error(`MCP 清理失败：${error.message}`)); };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    if (!transport.sessionId) { await server.close(); await cleanup(entry); return; }
    log.info('MCP 客户端已连接'); bus.emit('sessions');
  } catch (error) {
    if (entry) { await entry.server.close(); await cleanup(entry); }
    else release();
    throw error;
  }
}

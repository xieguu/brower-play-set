import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import PQueue from 'p-queue';

/** The real Microsoft MCP server, attached to the same persistent context as Playwright tasks. */
export async function createMcpBridge(getContext, outputDir, logger) {
  fs.mkdirSync(outputDir, { recursive: true });
  const server = await createConnection({
    outputDir, filePaths: 'absolute', webmcp: false, allowUnrestrictedFileAccess: true,
    timeouts: { action: 30000, navigation: 60000, idle: 0 },
  }, getContext);
  const client = new Client({ name: 'browser-play-set', version: '1.0.0' }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(path.resolve(outputDir)).href, name: 'Profile task output' }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const queue = new PQueue({ concurrency: 1 });
  try { await server.connect(serverTransport); await client.connect(clientTransport); }
  catch (error) { await server.close(); throw error; }
  return {
    tools: () => client.listTools(),
    call(tool, args = {}, signal, timeout = 120000) {
      return queue.add(async () => {
        signal?.throwIfAborted();
        logger?.info(`MCP：${tool}`);
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout });
        if (result.isError) throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || `MCP ${tool} 失败`);
        return result;
      });
    },
    async close() { await client.close(); await server.close(); },
  };
}

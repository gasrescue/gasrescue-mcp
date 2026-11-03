#!/usr/bin/env node
// MCP server for gasrescue over stdio: one JSON-RPC message per line on stdin and stdout. Logs go to
// stderr only, stdout belongs to the protocol.
//   GASRESCUE_API                 default https://gasrescue.io
//   GASRESCUE_EVM_PRIVATE_KEY     optional: lets sign_and_submit sign EVM quotes with this wallet
//   GASRESCUE_ALLOWED_RECIPIENTS  optional, comma separated: sign_and_submit sends only to these
const readline = require('readline');
const { createTools, DEFAULT_API } = require('./tools');
const { version } = require('./package.json');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'gasrescue moves stablecoins (USDC, USDT, USDG) out of a wallet that has no gas, or swaps them into the gas coin. '
  + 'Typical flow: check_wallet, then quote_send or quote_swap, show the summary to the user, then either sign_and_submit (if this server has a wallet) '
  + 'or get_signing_request, sign with the user\'s wallet, and submit_signatures. Transfers are final.';

const tools = createTools({
  api: process.env.GASRESCUE_API || DEFAULT_API,
  evmPrivateKey: process.env.GASRESCUE_EVM_PRIVATE_KEY || null,
  allowedRecipients: (process.env.GASRESCUE_ALLOWED_RECIPIENTS || '').split(','),
});
const byName = new Map(tools.map((tool) => [tool.name, tool]));

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

async function handle({ method, params = {} }) {
  if (method === 'initialize') {
    const asked = params.protocolVersion;
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'gasrescue', title: 'gasrescue', version },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  if (method === 'tools/call') {
    const tool = byName.get(params.name);
    if (!tool) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 });
    try {
      const result = await tool.run(params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
    } catch (error) {
      // A refused or failed call is a tool result the agent can read, not a protocol error.
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    // A Windows pipe may start the stream with a byte order mark.
    message = JSON.parse(line.replace(/^﻿/, ''));
  } catch {
    write({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // Notifications such as notifications/initialized carry no id and get no answer.
  if (message.id === undefined || message.id === null) return;
  try {
    write({ id: message.id, result: await handle(message) });
  } catch (error) {
    write({ id: message.id, error: { code: error.code || -32603, message: error.message } });
  }
});
process.stderr.write(`gasrescue MCP ${version} on ${process.env.GASRESCUE_API || DEFAULT_API}\n`);

// Smoke test without network: starts the server over stdio like an MCP client and checks the handshake,
// the tool list with titles and annotations, and the error for an unknown method. Runs in CI.
//   npm test
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, GASRESCUE_EVM_PRIVATE_KEY: '' } });
const waiting = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (waiting.has(message.id)) waiting.get(message.id)(message);
  }
});
let next = 1;
const call = (method, params) => new Promise((resolve) => {
  const id = next;
  next += 1;
  waiting.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

async function main() {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci', version: '1' } });
  assert.strictEqual(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools, 'tools capability');
  assert.strictEqual(init.result.serverInfo.version, require('./package.json').version);

  const { tools } = (await call('tools/list')).result;
  const names = tools.map((tool) => tool.name);
  assert.deepStrictEqual(names, ['gasrescue_info', 'check_wallet', 'quote_send', 'quote_swap', 'get_signing_request', 'submit_signatures', 'get_transfer']);
  for (const tool of tools) {
    assert.ok(tool.title && tool.description.length > 100, `${tool.name}: title and description`);
    assert.strictEqual(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name}: annotations`);
    assert.strictEqual(tool.inputSchema.type, 'object', `${tool.name}: input schema`);
  }
  assert.strictEqual(tools.find((tool) => tool.name === 'submit_signatures').annotations.destructiveHint, true);
  assert.strictEqual(tools.find((tool) => tool.name === 'check_wallet').annotations.readOnlyHint, true);

  const badId = (await call('tools/call', { name: 'get_transfer', arguments: { transferId: 'abc' } })).result;
  assert.ok(badId.isError && /Transfer not found/.test(badId.content[0].text), 'malformed id is refused before any request');

  const unknown = await call('no/such/method');
  assert.strictEqual(unknown.error.code, -32601);
  assert.deepStrictEqual((await call('ping')).result, {});
  console.log(`ok: ${tools.length} tools with titles and annotations`);
}

main().then(() => { child.kill(); process.exit(0); }, (error) => { console.error(error.message); child.kill(); process.exit(1); });

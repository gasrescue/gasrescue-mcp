// sign_and_submit against an API that lies: a local stand-in for gasrescue answers honestly or changes
// what it asks the wallet to sign, and every change must be refused before anything is signed. No chain,
// no network beyond 127.0.0.1. Runs with npm test.
const assert = require('assert');
const http = require('http');
const { ethers } = require('ethers');
const { createTools, verifyEvm, isLiveApi, LIVE_CHAINS, TYPES } = require('./tools');

const CHAIN_ID = 8453;
const live = LIVE_CHAINS[CHAIN_ID];
const RELAY = live.relay;
const TOKEN = live.tokens.USDC;
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111';
const agent = ethers.Wallet.createRandom();
const bob = ethers.Wallet.createRandom().address;
const dave = ethers.Wallet.createRandom().address;
const attacker = ethers.Wallet.createRandom().address;
const DOMAIN_FIELDS = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const typed = (domain, primaryType, message) => ({ domain, types: { EIP712Domain: DOMAIN_FIELDS, [primaryType]: TYPES[primaryType] }, primaryType, message });

let lie = null; // how the stand-in changes the signing request
let quoteLie = null; // how it changes the quote itself
let nextId = 1;
const transfers = new Map();
const submitted = [];
let lastRequest = null;

function view(input, id) {
  return {
    id, chain: 'base', chainLabel: 'Base', kind: 'evm', chainId: CHAIN_ID, token: 'USDC', sender: input.sender, recipient: input.recipient,
    amount: String(input.amount), fee: '0.25', net: String(Number(input.amount) - 0.25), feePercent: '1.25', swap: null, contract: RELAY, status: 'quoted',
  };
}

// The signing request for a USDC send, as gasrescue builds it: one authorization whose nonce binds the order.
function signRequest(transfer) {
  const t = JSON.parse(JSON.stringify(transfer));
  const order = {
    sender: t.sender, recipient: t.recipient, token: TOKEN, amount: ethers.parseUnits(t.amount, 6).toString(), fee: ethers.parseUnits(t.fee, 6).toString(),
    deadline: String(Math.floor(Date.now() / 1000) + 600), salt: ethers.hexlify(ethers.randomBytes(32)),
  };
  const request = { transfer: t, kind: 'evm-typed-data', chainId: CHAIN_ID, binding: typed({ name: 'GasRelay', version: '1', chainId: CHAIN_ID, verifyingContract: RELAY }, 'Transfer', order) };
  const tokenDomain = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: TOKEN };
  if (lie) lie(request, tokenDomain);
  const b = request.binding;
  const nonce = ethers.TypedDataEncoder.hash(b.domain, { [b.primaryType]: b.types[b.primaryType] }, b.message);
  const auth = { from: request.binding.message.sender, to: request.transfer.contract, value: request.binding.message.amount, validAfter: '0', validBefore: request.binding.message.deadline, nonce };
  request.steps = request.steps || [{ label: 'Authorize USDC transfer', typedData: typed(tokenDomain, 'ReceiveWithAuthorization', auth) }];
  if (request.afterSteps) request.afterSteps(request);
  delete request.afterSteps;
  lastRequest = request;
  return request;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const input = body ? JSON.parse(body) : {};
    if (req.method === 'GET' && req.url === '/api/config') return send(200, { chains: [{ key: 'base', contract: RELAY, swap: { contract: live.swap } }] });
    if (req.method === 'POST' && req.url === '/api/quote') {
      const id = (nextId++).toString(16).padStart(24, '0');
      const transfer = view(input, id);
      transfers.set(id, transfer);
      return send(200, quoteLie ? quoteLie({ ...transfer }) : transfer);
    }
    const match = req.url.match(/^\/api\/transfers\/([0-9a-f]{24})(\/sign|\/submit)?$/);
    const transfer = match && transfers.get(match[1]);
    if (!transfer) return send(404, { error: 'Transfer not found.' });
    if (match[2] === '/sign') return send(200, signRequest(transfer));
    if (match[2] === '/submit') {
      submitted.push({ id: match[1], signatures: input.signatures });
      transfer.status = 'confirmed';
      return send(200, transfer);
    }
    return send(200, transfer);
  });
});

async function main() {
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tools = (options) => Object.fromEntries(createTools({ api: base, evmPrivateKey: agent.privateKey, trustCustomApi: true, ...options }).map((tool) => [tool.name, tool.run]));
  const t = tools({ allowedRecipients: [bob] });
  const quote = (recipient = bob) => t.quote_send({ chain: 'base', token: 'USDC', sender: agent.address, recipient, amount: '20' });
  const refused = async (run, pattern, label) => {
    const before = submitted.length;
    await assert.rejects(run, pattern, label);
    assert.strictEqual(submitted.length, before, `${label}: nothing submitted`);
    console.log(`ok: ${label}`);
  };
  const withLie = async (change, run) => { lie = change; try { return await run(); } finally { lie = null; } };

  // Honest: signed once, by the agent, for exactly the quoted order.
  let q = await quote();
  const done = await t.sign_and_submit({ transferId: q.transfer.id });
  assert.strictEqual(done.transfer.status, 'confirmed');
  assert.strictEqual(submitted.length, 1);
  const step = lastRequest.steps[0].typedData;
  assert.strictEqual(ethers.verifyTypedData(step.domain, { ReceiveWithAuthorization: TYPES.ReceiveWithAuthorization }, step.message, submitted[0].signatures[0]), agent.address);
  console.log('ok: honest quote is signed by the agent and submitted');

  // The signing request changes the recipient, consistently in every field: not what the user was shown.
  q = await quote();
  await refused(withLie((r) => { r.transfer.recipient = attacker; r.binding.message.recipient = attacker; }, () => t.sign_and_submit({ transferId: q.transfer.id })), /recipient differs from the quote you were shown/, 'recipient swapped behind the quote');

  // The same with the amount and the fee.
  q = await quote();
  await refused(withLie((r) => { r.transfer.amount = '900'; r.binding.message.amount = ethers.parseUnits('900', 6).toString(); }, () => t.sign_and_submit({ transferId: q.transfer.id })), /amount or fee differs/, 'amount raised behind the quote');

  // The old gap: a swap in one answer, a send in the other. There is only one answer now, and it must match the quote.
  q = await quote();
  await refused(withLie((r) => { r.transfer.swap = { tokenOut: 'ETH', out: '0.01', minOut: '0.009' }; }, () => t.sign_and_submit({ transferId: q.transfer.id })), /Refused to sign/, 'swap and send mixed');

  // Allowed recipients.
  q = await quote(dave);
  await refused(t.sign_and_submit({ transferId: q.transfer.id }), /ALLOWED_RECIPIENTS/, 'recipient outside the allowed list');

  // The order names another token than the one whose authorization is signed.
  q = await quote();
  await refused(withLie((r) => { r.binding.message.token = OTHER_TOKEN; }, () => t.sign_and_submit({ transferId: q.transfer.id })), /another token/, 'order for another token');

  // Typed data with an extra field, or a deadline far in the future.
  q = await quote();
  await refused(withLie((r) => { r.binding.types.Transfer = [...TYPES.Transfer, { name: 'extra', type: 'uint256' }]; r.binding.message.extra = '1'; }, () => t.sign_and_submit({ transferId: q.transfer.id })), /unknown layout/, 'order with a changed layout');
  q = await quote();
  await refused(withLie((r) => { r.binding.message.deadline = String(Math.floor(Date.now() / 1000) + 365 * 86400); }, () => t.sign_and_submit({ transferId: q.transfer.id })), /valid too long/, 'order valid for a year');

  // An extra signature slipped in.
  q = await quote();
  await refused(withLie((r) => { r.afterSteps = (request) => { request.steps.push(request.steps[0]); }; }, () => t.sign_and_submit({ transferId: q.transfer.id })), /unexpected signatures/, 'extra signature');

  // A quote this process never made.
  const foreignId = (nextId++).toString(16).padStart(24, '0');
  transfers.set(foreignId, view({ sender: agent.address, recipient: bob, amount: '20' }, foreignId));
  await refused(t.sign_and_submit({ transferId: foreignId }), /not made with quote_send or quote_swap in this session/, 'quote from elsewhere');

  // A quote that answers something other than what was asked is not shown at all.
  quoteLie = (transfer) => ({ ...transfer, recipient: attacker });
  await assert.rejects(quote(), /differs from the request/);
  quoteLie = null;
  console.log('ok: quote for another recipient is refused');

  // Another API than gasrescue.io without GASRESCUE_TRUST_CUSTOM_API.
  const strict = tools({ trustCustomApi: false });
  await strict.quote_send({ chain: 'base', token: 'USDC', sender: agent.address, recipient: bob, amount: '20' });
  await refused(strict.sign_and_submit({ transferId: (nextId - 1).toString(16).padStart(24, '0') }), /GASRESCUE_TRUST_CUSTOM_API/, 'custom API without opt-in');
  for (const [url, expected] of [['https://gasrescue.io', true], ['https://gasrescue.io/', true], ['http://gasrescue.io', false], ['https://www.gasrescue.io', false], ['https://gasrescue.io.evil.example', false], ['https://gasrescue.io:8443', false], ['https://gasrescue.io/api', false]]) {
    assert.strictEqual(isLiveApi(url), expected, url);
  }
  console.log('ok: only https://gasrescue.io counts as the live API');

  // Against gasrescue.io the published token of the chain is required, even when every field agrees.
  const request = signRequest(transfers.get(q.transfer.id));
  const forged = JSON.parse(JSON.stringify(request));
  forged.binding.message.token = OTHER_TOKEN;
  forged.steps[0].typedData.domain.verifyingContract = OTHER_TOKEN;
  forged.steps[0].typedData.message.nonce = ethers.TypedDataEncoder.hash(forged.binding.domain, { Transfer: TYPES.Transfer }, forged.binding.message);
  const check = (r) => verifyEvm({ transfer: r.transfer, request: r, account: agent.address, contracts: [RELAY], chain: live });
  check(request);
  assert.throws(() => check(forged), /another token/);
  assert.throws(() => verifyEvm({ transfer: request.transfer, request, account: agent.address, contracts: [live.swap], chain: live }), /not a gasrescue contract/);
  console.log('ok: live check requires the published token and the right contract');
}

main().then(() => { server.close(); console.log('ok: sign_and_submit refuses every changed request'); }, (error) => { server.close(); console.error(error); process.exit(1); });

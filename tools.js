// The gasrescue tools for AI agents: check a wallet, quote a send or a swap without gas, and hand over
// what the wallet has to sign. With GASRESCUE_EVM_PRIVATE_KEY set it can also sign EVM quotes itself,
// after checking every field it signs against the quote. The key never leaves this process.
const { ethers } = require('ethers');

const DEFAULT_API = 'https://gasrescue.io';
// The live gasrescue contracts. Against gasrescue.io nothing is signed for any other contract, whatever
// the API answers.
const LIVE_CONTRACTS = [
  '0x7129604E5295D64ec4b6d247BC2538F2FcC3868d', // GasRelay, all EVM chains
  '0xCcEf1FE03257025f1081A563fEF9B19951186015', // SwapRelay, Base, Ethereum, Robinhood Chain
  '0x43d7CaD4b8F6F65C5f1c113dDCD8B25229aa15D6', // SwapRelay, Arbitrum, HyperEVM
];
// USDC, USDT0 and USDG all have 6 decimals. A token with other decimals fails the checks and is not signed.
const STABLE_DECIMALS = 6;
const FINAL = ['confirmed', 'failed', 'expired'];
const POLL_MS = 3000;
const POLL_LIMIT_MS = 180_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const withoutDomain = ({ EIP712Domain, ...types }) => types;

function client(base) {
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `gasrescue answered HTTP ${response.status}`);
    return json;
  };
  return { get: (route) => call('GET', route), post: (route, body) => call('POST', route, body) };
}

// One line an agent can repeat to its user before anything is signed.
function summary(transfer) {
  if (transfer.swap) return `Swap ${transfer.amount} ${transfer.token} on ${transfer.chainLabel} for about ${transfer.swap.out} ${transfer.swap.tokenOut} (at least ${transfer.swap.minOut}). Fees ${transfer.fee} ${transfer.token} (${transfer.feePercent}%). Status: ${transfer.status}.`;
  return `Send ${transfer.amount} ${transfer.token} on ${transfer.chainLabel} from ${transfer.sender} to ${transfer.recipient}. The recipient gets ${transfer.net} ${transfer.token}; fees ${transfer.fee} ${transfer.token} (${transfer.feePercent}%). Status: ${transfer.status}.`;
}

// Throws unless every signature in the request does exactly what the quote says.
function verifyEvm({ transfer, request, account, contracts }) {
  const fail = (why) => { throw new Error(`Refused to sign: ${why}.`); };
  if (transfer.kind !== 'evm' || !request || request.kind !== 'evm-typed-data') fail('this is not an EVM quote');
  if (transfer.status !== 'quoted') fail(`the transfer is ${transfer.status}`);
  if (!same(transfer.sender, account)) fail('the quote is for another wallet');
  const chainId = Number(transfer.chainId);
  if (Number(request.chainId) !== chainId) fail('the chain does not match the quote');
  if (!contracts.some((contract) => same(contract, transfer.contract))) fail('the contract is not a gasrescue contract');
  const amount = ethers.parseUnits(transfer.amount, STABLE_DECIMALS);
  const fee = ethers.parseUnits(transfer.fee, STABLE_DECIMALS);
  const isSwap = Boolean(transfer.swap);

  // The struct the gasrescue contract executes: sender, amount and fee, and for a send the recipient.
  const checkStruct = ({ domain, message }) => {
    if (Number(domain.chainId) !== chainId || !same(domain.verifyingContract, transfer.contract)) fail('the order is for another chain or contract');
    if (!same(message.sender, account)) fail('the order is for another wallet');
    if (BigInt(message.amount) !== amount || BigInt(message.fee) !== fee) fail('amount or fee differ from the quote');
    if (!isSwap && !same(message.recipient, transfer.recipient)) fail('the recipient differs from the quote');
  };

  if (!Array.isArray(request.steps) || !request.steps.length) fail('there is nothing to sign');
  for (const { typedData } of request.steps) {
    const { domain, primaryType, message } = typedData;
    if (Number(domain.chainId) !== chainId) fail('a signature is for another chain');
    if (primaryType === 'ReceiveWithAuthorization') {
      if (!same(message.from, account) || !same(message.to, transfer.contract) || BigInt(message.value) !== amount) fail('the authorization differs from the quote');
      const { binding } = request;
      if (!binding) fail('the order behind the authorization is missing');
      checkStruct(binding);
      if (message.nonce !== ethers.TypedDataEncoder.hash(binding.domain, withoutDomain(binding.types), binding.message)) fail('the authorization does not bind the quoted order');
    } else if (primaryType === 'Permit') {
      if (!same(message.owner, account) || !same(message.spender, transfer.contract) || BigInt(message.value) !== amount) fail('the permit differs from the quote');
    } else if (primaryType === 'Transfer' && !isSwap) {
      checkStruct(typedData);
    } else {
      fail(`unknown signature type ${primaryType}`);
    }
  }
}

const ADDRESS = { type: 'string', description: 'Wallet address: 0x… for EVM chains, base58 for Solana, T… for Tron.' };
const ID = { type: 'string', description: 'The transfer id from a quote.' };
const AMOUNT = { type: 'string', description: 'Amount of the token, as a decimal string, e.g. "25" or "12.5". Fees come out of it.' };
const CHAIN = { type: 'string', description: 'Chain key from gasrescue_info, e.g. "base", "arbitrum", "ethereum", "hyperevm", "robinhood", "solana", "tron".' };
const TOKEN = { type: 'string', description: 'Stablecoin symbol, e.g. "USDC", "USDT", "USDT0" or "USDG". gasrescue_info lists what each chain supports.' };

function createTools({ api = DEFAULT_API, evmPrivateKey = null, allowedRecipients = [] } = {}) {
  const http = client(api.replace(/\/+$/, ''));
  const signer = evmPrivateKey ? new ethers.Wallet(evmPrivateKey) : null;
  const allowed = allowedRecipients.map((address) => address.trim()).filter(Boolean);
  const live = same(api.replace(/\/+$/, ''), DEFAULT_API);

  // Against gasrescue.io only the contracts above; against a local test server whatever it publishes.
  const trustedContracts = async () => {
    if (live) return LIVE_CONTRACTS;
    const config = await http.get('/api/config');
    return config.chains.flatMap((chain) => [chain.contract, chain.swap && chain.swap.contract]).filter(Boolean);
  };

  const withSummary = (transfer) => ({ summary: summary(transfer), transfer });

  const waitForResult = async (id) => {
    const until = Date.now() + POLL_LIMIT_MS;
    let transfer = await http.get(`/api/transfers/${id}`);
    while (!FINAL.includes(transfer.status) && Date.now() < until) {
      await sleep(POLL_MS);
      transfer = await http.get(`/api/transfers/${id}`);
    }
    return transfer;
  };

  const tools = [
    {
      name: 'gasrescue_info',
      description: 'What gasrescue supports: chains, stablecoins per chain, which chains can swap into the gas coin, fees and limits. gasrescue moves stablecoins from a wallet that has no gas: the wallet signs, gasrescue pays the network fee, and its fees come out of the amount.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const config = await http.get('/api/config');
        return {
          network: config.network,
          fees: config.fees,
          limits: config.limits,
          swapSlippagePercent: config.swapSlippagePercent,
          chains: config.chains.map((chain) => ({
            key: chain.key, label: chain.label, kind: chain.kind, gasCoin: chain.native, tokens: chain.tokens, swap: chain.swap ? { sell: chain.swap.tokens, buy: chain.swap.out } : null, contract: chain.contract,
          })),
          signsLocally: signer ? { evmAddress: signer.address } : null,
        };
      },
    },
    {
      name: 'check_wallet',
      description: 'Read-only check of one address on every supported chain: which stablecoins it holds, whether it has gas to move them, and whether a token is frozen by its issuer. Nothing is signed or stored.',
      inputSchema: { type: 'object', properties: { address: ADDRESS }, required: ['address'], additionalProperties: false },
      run: ({ address }) => http.post('/api/wallet-check', { address }),
    },
    {
      name: 'quote_send',
      description: 'Quote sending a stablecoin from a wallet without gas. Returns the fees, what the recipient gets and a transfer id. A quote is free and valid for 10 minutes; nothing moves until it is signed. Show the summary to the user before signing.',
      inputSchema: {
        type: 'object',
        properties: { chain: CHAIN, token: TOKEN, sender: ADDRESS, recipient: ADDRESS, amount: AMOUNT },
        required: ['chain', 'token', 'sender', 'recipient', 'amount'],
        additionalProperties: false,
      },
      run: async (input) => withSummary(await http.post('/api/quote', input)),
    },
    {
      name: 'quote_swap',
      description: 'Quote swapping a stablecoin into the chain\'s gas coin (or another stablecoin) from a wallet without gas. The result goes back to the same wallet. Valid for 2 minutes. Not available on Tron.',
      inputSchema: {
        type: 'object',
        properties: { chain: CHAIN, token: TOKEN, tokenOut: { type: 'string', description: 'What to get, e.g. "ETH", "SOL", "HYPE" or another stablecoin.' }, sender: ADDRESS, amount: AMOUNT },
        required: ['chain', 'token', 'tokenOut', 'sender', 'amount'],
        additionalProperties: false,
      },
      run: async (input) => withSummary(await http.post('/api/swap-quote', input)),
    },
    {
      name: 'get_signing_request',
      description: 'What the wallet has to sign for a quote. EVM: EIP-712 typed data per step (sign each with eth_signTypedData_v4, in order). Tron: transactions whose txID the wallet signs. Solana: a base64 transaction the wallet signs. Then call submit_signatures.',
      inputSchema: { type: 'object', properties: { transferId: ID }, required: ['transferId'], additionalProperties: false },
      run: ({ transferId }) => http.get(`/api/transfers/${transferId}/sign`),
    },
    {
      name: 'submit_signatures',
      description: 'Submit the signatures for a quote. gasrescue sends the transaction, pays the gas and returns the result with an explorer link. EVM and Tron: signatures, one per step. Solana: signedTransaction, base64.',
      inputSchema: {
        type: 'object',
        properties: { transferId: ID, signatures: { type: 'array', items: { type: 'string' } }, signedTransaction: { type: 'string' } },
        required: ['transferId'],
        additionalProperties: false,
      },
      run: async ({ transferId, signatures, signedTransaction }) => {
        const payload = signedTransaction ? { signedTransaction } : { signatures };
        await http.post(`/api/transfers/${transferId}/submit`, payload);
        return withSummary(await waitForResult(transferId));
      },
    },
    {
      name: 'get_transfer',
      description: 'Status of a quote or transfer: quoted, submitting, sent, confirmed, failed or expired, with the explorer link once sent.',
      inputSchema: { type: 'object', properties: { transferId: ID }, required: ['transferId'], additionalProperties: false },
      run: async ({ transferId }) => withSummary(await http.get(`/api/transfers/${transferId}`)),
    },
  ];

  if (signer) {
    tools.push({
      name: 'sign_and_submit',
      description: `Sign an EVM quote with this server's own wallet ${signer.address} and submit it. Every field is checked against the quote first: wallet, chain, gasrescue contract, amount, fee and recipient. Get the user's approval of the quote summary before calling this; transfers are final.${allowed.length ? ' Sends go only to the configured allowed recipients.' : ''}`,
      inputSchema: { type: 'object', properties: { transferId: ID }, required: ['transferId'], additionalProperties: false },
      run: async ({ transferId }) => {
        const transfer = await http.get(`/api/transfers/${transferId}`);
        if (allowed.length && !transfer.swap && !allowed.some((address) => same(address, transfer.recipient))) throw new Error('Refused to sign: the recipient is not in GASRESCUE_ALLOWED_RECIPIENTS.');
        const request = await http.get(`/api/transfers/${transferId}/sign`);
        verifyEvm({ transfer: request.transfer, request, account: signer.address, contracts: await trustedContracts() });
        const signatures = [];
        for (const { typedData } of request.steps) signatures.push(await signer.signTypedData(typedData.domain, withoutDomain(typedData.types), typedData.message));
        await http.post(`/api/transfers/${transferId}/submit`, { signatures });
        return withSummary(await waitForResult(transferId));
      },
    });
  }
  return tools;
}

module.exports = { createTools, verifyEvm, summary, LIVE_CONTRACTS, DEFAULT_API };

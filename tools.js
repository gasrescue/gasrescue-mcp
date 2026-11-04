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
  '0xbE72cf7ECBeFf0CFE4E56B51f468Ad8C857F7FeA', // SwapRelay2, Polygon
];
// USDC, USDC.e, USDT0 and USDG all have 6 decimals. A token with other decimals fails the checks and is not signed.
const STABLE_DECIMALS = 6;
const FINAL = ['confirmed', 'failed', 'expired'];
const POLL_MS = 3000;
const POLL_LIMIT_MS = 180_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const withoutDomain = ({ EIP712Domain, ...types }) => types;
// Some tokens (USDT0 and USDC.e on Polygon) put the chain id into their domain as a salt instead.
const domainChainId = (domain) => (domain.chainId != null ? Number(domain.chainId) : domain.salt != null ? Number(BigInt(domain.salt)) : NaN);

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
  if (request && request.kind === 'evm-transactions') fail('on this chain the wallet sends two plain transfers itself (gas drop); use get_signing_request and submit_signatures');
  if (transfer.kind !== 'evm' || !request || request.kind !== 'evm-typed-data') fail('this is not an EVM quote');
  if (transfer.status !== 'quoted') fail(`the transfer is ${transfer.status}`);
  if (!same(transfer.sender, account)) fail('the quote is for another wallet');
  const chainId = Number(transfer.chainId);
  if (Number(request.chainId) !== chainId) fail('the chain does not match the quote');
  if (!contracts.some((contract) => same(contract, transfer.contract))) fail('the contract is not a gasrescue contract');
  const amount = ethers.parseUnits(transfer.amount, STABLE_DECIMALS);
  const fee = ethers.parseUnits(transfer.fee, STABLE_DECIMALS);
  const isSwap = Boolean(transfer.swap);

  // The struct the gasrescue contract executes: sender, amount and fee, for a send the recipient, for a
  // swap the minimum output the quote showed (the gas coin has 18 decimals, a stablecoin 6).
  const checkStruct = ({ domain, message }) => {
    if (Number(domain.chainId) !== chainId || !same(domain.verifyingContract, transfer.contract)) fail('the order is for another chain or contract');
    if (!same(message.sender, account)) fail('the order is for another wallet');
    if (BigInt(message.amount) !== amount || BigInt(message.fee) !== fee) fail('amount or fee differ from the quote');
    if (!isSwap && !same(message.recipient, transfer.recipient)) fail('the recipient differs from the quote');
    if (isSwap && ![18, STABLE_DECIMALS].some((decimals) => ethers.formatUnits(BigInt(message.minOut), decimals) === transfer.swap.minOut)) fail('the minimum output differs from the quote');
  };

  if (!Array.isArray(request.steps) || !request.steps.length) fail('there is nothing to sign');
  for (const { typedData } of request.steps) {
    const { domain, primaryType, message } = typedData;
    if (domainChainId(domain) !== chainId) fail('a signature is for another chain');
    if (primaryType === 'ReceiveWithAuthorization') {
      if (!same(message.from, account) || !same(message.to, transfer.contract) || BigInt(message.value) !== amount) fail('the authorization differs from the quote');
      const { binding } = request;
      if (!binding) fail('the order behind the authorization is missing');
      checkStruct(binding);
      if (message.nonce !== ethers.TypedDataEncoder.hash(binding.domain, withoutDomain(binding.types), binding.message)) fail('the authorization does not bind the quoted order');
    } else if (primaryType === 'Permit') {
      if (!same(message.owner, account) || !same(message.spender, transfer.contract) || BigInt(message.value) !== amount) fail('the permit differs from the quote');
    } else if ((primaryType === 'Transfer' && !isSwap) || (primaryType === 'Swap' && isSwap)) {
      checkStruct(typedData);
    } else {
      fail(`unknown signature type ${primaryType}`);
    }
  }
}

const ADDRESS = { type: 'string', description: 'Wallet address: 0x… for EVM chains, base58 for Solana, T… for Tron.' };
const ID = {
  type: 'string',
  pattern: '^[0-9a-f]{24}$',
  description: 'The id gasrescue returned as transfer.id from quote_send or quote_swap: 24 lowercase hex characters, e.g. "b39f46001a5680455091152d". Not a transaction hash and not an id of another service.',
};
const AMOUNT = { type: 'string', description: 'Amount of the token, as a decimal string, e.g. "25" or "12.5". Fees come out of it.' };
const CHAIN = { type: 'string', description: 'Chain key from gasrescue_info, e.g. "base", "arbitrum", "ethereum", "polygon", "bsc", "hyperevm", "robinhood", "solana", "tron".' };
const TOKEN = { type: 'string', description: 'Stablecoin symbol, e.g. "USDC", "USDC.e", "USDT", "USDT0", "USDG", "USD1" or "FDUSD". gasrescue_info lists what each chain supports.' };

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
  // The API answers a malformed id with a bare 404; the agent gets the same message as for an unknown one.
  const idOf = (transferId) => {
    if (!/^[0-9a-f]{24}$/.test(String(transferId))) throw new Error('Transfer not found. The id must be the 24 hex characters returned as transfer.id by quote_send or quote_swap.');
    return transferId;
  };

  const waitForResult = async (id) => {
    const until = Date.now() + POLL_LIMIT_MS;
    let transfer = await http.get(`/api/transfers/${id}`);
    while (!FINAL.includes(transfer.status) && Date.now() < until) {
      await sleep(POLL_MS);
      transfer = await http.get(`/api/transfers/${id}`);
    }
    return transfer;
  };

  // Annotations as defined by MCP: what a client may assume about a tool before calling it.
  const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const QUOTES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const MOVES_FUNDS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

  const tools = [
    {
      name: 'gasrescue_info',
      title: 'Supported chains, tokens and fees',
      annotations: READS,
      description: 'Lists what gasrescue supports: the chains, the stablecoins on each, which chains can swap into their gas coin, the fees and the limits. '
        + 'Use gasrescue when a wallet holds USDC, USDT or USDG but no ETH, POL, BNB, SOL, TRX or HYPE for the network fee ("insufficient funds for gas"). '
        + 'Call this first to get the chain keys and token symbols the other tools expect. Read-only, takes no input. '
        + 'Returns network, fees (service percent, minimum, maximum), limits (USD per transfer, transfers per wallet per day, quote validity) and the chains with their tokens and gas coin. '
        + 'gasDrop: true marks a chain without a gasrescue contract (BNB Chain): there gasrescue sends the wallet a little gas and the wallet sends two plain transfers itself.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const config = await http.get('/api/config');
        return {
          network: config.network,
          fees: config.fees,
          limits: config.limits,
          swapSlippagePercent: config.swapSlippagePercent,
          chains: config.chains.map((chain) => ({
            key: chain.key, label: chain.label, kind: chain.kind, gasDrop: Boolean(chain.gasDrop), gasCoin: chain.native, tokens: chain.tokens, swap: chain.swap ? { sell: chain.swap.tokens, buy: chain.swap.out } : null, contract: chain.contract,
          })),
          signsLocally: signer ? { evmAddress: signer.address } : null,
        };
      },
    },
    {
      name: 'check_wallet',
      title: 'Check a wallet for stuck stablecoins',
      annotations: READS,
      description: 'Checks one address on every supported chain where it is valid: which stablecoins it holds, its gas balance, whether the stablecoins are stuck (not enough gas to move them) and whether a token is frozen by its issuer. '
        + 'Use it before quote_send or quote_swap to find the chain and token to rescue. A frozen token cannot be moved by any tool here; only the issuer can lift that. '
        + 'Read-only: nothing is signed, sent or stored. '
        + 'Returns { address, chains: [{ key, label, native, tokens: [{ symbol, balance, frozen }], gas, stuck, frozen, canSwap }] }; a chain that did not answer has error: true.',
      inputSchema: { type: 'object', properties: { address: ADDRESS }, required: ['address'], additionalProperties: false },
      run: ({ address }) => http.post('/api/wallet-check', { address }),
    },
    {
      name: 'quote_send',
      title: 'Quote a send without gas',
      annotations: QUOTES,
      description: 'Prices sending USDC, USDT or USDG from a wallet without gas (no ETH, POL, BNB, SOL or TRX) to another address, e.g. an exchange deposit or another wallet. '
        + 'Use quote_swap instead when the user wants gas in the same wallet. '
        + 'Creates a free quote, valid for 10 minutes; nothing moves on chain until the wallet signs it. '
        + 'Returns { summary, transfer }: the transfer id, network and service fee, what the recipient gets (net) and status "quoted". Show the summary to the user and get approval before signing. '
        + 'Fails with a readable error when the amount is outside $2 to $1,000 (Tron: from $10), the wallet holds too little, the token is frozen, or the wallet sent 10 transfers in 24 hours.',
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
      title: 'Quote a swap into gas without gas',
      annotations: QUOTES,
      description: 'Prices swapping a stablecoin into the chain\'s gas coin (ETH, POL, SOL, HYPE) or another stablecoin, for a wallet without gas, so it can pay its own fees again. '
        + 'The result always goes back to the same wallet; use quote_send to pay someone else. Not available on Tron. '
        + 'Creates a free quote, valid for 2 minutes because prices move; nothing moves on chain until the wallet signs it. '
        + 'Returns { summary, transfer } with the transfer id, fees, the expected output and the minimum output (below it the swap reverts and nothing moves). Show the summary to the user and get approval before signing.',
      inputSchema: {
        type: 'object',
        properties: { chain: CHAIN, token: TOKEN, tokenOut: { type: 'string', description: 'What to get: the gas coin ("ETH", "POL", "SOL", "HYPE") or another stablecoin. gasrescue_info lists what each chain can buy.' }, sender: ADDRESS, amount: AMOUNT },
        required: ['chain', 'token', 'tokenOut', 'sender', 'amount'],
        additionalProperties: false,
      },
      run: async (input) => withSummary(await http.post('/api/swap-quote', input)),
    },
    {
      name: 'get_signing_request',
      title: 'Get what the wallet must sign',
      annotations: READS,
      description: 'Returns what the sender\'s wallet has to sign for a quote from quote_send or quote_swap. '
        + 'kind "evm-typed-data": sign every steps[].typedData with eth_signTypedData_v4, in order (one authorization, or for permit tokens a permit plus the order itself); binding is the order the authorization commits to, so recipient, fee and minimum can be checked first. '
        + 'kind "tron-transactions": sign every steps[].transaction (first the fee, then the transfer). '
        + 'kind "evm-transactions" (gas drop, BNB Chain): if funding.needed, call submit_signatures with fund: true first, so gasrescue sends the wallet the gas; then send every steps[].tx from the wallet (eth_sendTransaction, fee first) and report the hashes with submit_signatures txs: { fee, transfer }. '
        + 'kind "solana-transaction" or "solana-versioned-transaction": sign the base64 transaction. '
        + 'Read-only. Pass the result to submit_signatures. Fails when the quote expired; then request a new quote.',
      inputSchema: { type: 'object', properties: { transferId: ID }, required: ['transferId'], additionalProperties: false },
      run: async ({ transferId }) => http.get(`/api/transfers/${idOf(transferId)}/sign`),
    },
    {
      name: 'submit_signatures',
      title: 'Submit signatures and send',
      annotations: MOVES_FUNDS,
      description: 'Submits the wallet\'s signatures for a quote; gasrescue broadcasts the transaction, pays the gas and waits up to 3 minutes for the result. '
        + 'This moves funds and cannot be undone: call it only after the user approved the quote summary. A transfer can be submitted once; a second call is refused. '
        + 'Give signatures for EVM and Tron, signedTransaction for Solana, or for a gas drop fund: true and then txs. '
        + 'Returns { summary, transfer } with status confirmed or failed, the transaction hash and the explorer link.',
      inputSchema: {
        type: 'object',
        properties: {
          transferId: ID,
          signatures: { type: 'array', items: { type: 'string' }, description: 'EVM and Tron: one signature per step of get_signing_request, in the same order, as hex strings.' },
          signedTransaction: { type: 'string', description: 'Solana only: the transaction from get_signing_request, signed by the sender, base64.' },
          fund: { type: 'boolean', description: 'Gas drop (kind "evm-transactions") only: true asks gasrescue to send the wallet the gas for its two transfers. Returns status funded.' },
          txs: {
            type: 'object',
            properties: { fee: { type: 'string' }, transfer: { type: 'string' } },
            additionalProperties: false,
            description: 'Gas drop only: the hashes of the transactions the wallet sent, { fee, transfer }. gasrescue checks them on chain; the transfer closes the quote.',
          },
        },
        required: ['transferId'],
        additionalProperties: false,
      },
      run: async ({ transferId, signatures, signedTransaction, fund, txs }) => {
        // A gas drop answers right away: after the gas the wallet still has to send its transfers.
        if (fund || txs) return withSummary(await http.post(`/api/transfers/${idOf(transferId)}/submit`, fund ? { fund: true } : { txs }));
        const payload = signedTransaction ? { signedTransaction } : { signatures };
        await http.post(`/api/transfers/${idOf(transferId)}/submit`, payload);
        return withSummary(await waitForResult(transferId));
      },
    },
    {
      name: 'get_transfer',
      title: 'Transfer status',
      annotations: READS,
      description: 'Returns the current state of a quote or transfer by its id, with the fees, the transaction hash and the explorer link once sent. '
        + 'States: quoted (waiting for the signature), submitting and sent (on its way; ask again after a few seconds), confirmed (done), failed (error says why) and expired (not signed in time; request a new quote). '
        + 'Use it to follow up after submit_signatures or to see whether a quote is still open. It cannot start, change or cancel anything; use quote_send or quote_swap to start. '
        + 'Read-only. Returns { summary, transfer }. An unknown or malformed id, or one older than 30 days, fails with "Transfer not found".',
      inputSchema: { type: 'object', properties: { transferId: ID }, required: ['transferId'], additionalProperties: false },
      run: async ({ transferId }) => withSummary(await http.get(`/api/transfers/${idOf(transferId)}`)),
    },
  ];

  if (signer) {
    tools.push({
      name: 'sign_and_submit',
      title: 'Sign with this server\'s wallet and send',
      annotations: MOVES_FUNDS,
      description: `Signs an EVM quote with this server's own wallet ${signer.address} and submits it, instead of get_signing_request plus submit_signatures. `
        + 'Before signing it checks every field against the quote: wallet, chain, gasrescue contract, amount, fee and recipient, and refuses anything else. '
        + `This moves funds and cannot be undone: get the user's approval of the quote summary first.${allowed.length ? ' Sends go only to the configured allowed recipients.' : ''} `
        + 'Returns { summary, transfer } with status confirmed or failed and the explorer link.',
      inputSchema: { type: 'object', properties: { transferId: ID }, required: ['transferId'], additionalProperties: false },
      run: async ({ transferId }) => {
        const transfer = await http.get(`/api/transfers/${idOf(transferId)}`);
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

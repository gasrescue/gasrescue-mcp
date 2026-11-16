// The gasrescue tools for AI agents: check a wallet, quote a send or a swap without gas, and hand over
// what the wallet has to sign. With GASRESCUE_EVM_PRIVATE_KEY set it can also sign EVM quotes itself.
// The API is not trusted for that: sign_and_submit signs only a quote this process asked for and showed,
// unchanged (wallet, recipient, chain, token, amount, fee, minimum output), for the published gasrescue
// contract and token of that chain, in the exact typed-data layout the contracts use, with a short
// deadline. The key never leaves this process.
const { ethers } = require('ethers');

const DEFAULT_API = 'https://gasrescue.io';
const GAS_RELAY = '0x7129604E5295D64ec4b6d247BC2538F2FcC3868d'; // GasRelay, all EVM chains
const SWAP_RELAY_A = '0xCcEf1FE03257025f1081A563fEF9B19951186015'; // SwapRelay, Base, Ethereum, Robinhood Chain
const SWAP_RELAY_B = '0x43d7CaD4b8F6F65C5f1c113dDCD8B25229aa15D6'; // SwapRelay, Arbitrum, HyperEVM; SwapRelay2, Avalanche
const SWAP_RELAY_POLYGON = '0xbE72cf7ECBeFf0CFE4E56B51f468Ad8C857F7FeA'; // SwapRelay2, Polygon
// The live chains by chain id: the gasrescue contracts, the stablecoins and the wrapped gas coin a swap into
// the gas coin pays out through. Against gasrescue.io nothing else is signed, whatever the API answers. A new
// chain, token or contract must be added here before the MCP server signs for it.
const LIVE_CHAINS = {
  1: { relay: GAS_RELAY, swap: SWAP_RELAY_A, native: 'ETH', wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', tokens: { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } },
  137: {
    relay: GAS_RELAY,
    swap: SWAP_RELAY_POLYGON,
    native: 'POL',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    tokens: { USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', USDT0: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDC.e': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
  },
  999: { relay: GAS_RELAY, swap: SWAP_RELAY_B, native: 'HYPE', wrappedNative: '0x5555555555555555555555555555555555555555', tokens: { USDC: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', USDT0: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb' } },
  4663: { relay: GAS_RELAY, swap: SWAP_RELAY_A, native: 'ETH', wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', tokens: { USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' } },
  8453: { relay: GAS_RELAY, swap: SWAP_RELAY_A, native: 'ETH', wrappedNative: '0x4200000000000000000000000000000000000006', tokens: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } },
  42161: { relay: GAS_RELAY, swap: SWAP_RELAY_B, native: 'ETH', wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', tokens: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', USDT0: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' } },
  43114: { relay: GAS_RELAY, swap: SWAP_RELAY_B, native: 'AVAX', wrappedNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', tokens: { USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' } },
};
const LIVE_CONTRACTS = [...new Set(Object.values(LIVE_CHAINS).flatMap((chain) => [chain.relay, chain.swap]))];
// USDC, USDC.e, USDT, USDT0 and USDG all have 6 decimals. A token with other decimals fails the checks and is not signed.
const STABLE_DECIMALS = 6;
// The quotes live 10 minutes (a swap 2), and the signatures expire with them. A signature that would stay
// valid longer than this is refused.
const MAX_SIGNATURE_SECONDS = 3600;
const FINAL = ['confirmed', 'failed', 'expired'];
const POLL_MS = 3000;
const POLL_LIMIT_MS = 180_000;
const QUOTES_KEPT = 200;

// The typed data the gasrescue contracts and the tokens verify, field by field. Anything else is not signed.
const address = (name) => ({ name, type: 'address' });
const uint = (name) => ({ name, type: 'uint256' });
const TYPES = {
  Transfer: [address('sender'), address('recipient'), address('token'), uint('amount'), uint('fee'), uint('deadline'), { name: 'salt', type: 'bytes32' }],
  Swap: [address('sender'), address('tokenIn'), address('tokenOut'), { name: 'poolFee', type: 'uint24' }, uint('amount'), uint('fee'), uint('minOut'), uint('deadline'), { name: 'salt', type: 'bytes32' }],
  ReceiveWithAuthorization: [address('from'), address('to'), uint('value'), uint('validAfter'), uint('validBefore'), { name: 'nonce', type: 'bytes32' }],
  Permit: [address('owner'), address('spender'), uint('value'), uint('nonce'), uint('deadline')],
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const withoutDomain = ({ EIP712Domain, ...types }) => types;
// Some tokens (USDT0 and USDC.e on Polygon, not USDT on Avalanche) put the chain id into their domain as a salt instead.
const domainChainId = (domain) => (domain.chainId != null ? Number(domain.chainId) : domain.salt != null ? Number(BigInt(domain.salt)) : NaN);
// True when types hold exactly the layout of primaryType and nothing else.
const exactTypes = (types, primaryType) => {
  try {
    const own = withoutDomain(types || {});
    const fields = (own[primaryType] || []).map(({ name, type }) => `${name}:${type}`).join();
    return Object.keys(own).length === 1 && fields === TYPES[primaryType].map(({ name, type }) => `${name}:${type}`).join();
  } catch {
    return false;
  }
};
const units = (value) => {
  try {
    return ethers.parseUnits(String(value), STABLE_DECIMALS);
  } catch {
    return null;
  }
};
// Is the API answering for gasrescue.io itself, over https?
const isLiveApi = (api) => {
  try {
    const url = new URL(api);
    return url.protocol === 'https:' && url.hostname === 'gasrescue.io' && !url.port && (url.pathname === '/' || url.pathname === '') && !url.search;
  } catch {
    return false;
  }
};

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

// Throws unless every signature in the request does exactly what the transfer says. chain, when given,
// holds the published token addresses of that chain (LIVE_CHAINS); without it the token of the orders must
// at least be the token whose permit or authorization is signed.
function verifyEvm({ transfer, request, account, contracts, chain = null, now = Date.now() }) {
  const fail = (why) => { throw new Error(`Refused to sign: ${why}.`); };
  if (request && request.kind === 'evm-transactions') fail('on this chain the wallet sends two plain transfers itself (gas drop); use get_signing_request and submit_signatures');
  if (!transfer || transfer.kind !== 'evm' || !request || request.kind !== 'evm-typed-data') fail('this is not an EVM quote');
  if (transfer.status !== 'quoted') fail(`the transfer is ${transfer.status}`);
  if (!same(transfer.sender, account)) fail('the quote is for another wallet');
  const chainId = Number(transfer.chainId);
  if (Number(request.chainId) !== chainId) fail('the chain does not match the quote');
  if (!contracts.some((contract) => same(contract, transfer.contract))) fail('the contract is not a gasrescue contract');
  const amount = units(transfer.amount);
  const fee = units(transfer.fee);
  if (amount == null || fee == null || fee >= amount) fail('amount or fee are not valid');
  const isSwap = Boolean(transfer.swap);
  const structType = isSwap ? 'Swap' : 'Transfer';

  // The token: the published one, or else the one of the first token signature, which every other must match.
  let token = null;
  let tokenOut = null;
  if (chain) {
    token = chain.tokens[transfer.token];
    if (!token) fail('the token is not a gasrescue token on this chain');
    if (isSwap) {
      tokenOut = transfer.swap.tokenOut === chain.native ? chain.wrappedNative : chain.tokens[transfer.swap.tokenOut];
      if (!tokenOut) fail('the swap output is not a gasrescue token on this chain');
    }
  }
  const sameToken = (candidate) => {
    if (!token && typeof candidate === 'string' && ethers.isAddress(candidate)) token = candidate;
    return same(candidate, token);
  };
  const latest = BigInt(Math.floor(now / 1000) + MAX_SIGNATURE_SECONDS);
  const inTime = (deadline) => {
    try {
      const value = BigInt(deadline);
      return value > 0n && value <= latest;
    } catch {
      return false;
    }
  };

  // The struct the gasrescue contract executes: sender, token, amount and fee, for a send the recipient, for
  // a swap the output token and the minimum output the quote showed (the gas coin has 18 decimals, a stablecoin 6).
  const checkStruct = ({ domain, types, primaryType, message }) => {
    if (primaryType !== structType || !exactTypes(types, structType)) fail('the order has an unknown layout');
    if (Number(domain.chainId) !== chainId || !same(domain.verifyingContract, transfer.contract)) fail('the order is for another chain or contract');
    if (!same(message.sender, account)) fail('the order is for another wallet');
    if (BigInt(message.amount) !== amount || BigInt(message.fee) !== fee) fail('amount or fee differ from the quote');
    if (!inTime(message.deadline)) fail('the order stays valid too long');
    if (!isSwap) {
      if (!sameToken(message.token)) fail('the order is for another token');
      if (!same(message.recipient, transfer.recipient)) fail('the recipient differs from the quote');
    } else {
      if (!sameToken(message.tokenIn)) fail('the order is for another token');
      if (tokenOut ? !same(message.tokenOut, tokenOut) : same(message.tokenOut, message.tokenIn)) fail('the swap output differs from the quote');
      if (![18, STABLE_DECIMALS].some((decimals) => ethers.formatUnits(BigInt(message.minOut), decimals) === transfer.swap.minOut)) fail('the minimum output differs from the quote');
    }
  };
  // The token signature: for this token, from this wallet, to the gasrescue contract, for exactly the amount.
  const checkToken = ({ domain, types, primaryType }) => {
    if (!exactTypes(types, primaryType)) fail('a token signature has an unknown layout');
    if (!sameToken(domain.verifyingContract)) fail('a token signature is for another token');
  };

  const steps = Array.isArray(request.steps) ? request.steps.map((step) => step && step.typedData) : [];
  const kinds = steps.map((typedData) => typedData && typedData.primaryType).join();
  // An authorization alone (it binds the order through its nonce), or a permit followed by the order.
  if (kinds !== 'ReceiveWithAuthorization' && kinds !== `Permit,${structType}`) fail(kinds ? `unexpected signatures ${kinds}` : 'there is nothing to sign');
  for (const typedData of steps) {
    const { domain, primaryType, message } = typedData;
    if (!domain || !message) fail('a signature is incomplete');
    if (domainChainId(domain) !== chainId) fail('a signature is for another chain');
    if (primaryType === 'ReceiveWithAuthorization') {
      checkToken(typedData);
      if (!same(message.from, account) || !same(message.to, transfer.contract) || BigInt(message.value) !== amount) fail('the authorization differs from the quote');
      if (BigInt(message.validAfter) > BigInt(Math.floor(now / 1000)) || !inTime(message.validBefore)) fail('the authorization stays valid too long');
      const { binding } = request;
      if (!binding) fail('the order behind the authorization is missing');
      checkStruct(binding);
      if (message.nonce !== ethers.TypedDataEncoder.hash(binding.domain, withoutDomain(binding.types), binding.message)) fail('the authorization does not bind the quoted order');
    } else if (primaryType === 'Permit') {
      checkToken(typedData);
      if (!same(message.owner, account) || !same(message.spender, transfer.contract) || BigInt(message.value) !== amount) fail('the permit differs from the quote');
      if (!inTime(message.deadline)) fail('the permit stays valid too long');
    } else {
      checkStruct(typedData);
    }
  }
}

// Throws unless the transfer behind the signing request is still exactly the quote that was shown.
function matchesQuote(quoted, transfer) {
  const fail = (why) => { throw new Error(`Refused to sign: ${why} differs from the quote you were shown. Ask for a new quote.`); };
  if (transfer.id !== quoted.id || !same(transfer.chain, quoted.chain) || Number(transfer.chainId) !== Number(quoted.chainId)) fail('the chain');
  if (!same(transfer.token, quoted.token)) fail('the token');
  if (!same(transfer.sender, quoted.sender)) fail('the wallet');
  if (!same(transfer.recipient, quoted.recipient)) fail('the recipient');
  if (units(transfer.amount) !== units(quoted.amount) || units(transfer.fee) !== units(quoted.fee)) fail('the amount or fee');
  if (!same(transfer.contract, quoted.contract)) fail('the contract');
  if (Boolean(transfer.swap) !== Boolean(quoted.swap)) fail('the kind of order');
  if (quoted.swap && (!same(transfer.swap.tokenOut, quoted.swap.tokenOut) || transfer.swap.minOut !== quoted.swap.minOut)) fail('the swap output');
}

const ADDRESS = { type: 'string', description: 'Wallet address: 0x… for EVM chains, base58 for Solana, T… for Tron.' };
const ID = {
  type: 'string',
  pattern: '^[0-9a-f]{24}$',
  description: 'The id gasrescue returned as transfer.id from quote_send or quote_swap: 24 lowercase hex characters, e.g. "b39f46001a5680455091152d". Not a transaction hash and not an id of another service.',
};
const AMOUNT = { type: 'string', description: 'Amount of the token, as a decimal string, e.g. "25" or "12.5". Fees come out of it.' };
const CHAIN = { type: 'string', description: 'Chain key from gasrescue_info, e.g. "base", "arbitrum", "ethereum", "polygon", "avalanche", "bsc", "hyperevm", "robinhood", "solana", "tron".' };
const TOKEN = { type: 'string', description: 'Stablecoin symbol, e.g. "USDC", "USDC.e", "USDT", "USDT0", "USDG", "USD1" or "FDUSD". gasrescue_info lists what each chain supports.' };

function createTools({ api = DEFAULT_API, evmPrivateKey = null, allowedRecipients = [], trustCustomApi = false } = {}) {
  const http = client(api.replace(/\/+$/, ''));
  const signer = evmPrivateKey ? new ethers.Wallet(evmPrivateKey) : null;
  const allowed = allowedRecipients.map((entry) => entry.trim()).filter(Boolean);
  const live = isLiveApi(api);

  // Against gasrescue.io only the contract of that chain from LIVE_CHAINS. Against another API (your own
  // test server) whatever that server publishes, and only with GASRESCUE_TRUST_CUSTOM_API=1.
  const trusted = async (transfer) => {
    if (live) {
      const chain = LIVE_CHAINS[Number(transfer.chainId)];
      if (!chain) return { contracts: [], chain: null };
      return { contracts: [transfer.swap ? chain.swap : chain.relay], chain };
    }
    const config = await http.get('/api/config');
    return { contracts: config.chains.flatMap((chain) => [chain.contract, chain.swap && chain.swap.contract]).filter(Boolean), chain: null };
  };

  // The quotes this process asked for and showed, by id: sign_and_submit signs nothing else.
  const quotes = new Map();
  const remember = (input, transfer, isSwap) => {
    if (!transfer || typeof transfer.id !== 'string') return;
    // The API must answer the request that was made; a quote for something else is not shown.
    if (signer && transfer.kind === 'evm') {
      const wrong = (what) => { throw new Error(`gasrescue answered with a quote whose ${what} differs from the request. Nothing was signed.`); };
      if (!same(transfer.chain, input.chain)) wrong('chain');
      if (!same(transfer.token, input.token)) wrong('token');
      if (!same(transfer.sender, input.sender)) wrong('wallet');
      if (units(transfer.amount) == null || units(transfer.amount) !== units(input.amount)) wrong('amount');
      if (isSwap ? !transfer.swap || !same(transfer.swap.tokenOut, input.tokenOut) || !same(transfer.recipient, input.sender) : transfer.swap || !same(transfer.recipient, input.recipient)) wrong('recipient or output');
    }
    quotes.set(transfer.id, JSON.parse(JSON.stringify(transfer)));
    while (quotes.size > QUOTES_KEPT) quotes.delete(quotes.keys().next().value);
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
        + 'Use gasrescue when a wallet holds USDC, USDT or USDG but no ETH, POL, AVAX, BNB, SOL, TRX or HYPE for the network fee ("insufficient funds for gas"). '
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
      run: ({ address }) => http.post('/api/wallet-check', { address, ref: 'mcp' }),
    },
    {
      name: 'quote_send',
      title: 'Quote a send without gas',
      annotations: QUOTES,
      description: 'Prices sending USDC, USDT or USDG from a wallet without gas (no ETH, POL, AVAX, BNB, SOL or TRX) to another address, e.g. an exchange deposit or another wallet. '
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
      run: async (input) => {
        const transfer = await http.post('/api/quote', { ...input, ref: 'mcp' });
        remember(input, transfer, false);
        return withSummary(transfer);
      },
    },
    {
      name: 'quote_swap',
      title: 'Quote a swap into gas without gas',
      annotations: QUOTES,
      description: 'Prices swapping a stablecoin into the chain\'s gas coin (ETH, POL, AVAX, SOL, HYPE) or another stablecoin, for a wallet without gas, so it can pay its own fees again. '
        + 'The result always goes back to the same wallet; use quote_send to pay someone else. Not available on Tron. '
        + 'Creates a free quote, valid for 2 minutes because prices move; nothing moves on chain until the wallet signs it. '
        + 'Returns { summary, transfer } with the transfer id, fees, the expected output and the minimum output (below it the swap reverts and nothing moves). Show the summary to the user and get approval before signing.',
      inputSchema: {
        type: 'object',
        properties: { chain: CHAIN, token: TOKEN, tokenOut: { type: 'string', description: 'What to get: the gas coin ("ETH", "POL", "AVAX", "SOL", "HYPE") or another stablecoin. gasrescue_info lists what each chain can buy.' }, sender: ADDRESS, amount: AMOUNT },
        required: ['chain', 'token', 'tokenOut', 'sender', 'amount'],
        additionalProperties: false,
      },
      run: async (input) => {
        const transfer = await http.post('/api/swap-quote', { ...input, ref: 'mcp' });
        remember(input, transfer, true);
        return withSummary(transfer);
      },
    },
    {
      name: 'get_signing_request',
      title: 'Get what the wallet must sign',
      annotations: READS,
      description: 'Returns what the sender\'s wallet has to sign for a quote from quote_send or quote_swap. '
        + 'kind "evm-typed-data": sign every steps[].typedData with eth_signTypedData_v4, in order (one authorization, or for permit tokens a permit plus the order itself); binding is the order the authorization commits to, so recipient, fee and minimum can be checked first. '
        + 'kind "tron-transactions": sign every steps[].transaction (first the fee, then the transfer). '
        + 'kind "evm-transactions" (gas drop, BNB Chain): if funding.needed, sign funding.message with personal_sign (a message, no transaction, proves the wallet is the sender\'s) and call submit_signatures with fund: true and that fundSignature first, so gasrescue sends the wallet the gas; then send every steps[].tx from the wallet (eth_sendTransaction, fee first) and report the hashes with submit_signatures txs: { fee, transfer }. '
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
        + 'Give signatures for EVM and Tron, signedTransaction for Solana, or for a gas drop fund: true with fundSignature and then txs. '
        + 'Returns { summary, transfer } with status confirmed or failed, the transaction hash and the explorer link.',
      inputSchema: {
        type: 'object',
        properties: {
          transferId: ID,
          signatures: { type: 'array', items: { type: 'string' }, description: 'EVM and Tron: one signature per step of get_signing_request, in the same order, as hex strings.' },
          signedTransaction: { type: 'string', description: 'Solana only: the transaction from get_signing_request, signed by the sender, base64.' },
          fund: { type: 'boolean', description: 'Gas drop (kind "evm-transactions") only: true asks gasrescue to send the wallet the gas for its two transfers. Needs fundSignature. Returns status funded.' },
          fundSignature: { type: 'string', description: 'Gas drop only, with fund: true: the sender wallet\'s personal_sign signature of funding.message from get_signing_request, as hex. Without it no gas is sent.' },
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
      run: async ({ transferId, signatures, signedTransaction, fund, fundSignature, txs }) => {
        // A gas drop answers right away: after the gas the wallet still has to send its transfers.
        if (fund || txs) return withSummary(await http.post(`/api/transfers/${idOf(transferId)}/submit`, fund ? { fund: true, signature: fundSignature } : { txs }));
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
        + 'It signs only a quote made with quote_send or quote_swap in this session, unchanged: wallet, recipient, chain, token, amount, fee and minimum output must match what was shown, for the published gasrescue contract and token. Anything else is refused. '
        + `This moves funds and cannot be undone: get the user's approval of the quote summary first.${allowed.length ? ' Sends go only to the configured allowed recipients.' : ''} `
        + 'Returns { summary, transfer } with status confirmed or failed and the explorer link.',
      inputSchema: { type: 'object', properties: { transferId: ID }, required: ['transferId'], additionalProperties: false },
      run: async ({ transferId }) => {
        const id = idOf(transferId);
        if (!live && !trustCustomApi) throw new Error(`Refused to sign: GASRESCUE_API is ${api}, not ${DEFAULT_API}. sign_and_submit would have to trust that server's contracts. Set GASRESCUE_TRUST_CUSTOM_API=1 only for your own test server.`);
        // One answer only: what is checked is what is signed.
        const request = await http.get(`/api/transfers/${id}/sign`);
        const transfer = request && request.transfer;
        if (!transfer || transfer.id !== id) throw new Error('Refused to sign: gasrescue answered for another quote.');
        const { contracts, chain } = await trusted(transfer);
        verifyEvm({ transfer, request, account: signer.address, contracts, chain });
        const quoted = quotes.get(id);
        if (!quoted) throw new Error('Refused to sign: this quote was not made with quote_send or quote_swap in this session. Quote it here, show the summary to the user, then sign.');
        matchesQuote(quoted, transfer);
        if (allowed.length && !quoted.swap && !allowed.some((entry) => same(entry, quoted.recipient))) throw new Error('Refused to sign: the recipient is not in GASRESCUE_ALLOWED_RECIPIENTS.');
        const signatures = [];
        for (const { typedData } of request.steps) signatures.push(await signer.signTypedData(typedData.domain, withoutDomain(typedData.types), typedData.message));
        quotes.delete(id);
        await http.post(`/api/transfers/${id}/submit`, { signatures });
        return withSummary(await waitForResult(id));
      },
    });
  }
  return tools;
}

module.exports = { createTools, verifyEvm, matchesQuote, summary, isLiveApi, LIVE_CHAINS, LIVE_CONTRACTS, DEFAULT_API, TYPES };

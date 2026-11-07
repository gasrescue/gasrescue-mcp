# gasrescue MCP server

Rescues stablecoins from wallets that have no gas, for AI agents, through [gasrescue.io](https://gasrescue.io/?ref=mcp-readme).
EVM chains, Solana and Tron in one server, no API key and no account.

The wallet holds USDC or USDT but no ETH, POL, AVAX, BNB, SOL, TRX or HYPE, so every transfer fails with "insufficient
funds for gas". With this server an agent can find out where the money is stuck, then still send the
stablecoins, or swap a few dollars into the gas coin so the wallet works on its own again: the wallet signs,
gasrescue sends the transaction and pays the network fee, and its fees come out of the amount.

Chains: Base, Arbitrum, Ethereum, Polygon, Avalanche, BNB Chain, HyperEVM, Robinhood Chain, Solana, Tron.
Tokens: USDC, USDC.e, USDT (USDT0 on Arbitrum, Polygon and HyperEVM), USDG, USD1, FDUSD, depending on the chain.

Listed in the official MCP Registry as `io.github.gasrescue/gasrescue`.

## Tools

| Tool | What it does |
|---|---|
| `gasrescue_info` | Chains, tokens, fees and limits |
| `check_wallet` | Read-only: stablecoins and gas of an address on every chain, issuer freezes included |
| `quote_send` | Quote a send without gas; returns fees, what the recipient gets and a transfer id |
| `quote_swap` | Quote a swap into the gas coin (ETH, POL, AVAX, SOL, HYPE) without gas |
| `get_signing_request` | What the wallet has to sign for a quote |
| `submit_signatures` | Submit the signatures; gasrescue sends and pays the gas |
| `get_transfer` | Status and explorer link |
| `sign_and_submit` | Only with `GASRESCUE_EVM_PRIVATE_KEY`: checks and signs an EVM quote with that wallet |

## Setup

Claude Desktop, Cursor and other MCP clients:

```json
{
  "mcpServers": {
    "gasrescue": {
      "command": "npx",
      "args": ["-y", "gasrescue-mcp"]
    }
  }
}
```

Without a key the server never signs anything. The agent hands the signing request to the user's wallet,
or to its own wallet tool, and submits the signatures.

BNB Chain works without a contract, because USDT and USDC there have no signed transfers. The signing
request has kind `evm-transactions`: the wallet signs `funding.message` with `personal_sign` (plain text,
no transaction, proves the wallet is the sender's), then `submit_signatures` with `fund: true` and that
`fundSignature` makes gasrescue send the wallet a little BNB, then the wallet sends the two listed transfers itself (fee first) and the agent
reports their hashes with `submit_signatures` and `txs: { fee, transfer }`.

### Letting the agent sign (EVM only)

```json
"env": {
  "GASRESCUE_EVM_PRIVATE_KEY": "0x…",
  "GASRESCUE_ALLOWED_RECIPIENTS": "0xYourExchangeDeposit,0xYourOtherWallet"
}
```

Before it signs, `sign_and_submit` checks every signed field against the quote: the wallet, the chain,
the gasrescue contract, the amount, the fee, the recipient and, on a swap, the minimum output. Tokens with
only a permit (USDT0 and USDC.e on Polygon, USDT on Avalanche) take two signatures, a permit plus the order itself; both are checked. Against gasrescue.io it signs only for the
published gasrescue contracts. With `GASRESCUE_ALLOWED_RECIPIENTS` set, sends go only to those addresses.
The key stays in this process; only signatures are sent.

Use a wallet that holds only what the agent should be able to move. Transfers on a blockchain are final.

## Limits

$2 to $1,000 per transfer, 10 transfers per wallet in 24 hours, Tron at least $10. Service fee 0.5%,
at least $0.25, at most $2 per send and $5 per swap, plus the network fee. Every quote shows the exact figures.

More: https://gasrescue.io/agents?ref=mcp-readme

## License

MIT

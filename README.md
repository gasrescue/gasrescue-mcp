# gasrescue MCP server

Gasless USDC, USDT and USDG transfers and swaps from existing wallets, for AI agents, through
[gasrescue.io](https://gasrescue.io).

The wallet holds stablecoins but no ETH, SOL, TRX or HYPE, so every transfer fails with "insufficient funds
for gas". With this server an agent can still send the stablecoins, or swap a few dollars into the gas coin:
the wallet signs, gasrescue sends the transaction and pays the network fee, and its fees come out of the amount.

Chains: Base, Arbitrum, Ethereum, HyperEVM, Robinhood Chain, Solana, Tron.
Tokens: USDC, USDT (USDT0), USDG, depending on the chain.

Listed in the official MCP Registry as `io.github.gasrescue/gasrescue`.

## Tools

| Tool | What it does |
|---|---|
| `gasrescue_info` | Chains, tokens, fees and limits |
| `check_wallet` | Read-only: stablecoins and gas of an address on every chain, issuer freezes included |
| `quote_send` | Quote a send without gas; returns fees, what the recipient gets and a transfer id |
| `quote_swap` | Quote a swap into the gas coin (ETH, SOL, HYPE) without gas |
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

### Letting the agent sign (EVM only)

```json
"env": {
  "GASRESCUE_EVM_PRIVATE_KEY": "0x…",
  "GASRESCUE_ALLOWED_RECIPIENTS": "0xYourExchangeDeposit,0xYourOtherWallet"
}
```

Before it signs, `sign_and_submit` checks every signed field against the quote: the wallet, the chain,
the gasrescue contract, the amount, the fee and the recipient. Against gasrescue.io it signs only for the
published gasrescue contracts. With `GASRESCUE_ALLOWED_RECIPIENTS` set, sends go only to those addresses.
The key stays in this process; only signatures are sent.

Use a wallet that holds only what the agent should be able to move. Transfers on a blockchain are final.

## Limits

$2 to $1,000 per transfer, 10 transfers per wallet in 24 hours, Tron at least $10. Service fee 0.5%,
at least $0.25, at most $2 per send and $5 per swap, plus the network fee. Every quote shows the exact figures.

More: https://gasrescue.io/agents

## License

MIT

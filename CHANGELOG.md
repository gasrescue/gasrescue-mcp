# Changelog

## 0.1.11
- BNB Chain gas drop: gasrescue now sends gas only to a wallet that proved it is the sender's. The wallet signs `funding.message` from get_signing_request with personal_sign (plain text, no transaction, no gas), and submit_signatures passes it as `fundSignature` together with `fund: true`. Older versions get "Please confirm in your wallet that this is your wallet before gas is sent." on BNB Chain.

## 0.1.10
- Links to gasrescue.io in the package, the README, the bundle manifest and the registry entry carry a source tag (`?ref=npm`, `mcp-readme`, `mcpb`, `mcp-registry`), so gasrescue can count visits from each listing. No cookies, nothing about the user.
- check_wallet tags its checks with the source "mcp", like the quotes, so gasrescue can count how many wallet checks come from agents. Nothing about the wallet is stored.

## 0.1.9
- Avalanche C-Chain: USDC and USDT (USDt), sends and swaps into AVAX. USDT there has only a permit: two signatures, a permit plus the order.
- quote_send and quote_swap tag their quotes with the source "mcp", so gasrescue can count how many come from agents. No addresses or keys are added.

## 0.1.8
- BNB Chain: USDT, USDC, USD1 and FDUSD. These tokens have no signed transfers, so there is no contract: gasrescue sends the wallet a little BNB (submit_signatures with fund: true), the wallet sends the fee and the transfer itself, and submit_signatures reports their hashes (txs).
- get_signing_request explains the new kind "evm-transactions"; gasrescue_info marks such chains with gasDrop.
- sign_and_submit refuses gas-drop quotes with a clear reason instead of a generic one.

## 0.1.7
- Polygon: USDC, USDT0 and USDC.e, sends and swaps into POL.
- Signs permit tokens (a permit plus the order) and token domains that carry the chain id as a salt.
- sign_and_submit also checks that a swap's signed minimum output matches the quote.
- Descriptions lead with the rescue case: stablecoins stuck in a wallet without gas.

## 0.1.6
- get_transfer explains every state, when not to use it and the error for unknown ids.
- The transfer id parameter says where it comes from, its format and gives an example.
- Smoke test (npm test) and CI on GitHub Actions.

## 0.1.5
- Tool titles and MCP annotations (read-only, moves funds) so clients know what a tool does before calling it.
- Tool descriptions say when to use each tool, what it changes and what it returns.
- Dockerfile and glama.json for registries that build the server.

## 0.1.4
- Clearer description and keywords: gasless USDC, USDT and USDG transfers and swaps from existing wallets.
- Tool descriptions name the usual symptoms: no ETH, SOL, TRX or HYPE, "insufficient funds for gas".

## 0.1.3
- Correct README and MIT license (0.1.2 shipped the wrong ones and is deprecated).

## 0.1.2
- Listed in the official MCP Registry as io.github.gasrescue/gasrescue.

## 0.1.1
- MCP bundle (manifest.json) for Claude Desktop.
- Reads input piped from Windows with a byte order mark.

## 0.1.0
- First release: check_wallet, quote_send, quote_swap, get_signing_request, submit_signatures, get_transfer,
  and sign_and_submit with a local EVM key that checks every signed field against the quote.

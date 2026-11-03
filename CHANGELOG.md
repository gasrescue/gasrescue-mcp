# Changelog

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

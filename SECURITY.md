# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, by email to contact@gasrescue.io or through
GitHub's "Report a vulnerability" (Security tab), before publishing them. Include the
version, the steps to reproduce and what an attacker gains. Test only locally or against
your own stand-in for the API, never against gasrescue.io, the contracts or other people's
wallets.

## Supported versions

Only the latest version on npm gets fixes. With `GASRESCUE_EVM_PRIVATE_KEY` set, use 0.1.12
or later.

## What the MCP server protects

Without `GASRESCUE_EVM_PRIVATE_KEY` the server signs nothing; the user's wallet signs.

With a key, `sign_and_submit` treats the API as untrusted. It signs only a quote made in the
same session, unchanged, for the published gasrescue contract and token of that chain, in the
contracts' exact typed-data layout, with signatures that expire within an hour. Use a wallet
that holds only what the agent should be able to move.

The contracts have their own policy:
https://github.com/gasrescue/gasrescue-contracts/blob/main/SECURITY.md

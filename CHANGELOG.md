# Changelog

All notable changes to `@arcnow/mcp`, the arcnow.io MCP server. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning:
[SemVer](https://semver.org/), with 0.x semantics until 1.0.0.

Versions are derived from the commits on `main` by `scripts/next-version.sh` and
written here by `scripts/apply-version.sh`; the section for a version is the list
of commits that went into it. A section written by hand before the release, like
the first one below, is kept as written.

## [Unreleased]

## [0.1.1] - 2026-09-17

- Depend on the published @arcnow/sdk, exactly, and pin it by its tarball

## [0.1.0] - 2026-09-17

The first published release. An MCP server that lets an AI assistant use
arcnow.io on Arc through `@arcnow/sdk`, read-only by default.

### Added

- Nine read tools, always published: `arcnow_network`, `arcnow_quote_tokens`,
  `arcnow_list_tokens`, `arcnow_token`, `arcnow_quote_buy`, `arcnow_quote_sell`,
  `arcnow_quote_launch`, `arcnow_platform`, `arcnow_list_platforms`. Every quote
  reports the average fill price next to the spot price and every fee share
  both as bps of the fee and as a percentage of the trade.
- Six write tools, published only with `--allow-writes`: `arcnow_launch`,
  `arcnow_buy`, `arcnow_sell`, `arcnow_migrate`, `arcnow_withdraw_refund`,
  `arcnow_register_platform`. A private key is never a tool argument; it comes
  from the operator's environment or not at all.
- Per-quote-token spend caps that fail closed, with native USDC and every
  allowlisted ERC-20 quote (EURC on Arc testnet) priced in its own units.
- Trading a graduated token through its Uniswap v4 pool, with the gas headroom
  the fee hook's transfers need.
- A network file (`ARCNOW_MCP_NETWORK_FILE`) for a stack the SDK has no preset
  for.
- The SDK pinned to a commit in `pins.json`, down to the bytes of its public
  surface.
- Licensed under GPL-3.0-or-later.

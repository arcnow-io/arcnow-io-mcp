# Changelog

All notable changes to `@arcnow/mcp`, the arcnow.io MCP server. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning:
[SemVer](https://semver.org/), with 0.x semantics until 1.0.0.

Versions are derived from the commits on `main` by `scripts/next-version.sh` and
written here by `scripts/apply-version.sh`; the section for a version is the list
of commits that went into it. A section written by hand before the release, like
the first one below, is kept as written.

## [Unreleased]

## [0.2.0] - 2026-09-17

The server now runs on arcnow.io's live contract stack, on Arc mainnet as well as
Arc testnet, through `@arcnow/sdk` 0.2.0. The fee model it reports changed shape,
which is why this is a minor release under 0.x semantics rather than a patch.

### Added
- **Arc mainnet.** `ARCNOW_MCP_NETWORK=arc-mainnet` starts the server on the live
  network (chain 5042, `https://rpc.mainnet.arc.io`), reading every address from
  the SDK's preset: the launchpad, arcnow.io's platform, the Uniswap v4 router and
  PoolManager, and native USDC and EURC (`0xbEf5f6d5…`) as quote tokens. Spend caps
  work per quote there as everywhere: `ARCNOW_MCP_MAX_SPEND_EURC` caps mainnet's
  EURC by its mainnet address, and a quote with no cap is refused. The startup
  banner and the session instructions say, in as many words, that every write on
  mainnet is real money; the testnet server says it is the rehearsal. The default
  stays `arc-testnet`, so nobody is pointed at real money by omission.
- **The pool's fees, read off the pool.** Every pool report — `arcnow_token`,
  `arcnow_quote_buy`, `arcnow_quote_sell`, `arcnow_buy` and `arcnow_sell` in a
  pool — shows the two charges apart and their total: arcnow.io's fee hook's
  0.80% of the trade, taken in the pool's quote, plus the pool's own 0.20% LP fee,
  1.00% in all, the same as the curve. Both rates, and the hook's split of its
  part (creator 5000 / platform 1875 / protocol 3125 bps; a pool swap has no
  referrer), come from the SDK's `Pool.fees()`, which reads the hook and the pool
  key. The server holds no fee constant: a pool whose key carries another LP fee
  is reported at the fee it carries.
- `arcnow_register_platform` seeds a new platform with the template arcnow.io's
  own platform serves on the current network: the reference template
  (1,000,000,000 supply, 50,000 to graduate) on mainnet, the testnet template
  (1,000,000 / 50) on testnet.

### Changed
- **The fee has four parties.** A curve's 1% is split between the creator, the
  platform, the referrer and the protocol — arcnow.io's own split is 3000 / 3500 /
  1000 / 2500 bps of the fee — and every fee breakdown, `arcnow_platform` and
  `arcnow_list_platforms` print those four. There is no developer share: the
  `developer` argument is gone from `arcnow_quote_buy`, `arcnow_quote_sell`,
  `arcnow_buy` and `arcnow_sell`, and `devShareBps` from
  `arcnow_register_platform`. Every schema is strict, so passing one is refused
  by name rather than ignored.
- **Launching is free.** The quote registry's launch fee is zero for every quote
  on both networks. The tools keep reading it from the registry and print the
  figure they read — `0 USDC launch fee — launching is free` — so a launch's
  total is exactly its initial buy.
- **The SDK pin** moves from `@arcnow/sdk` 0.1.3 to 0.2.0, whose version gates
  accept the live `bonding-curve@4.x` stack and refuse the retired multi-quote
  `@3.x` contracts by name, as they refuse `@2.x` and `@1.x`. A fee hook of a
  refused version has neither its accrual nor its rates read.
- The README describes both networks, with the client examples on `arc-mainnet`
  and the writes-enabled example kept on `arc-testnet` as the rehearsal.

### Removed
- The refusal of `arc-mainnet` at startup, and the instruction that there was no
  arcnow.io mainnet. There is.

## [0.1.2] - 2026-09-17

### Changed
- The README is written for people who run the server: per-client setup for Claude Code, Claude Desktop, Codex, Cursor, VS Code and Gemini CLI, all via `npx -y @arcnow/mcp`; what `npm test` proves. The maintainers' notes on the SDK pin and the gates live outside the published tree.
- The currently published preset is Arc testnet only; the mainnet preset arrives with the next SDK update.

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

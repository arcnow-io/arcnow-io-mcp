# `@arcnow/mcp`

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant use
[arcnow.io](https://arcnow.io) on [Arc](https://docs.arc.io/): read the bonding
curves, quote a trade with its full fee breakdown — on a token's curve before it
graduates, or in its Uniswap v4 pool after — see how close a token is to
graduating, and, **only if the operator explicitly turns it on**, launch, buy,
sell and rescue a stranded migration.

Every chain interaction goes through
[`@arcnow/sdk`](https://www.npmjs.com/package/@arcnow/sdk), pinned to an exact
published version in [`pins.json`](pins.json). Nothing here encodes a call or
computes a curve.

## Install and run

The server is on npm as [`@arcnow/mcp`](https://www.npmjs.com/package/@arcnow/mcp)
(Node 22.12 or newer). Run it straight from the registry:

```sh
npx -y @arcnow/mcp                  # read-only. The default, and the useful part.
npx -y @arcnow/mcp --allow-writes   # can spend, if ARCNOW_PRIVATE_KEY is in the environment.
```

Every client below runs that same command with `ARCNOW_MCP_NETWORK` set. The
examples say `arc-mainnet`, where [arcnow.io](https://arcnow.io) is live — Arc
mainnet, chain 5042. `arc-testnet` is the rehearsal network: the same contracts
at other addresses, with test funds. With the variable unset the server starts
on `arc-testnet`, so nobody is pointed at real money by omission.

**Write mode, in every client:** add `--allow-writes` to the arguments and put
the signing key **in a file** the server reads through `ARCNOW_PRIVATE_KEY_FILE`
— never the key itself in a client config, which gets committed and
screenshotted. Read-only needs no key at all. **On `arc-mainnet` every write is
real money**: the spend caps below are what bounds a mistake, and the server
says so at startup and in every session. Every variable is in
[Configuration](#configuration); [`examples/`](examples) has both shapes — the
writes-enabled one on `arc-testnet`, as a rehearsal.

### Claude Code

```sh
claude mcp add --env ARCNOW_MCP_NETWORK=arc-mainnet --scope user arcnow -- npx -y @arcnow/mcp
```

`--scope` is `local` (this project, you only; the default), `project` (checked
into `.mcp.json` at the project root, shared with the team) or `user` (every
project). The project-file form:

```json
{
  "mcpServers": {
    "arcnow": {
      "command": "npx",
      "args": ["-y", "@arcnow/mcp"],
      "env": { "ARCNOW_MCP_NETWORK": "arc-mainnet" }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json` — macOS
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows
`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arcnow": {
      "command": "npx",
      "args": ["-y", "@arcnow/mcp"],
      "env": { "ARCNOW_MCP_NETWORK": "arc-mainnet" }
    }
  }
}
```

### Codex

`~/.codex/config.toml` (or `.codex/config.toml` in a project):

```toml
[mcp_servers.arcnow]
command = "npx"
args = ["-y", "@arcnow/mcp"]

[mcp_servers.arcnow.env]
ARCNOW_MCP_NETWORK = "arc-mainnet"
```

Or from the CLI: `codex mcp add arcnow --env ARCNOW_MCP_NETWORK=arc-mainnet -- npx -y @arcnow/mcp`.

### Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "arcnow": {
      "command": "npx",
      "args": ["-y", "@arcnow/mcp"],
      "env": { "ARCNOW_MCP_NETWORK": "arc-mainnet" }
    }
  }
}
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json` — note the key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "arcnow": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@arcnow/mcp"],
      "env": { "ARCNOW_MCP_NETWORK": "arc-mainnet" }
    }
  }
}
```

For write mode, VS Code's `inputs` can prompt for the key-file path instead of
writing it into the file; see its MCP documentation for the `${input:…}` form.

### Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "mcpServers": {
    "arcnow": {
      "command": "npx",
      "args": ["-y", "@arcnow/mcp"],
      "env": { "ARCNOW_MCP_NETWORK": "arc-mainnet" }
    }
  }
}
```

Or `gemini mcp add -e ARCNOW_MCP_NETWORK=arc-mainnet arcnow npx -y @arcnow/mcp`.

### Windsurf, Cline

Both take the generic `mcpServers` JSON above — the same `command`, `args` and
`env` — in their MCP settings file.

### From source

Clone [arcnow-io/arcnow-io-mcp](https://github.com/arcnow-io/arcnow-io-mcp), then
`npm ci && npm run build && node dist/index.js`; the SDK comes from npm.

---

## The two rules this server is built around

### 1. A private key is never a tool argument

No tool here takes a key, a mnemonic or a credential of any kind. The signing
key is read once, at startup, from `ARCNOW_PRIVATE_KEY` or a file named by
`ARCNOW_PRIVATE_KEY_FILE`, and from nowhere else.

This is not a claim about environment variables being safer in general. It is
about where a tool argument *goes*. An argument is written by a model into a
transcript: to the model provider, into the client's logs, into the context of
every later turn, and into the bug report somebody pastes into an issue. A key
that has been through a tool call has been published, and there is no
un-publishing it.

So the schemas declare no such field, and — because declaring nothing is not
enough — **every schema is strict**. An argument this server did not ask for is
a refusal, not a silently dropped key, and if the field was named like a
credential the refusal says so and says to rotate it. `test/unit/no-key-arguments.test.ts`
walks every published schema and asserts both halves.

### 2. Read-only is the default, and writing is the operator's decision

With an empty environment this server can read everything and spend nothing. The
write tools are not published at all: a model that cannot see `arcnow_launch`
does not offer to launch anything.

Writing requires `--allow-writes` (or `ARCNOW_MCP_ALLOW_WRITES=1`) **and** a key,
from whoever starts the process — a person editing a config file, not a model
mid-conversation. The mode is printed on stderr at startup and reported by
`arcnow_network`, so nobody has to guess which one they are talking to.

Two edge cases, both deliberate:

- **A key with no opt-in starts read-only** and warns that the key is present
  and unused. A key is not consent to spend it.
- **An opt-in with no key refuses to start.** The operator asked for something
  this process cannot do, and a server that quietly downgrades produces its
  failure later, in the middle of somebody's trade.

---

## The tools, and why each one exists

Nine read tools, always published. Six write tools, published only on opt-in.

### Read

| tool | what it answers |
| --- | --- |
| `arcnow_network` | Which chain, which contracts, which graduation venues, whether a v4 router is configured for graduated tokens, **and which mode this server is in**. The first call of any session that might trade. |
| `arcnow_quote_tokens` | The quote tokens a launch may use — native USDC and the ERC-20s the quote registry allowlists, such as EURC — each with its symbol, name, decimals, address, whether it is native, its launch fee in its own units (zero on both networks: launching is free, and the figure is read from the registry rather than assumed), whether the registry accepts it now, and **this server's spend cap for it**. At most three `eth_call`s. On a chain with no quote registry, it says so, shows the error, and lists the network's own quote-token metadata with nothing known to be accepted. |
| `arcnow_list_tokens` | Recent launches, newest first, from the launchpad's `Launched` log, back to the block it was deployed in. Reports the block window it actually covered — see [the SDK gap](#what-made-a-clean-surface-awkward). |
| `arcnow_token` | One token in full: metadata, **its quote token** (address, symbol, decimals, native or ERC-20), its curve's parameters (`r0Wad`, `y0Wad`), curve state, price, progress, and **where it trades now** — its curve, its v4 pool (with the router, whether it reaches the pool, the PoolManager, what a trade there costs — the hook's 0.80% and the pool's 0.20% LP fee, read off the pool — how the hook splits its part, and what it holds accrued), or nowhere. Takes a token *or* a curve address. |
| `arcnow_quote_buy` | What an amount of the token's quote (`quoteIn`) would buy, wherever the token trades. On a curve: tokens out, the 1% fee split four ways — creator, platform, referrer, protocol — with exactly who receives each share, the average fill price, minimum-out floors at four tolerances. In a pool: a quote that says it is a pool quote, with the fee hook's 0.80% and the pool's own 0.20% LP fee apart (1.00% in all, both read off the pool), the hook's three-way split, the average fill against the pool's spot price, and the price impact. |
| `arcnow_quote_sell` | The same for a sell — plus, on a curve, that selling needs no approval, ever, and in a pool, that it does, and how much the holder has approved already. |
| `arcnow_quote_launch` | What a launch in a given `quote` (native USDC by default, or an ERC-20 by symbol or address) would cost before anything is spent: the launch fee the registry reports (zero — launching is free), the initial buy and its own trade fee, with the predicted token and curve addresses. |
| `arcnow_platform` | A platform's four-way fee split, its default migrator and its curve template — every share printed both as bps of the fee and as a percentage of a trade. |
| `arcnow_list_platforms` | The registry's actual enumeration. Complete, unlike the token list. |

The read tools are the valuable part. An assistant that can answer *what is this
token, what would 50 EURC buy me, how close is it to graduating* with no key
anywhere near it is useful to far more people than one that can trade.

Three things the read tools go out of their way to say, because each is a
mistake that costs money:

- **A spot price is not a fill price.** The curve integrates price across an
  order, so a buyer pays a rising price over their own trade. Every quote
  reports an *average fill price* next to the spot price, and the tool
  descriptions tell the model to quote rather than multiply.
- **A share of the fee is not a share of the trade.** 3000 bps of the fee is
  0.30% of a trade. Both are printed, every time. The fee has **four parties** —
  creator, platform, referrer, protocol; arcnow.io's own split is 3000 / 3500 /
  1000 / 2500 — and no developer share: no tool takes a `developer`.
- **Graduated and migrated are different states.** A curve can have stopped
  trading permanently while its pool was never created, and then the token
  trades *nowhere*. That is reported as its own thing, with the rescue named.
- **A pool quote is not a curve quote.** It says so, and it names two charges,
  not one: the fee hook's **0.80%**, taken in the pool's quote and split creator /
  platform / protocol, and the pool's own **0.20%** Uniswap LP fee — 1.00% in all,
  the same as the curve charged. Both rates are read off the pool, never assumed.

### Write

| tool | what it does | irreversible? |
| --- | --- | --- |
| `arcnow_launch` | Launches a token and its curve, priced for life in the `quote` it names. For an ERC-20 quote the SDK approves the launchpad for exactly the total first, and the result reports that approve. | **Yes, in every respect.** |
| `arcnow_buy` | Buys wherever the token trades — its curve, or its v4 pool once migrated. Spends `quoteIn`, in the token's quote; an ERC-20 quote is approved for exactly that first, and the approve is reported. | No — the tokens can be sold back, at a price. |
| `arcnow_sell` | Sells wherever the token trades. Receives the token's quote. In a pool, grants the router an approval **only** when told to, for exactly the amount sold. | No |
| `arcnow_migrate` | Creates the pool for a curve that graduated without one. | No — it only ever adds a market. |
| `arcnow_withdraw_refund` | Claims the quote a curve credited after a failed transfer. | No — it recovers funds. |
| `arcnow_register_platform` | Deploys a new `PlatformConfig`. Protocol admin only. | The config is permanent. |

`arcnow_launch`'s description says, in as many words, that the name, symbol,
supply, curve shape and graduation venue are fixed at that transaction and can
never be changed by anyone, that there is no admin key that can fix a typo in a
symbol, and that the only remedy is another launch and another fee. It also
requires `acknowledgeIrreversible: true`, which is not security — a model can
set a boolean — but does make the assertion explicit in the transcript.

### How a write is gated, in order

1. **The operator's opt-in.** Not published, and refused by name if called
   anyway. (A cached tool list is why the refusal exists as well as the
   omission; "unknown tool" reads as "you guessed wrong" and invites a model to
   try variations.)
2. **The operator's ceilings, one per quote token.** See
   [spend caps](#spend-caps-per-quote-token-fail-closed). Not arguments, and they
   cannot be raised from a tool call.
3. **The caller's stated ceiling.** Every spending tool requires
   `maxTotalCost`, in the token's quote: the most the caller believes this call will cost. A fresh
   quote is taken *inside* the call and compared against it. That catches a
   quote that went stale between being shown to a person and being acted on, a
   curve that moved, and a model talked into a bigger number than the
   conversation agreed to — none of which one session-wide ceiling catches.
4. **No default slippage.** `slippageBps` is required on every trading tool.
   Zero means "fill me at any price", which on a public mempool is a donation,
   so it has to be typed rather than omitted.
5. **Nothing that does not apply.** A curve trade pays the sender and has no
   `recipient`; a pool swap has no `referrer` and cannot graduate anything, so
   `gasLimit` guards nothing there. Each is **refused** on the
   venue it does not exist on, before anything is quoted or sent — never
   silently dropped. The SDK refuses the same things; this server says so first.
6. **The report.** Each tool states the exact cost and the exact effect, and
   says afterwards what actually happened.

None of that makes an assistant trustworthy with money. It makes the blast
radius a number somebody chose.

### The gas trap, which this server handles for you

A graduating buy migrates the curve **in its own transaction**, under a bounded
gas budget whose failure the curve *catches* rather than reverting. So
`eth_estimateGas` — which searches for the lowest limit at which the transaction
still succeeds, and a graduating buy succeeds either way — converges on exactly
the limit at which the migration is starved. The buy fills, the curve graduates,
the refund is correct, and the pool is simply never created. **There is no revert
and no error anywhere.**

`arcnow_buy` therefore takes a fresh quote, and when that quote says the buy
graduates it sends an explicit **8,000,000** gas limit rather than letting the
node estimate one. (The curve budgets 6,000,000 for the migrator and keeps
100,000 back; a limit is a ceiling, not a charge.) A `gasLimit` below 6,200,000
on a graduating buy is refused outright. The result reports
`migratedInThisTransaction`, which is a different question from whether the
curve graduated — and when the migration was starved anyway, it names
`arcnow_migrate` as the permissionless rescue.

### Trading a graduated token

A token's market moves once, irreversibly: from its bonding curve to a Uniswap
v4 pool, when the curve graduates and migrates. The quote and trade tools go
through the SDK's `client.trade(token)`, which decides the venue, so the same
four tools work across that line. Three states, told apart out loud:

| state | quote | buy / sell |
| --- | --- | --- |
| on its curve | a curve quote, as before | through the curve; `recipient` refused |
| graduated **and** migrated | a pool quote, labelled as one | through arcnow.io's router; `gasLimit`, `referrer` refused |
| graduated, **not** migrated | refused: tradeable nowhere until `migrate()` | refused, naming `arcnow_migrate` |

**What a pool quote contains.** The SDK prices a pool trade by simulating the
real swap through the router, so the figures are the real fill with two charges
inside them. The quote takes them back out and names each: the fee hook's 0.80%,
which it takes in the pool's quote and splits creator 5000 / platform 1875 /
protocol 3125 bps (a pool swap has no referrer), and the pool's own 0.20% LP fee
— the pool key's `fee`, in hundredths of a bip — which Uniswap charges and the
pool's liquidity keeps. 1.00% in all, the same as the curve. Every rate comes
from the SDK's `Pool.fees()`, which reads the hook's `feeBps()` and
`feeConfigOf()` and the key; this server holds no fee constant, so a pool whose
key carries another LP fee is reported at the fee it carries. It shows the
average fill price, the pool's spot price, and the price impact between them.
The SDK has no
reader for a pool's price, so the spot price is the SDK's own quote of a
probe buy with both fees taken out — 0.000001 of an 18-decimal quote, or 10,000 raw
units of a smaller one (0.01 EURC), so the fees' raw-unit rounding stays below one
part in ten thousand — and the report says so.

**The pool's quote is the SDK's.** A v4 key orders its currencies by address:
native USDC is always `currency0`, an ERC-20 such as EURC can be either.
Nothing here reads `currency0` as the quote; `arcnow_token` says which currency
of the key the SDK found the quote to be.

**The sell approval.** A curve sell needs no approval; a pool sell does, because
the router pulls the tokens with `transferFrom`. That approval is a separate
transaction granting spending rights, and it is the one thing this server does
that grants rights rather than spending money. So `arcnow_sell`:

- **never sends it unless the call says `approveRouter: true`.** Without it, a
  sell whose allowance is short is refused, nothing is sent, and the refusal
  says exactly what the approval would be: token, owner, spender, amount;
- **approves exactly the amount being sold**, never an unlimited allowance, and
  only if the existing allowance does not already cover the sale;
- **reports it** — token, owner, spender, amount, transaction, and the allowance
  left afterwards — including when the sell that followed it then failed, in
  which case it says the approval still stands.

`approveRouter` on a curve sell is refused: nothing would use it.

**A revert inside the pool.** Uniswap v4 wraps a revert from inside a hook, and
a failed transfer out of the PoolManager, in `WrappedError` (`0x90bfb865`). The
SDK unwraps it: a known inner error keeps its own code with the wrapper layers on
`details.wrappedBy`, and an empty one is `WrappedRevert`, with each layer named
— `NativeTransferFailed` or `ERC20TransferFailed` for a transfer. This
server names the failed transfer from the decoded layers, points at
`arcnow_quote_buy` for a smaller amount, and shows the SDK's reason and the layers
once. It adds no cause of its own.

**How a failure is said.** A code the SDK raises itself (`SDK_ERROR_CODES`) is a
*refusal* made before any transaction — `AddressIsNotACurve`,
`UnknownCurveVersion`, `UnknownHookVersion` and the rest. A
decoded contract error or revert *failed on-chain*. `RpcFailure` *could not
reach the chain*: the public endpoint rate-limits, and that says nothing about
the token.

### One curve, on two networks

arcnow.io has one bonding curve — the constant-product curve,
`arcnow/bonding-curve@4.x.x`, priced in a quote token, with parameters `r0Wad`
(the virtual quote reserve at launch, in WAD) and `y0Wad` (the virtual token
reserve at launch) — launched through one contract stack, and a fee hook,
`arcnow/arc-now-fee-hook@4.x.x`, that takes its 0.80% in the pool, accrues each
fee as a PoolManager claim and pays it out at the start of a later swap. The same
build is live on Arc mainnet (`arc-mainnet`) and Arc testnet (`arc-testnet`), at
different addresses; a token address from one means nothing on the other, and
the server's instructions say which network a session is on.

- **Nothing a tool prints names a curve kind or a stack.** There is one of
  each. `arcnow_token` prints the curve's own parameters, and a pool trade
  reports the fees it paid out from earlier trades (`FeesDistributed`) apart
  from the trader's fill.
- **Any other version is refused by name, and never priced.** A curve or a
  platform of another version — the retired multi-quote stack, `@3.x.x`, which
  carried a developer share and whose data was wiped; the `@2.x.x` contracts
  before it; the retired linear curve, `@1.x.x` — is the SDK's
  `UnknownCurveVersion`, naming the version, before any quote or send. A fee hook
  of another version — the `@3.x.x` hook that charged 1% in the pool included —
  is `UnknownHookVersion`, and neither its accrual nor its rates are read.
- **An address that is not a curve is refused by name.** The SDK's
  `AddressIsNotACurve` for an arcnow.io token's address is followed to its curve;
  for anything else — an ordinary ERC-20, an account, nothing at all — it is the
  refusal, saying the address is not an arcnow.io token either.
- **`arcnow_list_tokens` reads the one launchpad**, back to the block its stack
  was deployed in (21,179,866 on Arc mainnet, 62,386,232 on Arc testnet).

---

## Configuration

Everything is an environment variable, because an MCP client's config file is
where an operator's decisions belong. See
[`examples/`](examples) for a read-only and a writes-enabled client config.

| variable | default | what it does |
| --- | --- | --- |
| `ARCNOW_MCP_NETWORK` | `arc-testnet` | The network preset: `arc-mainnet` (Arc mainnet, chain 5042, where arcnow.io is live — **real money**) or `arc-testnet` (the rehearsal, chain 5042002). Both come from the SDK's `networks.json`; a name it does not know refuses to start, naming the two it does. The default is the rehearsal on purpose. |
| `ARCNOW_MCP_NETWORK_FILE` | unset | A path to a JSON document in the SDK's `CustomNetwork` shape, for a deployment no preset names — a local anvil stack, or a stack deployed onto a fork. **Mutually exclusive with a preset name.** See [below](#a-network-the-sdk-has-no-preset-for). |
| `ARCNOW_RPC_URL` | the preset's endpoint | Override the endpoint. Redacted of credentials before it is ever printed. |
| `ARCNOW_MCP_ALLOW_WRITES` | unset | `1` enables the write tools. `--allow-writes` does the same. |
| `ARCNOW_PRIVATE_KEY` | unset | The signing key. Read once, at startup. Never printed, never serialised, never a tool argument. |
| `ARCNOW_PRIVATE_KEY_FILE` | unset | The same, from a file — so the key is not in the client's config file either. Setting both is an error rather than a guess. |
| `ARCNOW_MCP_MAX_SPEND_USDC` | `100` | The ceiling on any single write call spending **native USDC**, in whole USDC. |
| `ARCNOW_MCP_MAX_SPEND_<SYMBOL>` | **unset: refused** | The ceiling on any single write call spending that quote token, in its own units: `ARCNOW_MCP_MAX_SPEND_EURC=50`. No default. |
| `ARCNOW_MCP_LOG_CHUNK_BLOCKS` | `10000` | Block range per `eth_getLogs` request in the launch scan. |
| `ARCNOW_MCP_LOG_MAX_CHUNKS` | `20` | How many such requests one `arcnow_list_tokens` call may make. |

There is no secret anywhere in this repository, and nothing here writes one to
disk. `ARCNOW_PRIVATE_KEY_FILE` is the recommended shape: a client config that
names a path holds no key even when it is committed or screenshotted.

### Spend caps: per quote token, fail-closed

A token is priced in one quote for life, and a cap in USDC cannot bound a spend
in EURC. So every quote token has its own cap, in its own units:

- `ARCNOW_MCP_MAX_SPEND_USDC` caps native USDC, and defaults to `100`.
- `ARCNOW_MCP_MAX_SPEND_<SYMBOL>` caps each other quote — `ARCNOW_MCP_MAX_SPEND_EURC=50`
  is 50 EURC. The symbol is upper-cased; a character that is not a letter or a
  digit is written `_`. The cap is matched to the network's own token by
  address: on `arc-mainnet` that is EURC at `0xbEf5f6d5…`, on `arc-testnet` at
  `0x89b50855…`, each read from the preset.

It fails closed, four ways:

- **A quote with no cap is refused** for every spending write — `arcnow_launch`
  and `arcnow_buy` — with a refusal that names the variable to set. Non-native
  quotes have no default. **A cap can never be got round by switching quote.**
- **A symbol resolves only against the network's own `quoteTokens`** — the SDK's
  `networks.json`, or `ARCNOW_MCP_NETWORK_FILE` — and a cap is matched to a
  token by address. A token's on-chain `symbol()` is never consulted, so a token
  calling itself EURC does not get EURC's cap, and a quote the network does not
  list can have no cap at all: it is always refused.
- **A `ARCNOW_MCP_MAX_SPEND_…` variable that names no quote token of the network
  refuses to start** the server, which catches a typo such as `…_EURO`.
- **Two quote tokens of the network sharing a symbol refuses to start** it: one
  variable cannot mean two caps.

What counts: a launch spends its `totalCost` — the initial buy plus any launch
fee (zero on both networks), in the launch's quote; a buy spends its `quoteIn`. For an ERC-20 quote the
SDK approves exactly that spend, so the same check covers the approve. The
caller's own `maxTotalCost` is read in the same quote. The startup banner,
`arcnow_network` and `arcnow_quote_tokens` show every cap, and
`describe()` reports `maxSpendPerCallUsdc` and `maxSpendPerCall`
(`{ "USDC": "100", "EURC": "50" }`, or `null` where none is set).

### A network the SDK has no preset for

`ARCNOW_MCP_NETWORK_FILE=/path/to/network.json` points the server at a
deployment by its addresses — a local anvil stack, or the stack this
repository's fork proof deploys onto a fork of Arc testnet:

```json
{
  "name": "arc-testnet-fork",
  "rpcUrl": "http://127.0.0.1:8545",
  "chainId": 5042002,
  "contracts": { "launchpad": "0x…", "tokenFactory": "0x…", "curveFactory": "0x…",
                 "migratorRegistry": "0x…", "platformRegistry": "0x…",
                 "arcnowPlatform": "0x…", "quoteRegistry": "0x…",
                 "v4Migrator": "0x…", "feeHook": "0x…", "v4Router": "0x…" },
  "v4": { "poolManager": "0x…" },
  "quoteTokens": [
    { "address": "0x0000000000000000000000000000000000000000", "symbol": "USDC", "name": "USD Coin", "decimals": 18, "isNative": true },
    { "address": "0x89b50855aa3be2f677cd6303cec089b5f319d72a", "symbol": "EURC", "name": "EURC", "decimals": 6, "isNative": false }
  ],
  "quoteAllowanceSlots": { "0x89b50855aa3be2f677cd6303cec089b5f319d72a": 10 }
}
```

It is validated by the SDK's own `resolveNetwork`: a missing required contract,
an invalid quote token or unreadable JSON stops the server at startup.
`quoteAllowanceSlots` may be numbers or decimal strings. `ARCNOW_RPC_URL` still
overrides the endpoint. Setting it together with `ARCNOW_MCP_NETWORK` or
`--network=` is an error, not a guess.

### Amounts are decimal strings

`"25"`, `"1.5"` — never JSON numbers. A JSON number is an IEEE double, and a
double cannot hold `0.000193050193050194` (the shipped curve's last price) or
any 18-decimal quantity above about nine million.

**Every amount is in the token's own quote, parsed exactly in that quote's
decimals.** `quoteIn`, `initialBuy` and `maxTotalCost` are read with the SDK's
`QuoteAmount.parse` in the decimals of the quote they are in — 18 for native
USDC, 6 for EURC — so `"1.0000001"` of EURC is refused, naming the decimals,
rather than rounded to an amount nobody typed. Nothing this server prints is a
bare number: money is always `123.75 USDC` or `1.5 EURC`, in the symbol of the
quote it is actually in.

**On Arc, native USDC is the gas currency, at 18 decimals.** The USDC ERC-20
predeploy is the same asset reporting 6; it pays for nothing and is not a quote
token. Gas is always native USDC, whatever a token's quote.

---

## The SDK, and how the pin works

`@arcnow/sdk` is published to npm from
[arcnow-io/arcnow-io-sdk](https://github.com/arcnow-io/arcnow-io-sdk), one tagged
release per version, and this server depends on it at an **exact version** —
`"@arcnow/sdk": "0.2.0"`, never `^0.2.0`. The tool descriptions promise what one
known SDK does; a range would let `npm install` move the code under them with no
commit here saying so. Moving the pin is a pull request.

[`pins.json`](pins.json) records it:

```json
"sdk": {
  "package": "@arcnow/sdk",
  "version": "0.2.0",
  "integrity": "sha512-…",
  "public_repo": "arcnow-io/arcnow-io-sdk",
  "tag": "v0.2.0",
  "why": ["what this server uses from that SDK, in prose"]
}
```

`integrity` is the sha512 of that version's tarball, as npm records it in
`package-lock.json` and serves it as `dist.integrity`. **The tarball is the
surface**: every module, the generated ABIs that encode every call, the
`networks.json` every address comes from — one hash. (Until the SDK was
published this file hashed its sources file by file and the gate recompiled its
`dist/`; the integrity replaces all of that.)

Before every release the maintainers verify that the manifest, the lockfile, the
installed package and the registry all name that one tarball; moving the pin is a
pull request that reads the SDK's changelog and re-reads every tool description.

---

## Testing

```bash
npm test     # the unit suite: no chain, no container, no key
```

It runs against a fake chain that does exactly what each test says, and proves
what can be proved offline:

- **A key is never an argument.** Every published schema is walked for
  credential-shaped field names and asserted strict; passing `privateKey` or
  `mnemonic` anyway is refused, named, answered with "rotate it", and sends
  nothing.
- **A write refuses without the opt-in**, names `--allow-writes` and
  `ARCNOW_PRIVATE_KEY`, and has sent nothing.
- **Both spend ceilings stop a transaction**, on a curve and in a pool, per
  quote token, on either preset — mainnet's EURC is capped by its mainnet
  address; a typo'd cap variable refuses to start; a USDC cap does not apply
  to EURC or the reverse.
- **Every amount is labelled with its own quote**, an input with more decimals
  than its quote is refused, and an ERC-20 approve is reported whether it was
  sent or not.
- **The gas trap is handled**, the venues are told apart (a stranded token is
  refused everywhere with `arcnow_migrate` named), the sell approval is never
  sent without `approveRouter: true` and never for more than the amount sold,
  and the reports say true things: a curve fee broken out four ways, a pool's
  0.80% and 0.20% read off the pool and never assumed, a free launch printed
  from the registry's zero, average fill price apart from spot, graduated apart
  from migrated.
- **Both presets resolve** to the SDK's live deployments, `arc-mainnet` says it
  is real money, and nothing of one network's addresses appears in a report
  about the other.
- **The wire works**: a real MCP client against a real MCP server over an
  in-memory transport.

What the unit suite cannot prove — that the built server, driven by a real MCP
client over stdio, lists the quote tokens, launches, buys and sells a token on its
curve and in its Uniswap v4 pool, and launches and buys a token priced in EURC
under the EURC cap, against arcnow.io's real contracts, every quote equal to its
fill to the wei — the maintainers prove before every release, on an anvil fork of
Arc testnet with those contracts deployed onto it. A fork re-executes with anvil's
EVM, so Arc's own execution semantics are outside even that; and no test can
prove that a tool description is true or that a model behaves — every guard here
is a bound on damage, not a guarantee of judgement.

---

## Licence

GPL-3.0-or-later, the same licence as `@arcnow/sdk`, which this server builds on. See [LICENSE](LICENSE).

> **This repository is a published mirror.** Every release of the arcnow.io MCP
> server lands here as one commit, tagged `vX.Y.Z`, with the `npm pack` tarball
> under [Releases](https://github.com/arcnow-io/arcnow-io-mcp/releases). Issues and pull requests are welcome
> here. The maintainers' tooling (the pin gate against the SDK's history, the
> fork proof against the contracts) is not part of the mirror, so `scripts/`
> referred to below is absent; `@arcnow/sdk` is a path dependency, so clone
> [arcnow-io/arcnow-io-sdk](https://github.com/arcnow-io/arcnow-io-sdk) as a
> sibling directory named `sdk` and build `sdk/typescript` first.
> Site: [www.arcnow.io](https://www.arcnow.io) - docs:
> [docs.arcnow.io](https://docs.arcnow.io).

# `@arcnow/mcp`

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant use
[arcnow.io](https://arcnow.io) on [Arc](https://docs.arc.io/): read the bonding
curves, quote a trade with its full fee breakdown — on a token's curve before it
graduates, or in its Uniswap v4 pool after — see how close a token is to
graduating, and, **only if the operator explicitly turns it on**, launch, buy,
sell and rescue a stranded migration.

Every chain interaction goes through
[`@arcnow/sdk`](https://github.com/arcnow-io/arcnow-io-sdk), pinned to a commit in
[`pins.json`](pins.json). Nothing here encodes a call or computes a curve.

```
node dist/index.js                  # read-only. The default, and the useful part.
node dist/index.js --allow-writes   # can spend, if ARCNOW_PRIVATE_KEY is in the environment.
```

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
| `arcnow_quote_tokens` | The quote tokens a launch may use — native USDC and the ERC-20s the quote registry allowlists, such as EURC — each with its symbol, name, decimals, address, whether it is native, its launch fee in its own units, whether the registry accepts it now, and **this server's spend cap for it**. At most three `eth_call`s. On a chain with no quote registry (the 2.x contracts Arc testnet ran until the multi-quote reset), it says so, shows the error, and lists the network's own quote-token metadata with nothing known to be accepted. |
| `arcnow_list_tokens` | Recent launches, newest first, from the launchpad's `Launched` log, back to the block it was deployed in. Reports the block window it actually covered — see [the SDK gap](#what-made-a-clean-surface-awkward). |
| `arcnow_token` | One token in full: metadata, **its quote token** (address, symbol, decimals, native or ERC-20), its curve's parameters (`r0Wad`, `y0Wad`), curve state, price, progress, and **where it trades now** — its curve, its v4 pool (with the router, whether it reaches the pool, the PoolManager, the pool's LP fee and what the fee hook holds accrued), or nowhere. Takes a token *or* a curve address. |
| `arcnow_quote_buy` | What an amount of the token's quote (`quoteIn`) would buy, wherever the token trades. On a curve: tokens out, the 1% fee and exactly who receives it, the average fill price, minimum-out floors at four tolerances. In a pool: a quote that says it is a pool quote, with arcnow.io's 1% and the pool's own LP fee apart, the average fill against the pool's spot price, and the price impact. |
| `arcnow_quote_sell` | The same for a sell — plus, on a curve, that selling needs no approval, ever, and in a pool, that it does, and how much the holder has approved already. |
| `arcnow_quote_launch` | What a launch in a given `quote` (native USDC by default, or an ERC-20 by symbol or address) would cost before anything is spent, split into the flat fee and the initial buy's own trade fee, with the predicted token and curve addresses. |
| `arcnow_platform` | A platform's fee split, its default migrator and its curve template — every share printed both as bps of the fee and as a percentage of a trade. |
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
  0.30% of a trade. Both are printed, every time.
- **Graduated and migrated are different states.** A curve can have stopped
  trading permanently while its pool was never created, and then the token
  trades *nowhere*. That is reported as its own thing, with the rescue named.
- **A pool quote is not a curve quote.** It says so, and it names two charges,
  not one: arcnow.io's 1%, taken in the pool's quote by the fee hook, and the pool's own
  Uniswap LP fee on top.

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
   `recipient`; a pool swap has no `referrer` or `developer` and cannot graduate
   anything, so `gasLimit` guards nothing there. Each is **refused** on the
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
| graduated **and** migrated | a pool quote, labelled as one | through arcnow.io's router; `gasLimit`, `referrer`, `developer` refused |
| graduated, **not** migrated | refused: tradeable nowhere until `migrate()` | refused, naming `arcnow_migrate` |

**What a pool quote contains.** The SDK prices a pool trade by simulating the
real swap through the router, so the figures are the real fill with two charges
inside them. The quote takes them back out and names each: arcnow.io's 1%, which
the fee hook takes in the pool's quote, and the pool's own LP fee — the pool key's `fee`, in
hundredths of a bip — which Uniswap charges on top. It shows the average fill
price, the pool's spot price, and the price impact between them. The SDK has no
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

### One curve

arcnow.io has one bonding curve — the constant-product curve,
`arcnow/bonding-curve@3.x.x`, priced in a quote token, with parameters `r0Wad`
(the virtual quote reserve at launch, in WAD) and `y0Wad` (the virtual token
reserve at launch) — launched through one contract stack, and a fee hook,
`arcnow/arc-now-fee-hook@3.x.x`, that
accrues each fee as a PoolManager claim and pays it out at the start of a later
swap.

- **Nothing a tool prints names a curve kind or a stack.** There is one of
  each. `arcnow_token` prints the curve's own parameters, and a pool trade
  reports the fees it paid out from earlier trades (`FeesDistributed`) apart
  from the trader's fill.
- **Any other version is refused by name, and never priced.** A curve or a
  platform of another version — the 2.x contracts Arc testnet ran until the
  multi-quote reset and the retired linear curve, `@1.x.x`, included —
  is the SDK's `UnknownCurveVersion`, naming the version, before any quote or
  send. A fee hook of another version is `UnknownHookVersion`, and its accrual
  is not read.
- **An address that is not a curve is refused by name.** The SDK's
  `AddressIsNotACurve` for an arcnow.io token's address is followed to its curve;
  for anything else — an ordinary ERC-20, an account, nothing at all — it is the
  refusal, saying the address is not an arcnow.io token either.
- **`arcnow_list_tokens` reads the one launchpad**, back to the block its stack
  was deployed in (61,911,405 on Arc testnet).

---

## Configuration

Everything is an environment variable, because an MCP client's config file is
where an operator's decisions belong. See
[`examples/`](examples) for a read-only and a writes-enabled client config.

| variable | default | what it does |
| --- | --- | --- |
| `ARCNOW_MCP_NETWORK` | `arc-testnet` | The network preset. `arc-mainnet` is **refused at startup, by name** — arcnow.io is not deployed to one, and this server will not invent an address. |
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
  digit is written `_`.

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

What counts: a launch spends its `totalCost` — the launch fee plus the initial
buy, in the launch's quote; a buy spends its `quoteIn`. For an ERC-20 quote the
SDK approves exactly that spend, so the same check covers the approve. The
caller's own `maxTotalCost` is read in the same quote. The startup banner,
`arcnow_network` and `arcnow_quote_tokens` show every cap, and
`describe()` reports `maxSpendPerCallUsdc` and `maxSpendPerCall`
(`{ "USDC": "100", "EURC": "50" }`, or `null` where none is set).

### A network the SDK has no preset for

`ARCNOW_MCP_NETWORK_FILE=/path/to/network.json` points the server at a
deployment by its addresses — a local anvil stack, or the 3.x stack this
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

`@arcnow/sdk` **is not published to npm.** `package.json` depends on it by
path — `file:../sdk/typescript` — so a checkout of
[`arcnow-io/sdk`](https://github.com/arcnow-io/arcnow-io-sdk) has to sit beside this one:

```
project/
  sdk/          git clone https://github.com/arcnow-io/arcnow-io-sdk.git sdk
  mcp/          this repository
```

npm **links** that directory into `node_modules`, which means "which SDK am I
running" is answered by whatever somebody happens to have checked out — a
branch, a rebase, an edit made five minutes ago. None of that fails loudly. The
server still compiles, the tool descriptions still promise what they promised,
and the call that reaches the chain is encoded by code this repository has never
seen.

So the SDK is pinned the way `arcnow-io/sdk` pins `arcnow-io/contracts`, and
`scripts/check-pins.sh` (run straight after the install by `scripts/preflight.sh`)
enforces five things:

0. `sdk.commit` is a **full 40-hex commit**, never a ref that resolves to
   whatever it names today.
1. `package.json` still depends on the SDK **by path**. A `file:` specifier that
   became a version range would resolve through the public registry, under a
   name nobody in this project has claimed.
2. `node_modules/@arcnow/sdk` really is that sibling directory — linked, not
   copied — carries the pinned version, and its `dist/` is **exactly what its
   sources compile to**. The gate compiles the SDK again, with the SDK's own
   TypeScript, into a temporary directory and compares every emitted file. This
   server imports `dist/`, not `src/`, so a `dist/` left over from an older
   checkout runs old code under new hashes — which is the state the sibling
   checkout was found in when the pin moved off `ac52eaa`, with no `dist/pool.js`
   at all, and the old gate passed it.
3. The sibling's **working tree** hashes to `surface_sha256`, with **no surface
   file unpinned**. The linked directory *is* the working tree, so an
   uncommitted edit — or an uncommitted new module — is code this server runs
   under no git ref at all.
4. The sibling repository has `sdk.commit`, **it is on `sdk.branch`**, and it
   carries exactly the pinned files with the pinned bytes — the only check that
   can see that the recorded hashes belong to the commit named. It also
   **reports, without failing**, when the SDK has moved past the pin and whether
   the surface changed on the way. A pin is supposed to lag.

Together: `dist/` is the compilation of the working tree, the working tree is the
pinned bytes, and the pinned bytes are the commit on the branch.

**What is pinned is a rule, not a list:** `networks.json`,
`typescript/package.json`, and every file under `typescript/src` except
`typescript/src/errors/`. A module the SDK adds is surface the moment it exists.
The generated ABIs are inside the rule because they encode every call, and the
generated `networks.json` because it is the copy the SDK compiles its
**addresses** from. `errors/` is outside it: message prose behind a surface
`index.ts` already pins, where pinning would make every improved error message
a false alarm. `test/unit/check-pins.test.ts` builds real repositories and
breaks each link on purpose — a stale build, an unpinned module, an uncommitted
edit, a ref for a commit, a commit off the branch.

Moving the pin is a commit of its own: check the SDK out at the commit and build
it, run `scripts/check-pins.sh --record` — which records `sdk.commit` and every
surface hash from `HEAD`, and refuses an edit no commit carries — update
`sdk.why`, run preflight, and say what changed in the SDK surface and what it
meant for the tools. A tool description that still promises what an older SDK
did is a model quoting a wrong price.

Point the gate at a checkout somewhere else with `ARCNOW_SDK_DIR`.

---

## Running the gates

```bash
./scripts/preflight.sh              # install, pins, lint, typecheck, build, tests, fork proof
./scripts/preflight.sh --no-install
./scripts/preflight.sh --no-chain   # everything but the fork proof
./scripts/check-pins.sh             # just the pin
npm test                            # just the unit suite — no chain, no container, no key
npm run test:fork                   # just the fork proof — needs Docker
```

`.github/workflows/ci.yml` is `workflow_dispatch:` only, the same decision every
repository in this org has made. **`scripts/preflight.sh` is the gate**; the
workflow is a transcription of it, kept because a clean-checkout run is the one
thing a local run cannot prove.

The fork proof starts one container, an anvil fork of Arc testnet from the
Foundry image `pins.json` pins, labelled `io.arcnow.mcp.test`, and deploys
arcnow.io's 3.x multi-quote contracts onto it with the pinned SDK's
`scripts/fork-deploy-stack.sh`. Arc testnet now runs a 3.x stack of its own,
deployed on 2026-09-15, but the fork is taken at a pinned, already-cached block
from before that, where the live contracts are the 2.x ones the SDK refuses — and
a proof that deploys its own stack does not depend on what happens to be live
anyway. That needs `ARCNOW_CONTRACTS_DIR`, a checkout
of arcnow-io/contracts at the commit the SDK's `pins.json` names, and forge at
the release it names. Its harness —
copied from `arcnow-io/sdk`'s, not imported, because that repository's tests are
not part of the pinned surface — removes it on every exit path, sweeps only its
own label, and touches nothing else on a shared daemon.

### What the tests prove

- **A key is never an argument.** Every published schema is walked for
  credential-shaped field names and for descriptions that ask for one; every
  schema is asserted strict; and passing `privateKey` or `mnemonic` anyway is
  asserted to be refused, named, answered with "rotate it", and to leave the
  port untouched.
- **A write refuses without the opt-in.** Every write tool, called on a
  read-only server, is asserted to error, to name `--allow-writes` and
  `ARCNOW_PRIVATE_KEY`, to tell the model not to ask a user for a key — and,
  the assertion that carries the weight, **to have sent nothing**.
- **Both spend ceilings stop a transaction rather than annotate one**, on a
  curve and in a pool alike, **per quote token**: a USDC-only configuration
  refuses a EURC buy and launch; an EURC cap allows up to it and refuses a raw
  unit above; a typo'd cap variable refuses to start; a USDC cap does not apply
  to EURC or the reverse; a quote the network does not list is refused.
- **Every amount is labelled with its own quote** — native, a 6-decimal and an
  18-decimal ERC-20 — a pool's quote is the SDK's in either currency order, an
  input with more decimals than its quote is refused, and an ERC-20 spend's
  approve is reported whether it was sent or not.
- **The gas trap is handled**, for a buy and for a launch whose initial buy
  graduates the curve.
- **The venues are told apart.** A migrated token is quoted and traded in its
  pool through `client.trade`; a stranded one is refused everywhere with
  `arcnow_migrate` named; a curve-only parameter in a pool and a pool-only one
  on a curve are refused with nothing sent.
- **The sell approval is gated and disclosed.** Never sent without
  `approveRouter: true`, never for more than the amount sold, not sent when the
  allowance already covers the sale, reported in full, and still reported when
  the sell after it fails.
- **The reports say true things.** Fees broken out, a pool's two charges apart,
  an absent referrer's share named as going to the platform, the average fill
  price distinguished from the spot price, graduated distinguished from
  migrated, an undecodable pool revert explained cautiously rather than bare.
- **The pin gate fails when it should.** See above.
- **The wire works.** A real MCP client against a real MCP server over an
  in-memory transport, and — in the fork proof — over stdio against the built
  server.
- **Against the 3.x contracts deployed onto a fork of Arc testnet**
  (`test/fork/mcp.fork.test.ts`), the built server — started with
  `ARCNOW_MCP_NETWORK_FILE` naming the deployed stack — driven by a real MCP
  client lists the quote tokens from the deployed registry in at most three
  `eth_call`s with each one's cap, launches a native USDC
  token on the launchpad, reads it
  back with its quote token, `r0Wad` and `y0Wad`, buys it on its curve,
  watches an impersonated Arc account graduate it, then quotes, buys and sells it
  in its Uniswap v4 pool through the live router — and sells a second token back
  to its curve — and launches a token in EURC, with its exact approve and exactly
  the total pulled, buys it in EURC, and has a buy above the 50 EURC cap refused
  with nothing sent. Every figure is checked against the chain with viem, not through
  the server: every quote equals its fill, to the wei; exactly the amount and
  the gas left the signer; the sell's approval is one `Approval` log to the
  router for exactly the amount sold, used up by the sale; the recipient is paid
  exactly what the report says; a swap's fee payout matches the hook's
  `FeesDistributed` log; the refusals leave the signer's nonce where it was; and
  the USDC ERC-20 predeploy comes back as `AddressIsNotACurve`. The server's RPC
  goes through a counting proxy, and the per-call request counts are printed.
- **One curve, and nothing else priced.** Against the fake, whose version
  checks are the SDK's own `assertCurveVersion` and `assertPlatformVersion`: no
  report names a curve kind or a stack, an `@1` curve, platform or fee hook is
  refused by name with nothing quoted or sent, and the launch scan reads the one
  launchpad from its deployment block.

### What they do not prove

- **Not Arc's own execution semantics.** A fork re-executes locally with
  anvil's EVM and disagrees with Arc about blocklisted transfers, EIP-1153, the
  EIP-7708 system emitter and burn-to-zero without saying so.
- **Not a EURC pool against a chain.** The fork proof launches a EURC token,
  buys it on its curve with the exact approve, and holds the 50 EURC cap; a
  EURC token's pool is unit-tested against the fake.
- **Not every path against a chain.** The fork proof covers a launch, curve
  trades, graduation and pool trades. A
  migration through `arcnow_migrate`, a graduating buy through `arcnow_buy` (the
  proof graduates its token through the SDK, so that nothing credits the
  server's signer), a token that graduated but never migrated — there is none on
  Arc testnet to fork — and a curve, platform or hook whose version the SDK
  refuses are
  unit-tested here against the fake, and proved against a chain, where they are
  at all, by the SDK's own fork suite. If you change how a tool calls the SDK,
  run the SDK's preflight too.
- **Not that the tool descriptions are true.** Those are prose, read by a model
  deciding whether to spend somebody's money. When the pin moves, that is a
  person's job.
- **Not that a model behaves.** Every guard in this server is a bound on
  damage, not a guarantee of judgement.

---

## What made a clean surface awkward

Five things, all worth fixing upstream rather than here — and one of them now is.

**The SDK cannot enumerate tokens.** There is no `recentLaunches()` anywhere in
`@arcnow/sdk`, and its `networks.json` explains why a preset cannot carry one: a
token and its curve come from the `Launched` log, one pair per launch, and there
are as many as there have been launches. But "show me the recent tokens" is the
first thing anybody asks an assistant, so `arcnow_list_tokens` reads that log
directly — with the SDK's own pinned ABI, through the SDK's own configured
client, at the SDK's own launchpad address, adding nothing but the scan. It is
the only place in this repository that talks to the chain outside an SDK method,
and it is in `src/sdk-port.ts` with a comment saying so. A
`launchpad.recentLaunches()` belongs in the SDK, where the forked-chain suite
could test it against a real chain; here it is tested against a fake.

Because the scan is a bounded walk backwards from the tip rather than an index,
`arcnow_list_tokens` reports the block window it covered and says plainly when
it stopped on its budget with history unread. An assistant must not conclude a
token does not exist from a tool that only ever saw a window.

**The SDK's handles are classes with private fields.** `Curve`, `Token`,
`Launchpad` and `PlatformRegistry` are nominally typed, so nothing can be
assigned to them — a test cannot construct a stand-in, and there is no seam to
substitute one. That is why `src/sdk-port.ts` exists: a set of interfaces the
SDK's handles already satisfy, wrapping nothing and computing nothing, so that a
fake can drive every tool through the states that matter and are hardest to
reach on a real chain (a buy that graduates, a curve that graduated and never
migrated, a cost that moved between the quote and the order). If the SDK exposed
interfaces alongside its classes, that file would be a re-export.

**The SDK has no reader for a pool's price.** A pool quote is the real fill, but
"how far is that from the pool's price" needs the pool's price, and there is no
`slot0`/`sqrtPriceX96` read anywhere in `@arcnow/sdk`. Reading the PoolManager's
storage here would be the second, unpinned copy of chain code this server exists
not to have. So the spot price is the SDK's own quote of a tiny probe buy with
both fees taken out — accurate to far below the printed digits, one extra
`eth_call`, and labelled as what it is. A `pool.spotPrice()` belongs in the SDK.
The pool's LP fee is likewise not in a quote; it is read from `pool.key()`.

**Fixed upstream: a revert inside the pool.** A revert from inside the fee hook,
or a failed transfer out of the PoolManager, arrives wrapped in Uniswap v4's
`WrappedError`. It used to surface as a bare `UnknownRevert`. Since sdk#7 the SDK
unwraps it and names the failed transfer (`NativeTransferFailed` /
`ERC20TransferFailed`), so this server only shows what the SDK decoded.

**A pool sell quote needs a real holder.** The SDK overrides the router
allowance for a sell simulation but deliberately not the balance, so
`arcnow_quote_sell` on a pool needs `holder` on a read-only server. That is the
right call, and it is why that argument exists.

Nothing else got in the way. In particular, the SDK's four amount types, its
refusal to default a slippage floor, its explicit `gasLimit`, its
`migratedInThisTransaction` flag and its by-selector error decoding are each the
reason a corresponding class of mistake is not reachable from here.

---

## Licence

GPL-3.0-or-later, the same licence as `@arcnow/sdk`, which this server builds on. See [LICENSE](LICENSE).

import { defineConfig } from "vitest/config";

/**
 * The whole suite, and it needs nothing: no chain, no container, no key.
 *
 * That is a deliberate property rather than a limitation. What this server has
 * to get right — that a key is never an argument, that a write refuses without
 * the operator's opt-in, that a stated cost ceiling is enforced before a
 * transaction is built, that an amount is never printed at the wrong scale — is
 * all decidable from the tool definitions and a fake chain. A suite that needed
 * a funded testnet key to prove "this server will not spend your money" would
 * be a suite nobody runs.
 *
 * What that leaves untested is written down in README.md under "What the tests
 * prove, and what they do not". The one thing a fake cannot show — that the
 * built server's pool path works against the real router and pool — is
 * `vitest.fork.config.ts`, run by `npm run test:fork` and by preflight.
 */
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});

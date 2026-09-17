// @ts-check
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

/**
 * The same lint-and-format-in-one-tool setup as `arcnow-io/sdk`, on purpose:
 * two repositories in one project that disagree about quote style produce
 * diffs made of nothing.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "eslint.config.mjs"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@stylistic": stylistic },
    rules: {
      ...stylistic.configs.customize({
        indent: 2,
        quotes: "double",
        semi: true,
        arrowParens: true,
        braceStyle: "1tbs",
      }).rules,
      "@stylistic/max-len": ["error", { code: 100, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true, ignoreComments: false }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "no-console": "off",
    },
  },
  {
    // Test scaffolding stands in for a chain, so it does things the library
    // never does: alias `this` into a returned handle, throw a non-Error to
    // prove the dispatcher survives one, and assert a shape it is deliberately
    // not building in full.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
);

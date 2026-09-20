// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", ".wrangler/**", "public/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "data/**/*.ts", "tests/**/*.ts"],
    rules: {
      // Underscore-prefixed args/vars are an intentional "intentionally
      // unused" convention used a few places in this codebase (e.g. the
      // scheduled() handler's unused ExecutionContext parameter).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  }
);

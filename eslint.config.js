import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";
export default [
  {
    ignores: [
      "dist/**",
      "artifacts/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.worker },
    },
  },
];

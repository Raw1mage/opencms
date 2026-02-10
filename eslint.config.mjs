import tseslint from "typescript-eslint"

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/.next/**",
      "**/build/**",
      "**/.sst/**",
      "**/tmp/**",
      "**/.wrangler/**",
      "**/.opencode/**",
      "refs/**",
      "sdks/vscode/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
]

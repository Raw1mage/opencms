import { defineConfig } from "vite"
import desktopPlugin from "./vite"

function manualChunks(id: string) {
  if (
    id.includes("/packages/app/src/context/language.tsx") ||
    id.includes("/packages/app/src/i18n/") ||
    id.includes("/packages/ui/src/i18n/")
  ) {
    return "app-i18n"
  }

  if (!id.includes("node_modules")) return

  if (id.includes("ghostty-web")) return "vendor-terminal"
  if (id.includes("marked") || id.includes("katex")) return "vendor-markdown"
  if (id.includes("solid-js") || id.includes("@solidjs") || id.includes("@kobalte")) return "vendor-solid"
  if (id.includes("zod") || id.includes("remeda") || id.includes("luxon") || id.includes("fuzzysort")) {
    return "vendor-utils"
  }
}

export default defineConfig({
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    // Keep warning signal useful after chunk-splitting: main entry is now <500kB gzip,
    // while a few intentionally lazy language/runtime chunks remain >500kB minified.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
    // sourcemap: true,
  },
})

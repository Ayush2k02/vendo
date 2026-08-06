import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "runs/**"],
    passWithNoTests: true,
    server: {
      deps: {
        // These SDKs import their own .css from JS; inline them so vite
        // transforms the css instead of node choking on the extension.
        // @vendoai/ui + its component internals (TanStack Table, recharts)
        // are inlined so they ride the react alias below — node-resolving
        // them loads a SECOND React copy and every Kit hook explodes when
        // the Kit renders inside the cockpit's own tree (vendo-kit-openui).
        inline: [
          /@thesysai\/genui-sdk/, /@crayonai\//, /@openuidev\//,
          /@vendoai\/ui/, /@tanstack\/react-table/, /recharts/,
        ],
      },
    },
  },
  resolve: {
    alias: {
      // Force one React instance across the cockpit and Vendo UI in jsdom.
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime"),
      // The Kit renders inside the cockpit's own React tree (vendo-kit-openui
      // wrappers), so @vendoai/ui must ride the SAME vite graph as the tests —
      // its dist node-resolves a second React copy and every Kit hook explodes.
      // Every subpath the bench imports is aliased explicitly: the bare key is
      // a PREFIX match, so without them "@vendoai/ui/tree" would rewrite to
      // ".../src/index.ts/tree" and fail to resolve.
      "@vendoai/ui/kit": path.resolve(__dirname, "../../packages/ui/src/kit/index.ts"),
      "@vendoai/ui/tree": path.resolve(__dirname, "../../packages/ui/src/tree/index.ts"),
      "@vendoai/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
    },
  },
})

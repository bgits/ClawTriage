import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(dashboardDir, "../..");
const isVitest = process.env.VITEST === "true";

export default defineConfig({
  plugins: [react()],
  envDir: isVitest ? dashboardDir : workspaceRoot,
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});

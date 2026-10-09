import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    ...(process.env.WASPADA_DEV_POLLING === "1" ? { watch: { usePolling: true, interval: 250 } } : {}),
    proxy: {
      "/api/v1": process.env.WASPADA_DEV_API_ORIGIN ?? "http://127.0.0.1:8787",
    },
  },
});

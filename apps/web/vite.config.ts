import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Edits from Windows on /mnt/d do not reliably emit WSL file events.
    watch: { usePolling: Boolean(process.env.WSL_DISTRO_NAME), interval: 300 },
    proxy: {
      "/api/v1": "http://127.0.0.1:8787",
    },
  },
});

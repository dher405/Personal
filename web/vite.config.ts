import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:4000" },
    // GitHub Codespaces serves the dev site from *.app.github.dev.
    allowedHosts: [".app.github.dev"],
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sponsorPlugin } from "./server/sponsor";

export default defineConfig({
  plugins: [react(), sponsorPlugin()],
  server: { port: 5174 },
});

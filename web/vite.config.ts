import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works from any static path.
  base: "./",
  build: {
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});

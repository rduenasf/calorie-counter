import { defineConfig } from "vite";

// Relative base so the build works from any sub-path (e.g. GitHub Pages).
// The Firebase SDK chunk (~620 kB, ~185 kB gzipped) is loaded lazily, only when sync is configured.
export default defineConfig({ base: "./", build: { chunkSizeWarningLimit: 700 } });

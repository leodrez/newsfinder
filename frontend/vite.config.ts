import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // frontend/package-lock.json makes this directory vite's workspace root, so
    // fs.allow defaults to it alone and the @shared imports from ../lib are
    // served 403 in dev. Widen it to the repo root.
    fs: { allow: [".."] },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Shared with the serverless functions in ../lib so unit conventions have one home.
      "@shared": path.resolve(__dirname, "../lib"),
    },
  },
})

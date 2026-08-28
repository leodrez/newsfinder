import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Shared with the serverless functions in ../lib so unit conventions have one home.
      "@shared": path.resolve(__dirname, "../lib"),
    },
  },
})

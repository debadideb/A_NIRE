import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  // Relative base so the built assets load no matter what path FastAPI serves
  // index.html from (StaticFiles(html=True) mounts it at "/").
  base: './',
  plugins: [
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Build straight into the repo's frontend/ dir, which app.py already serves as
  // static files (one process, one URL, no CORS). emptyOutDir wipes the old
  // vanilla mockup on each build — git history still has it.
  build: {
    outDir: path.resolve(__dirname, '../frontend'),
    emptyOutDir: true,
  },

  // Dev only: proxy the API to the FastAPI backend so `npm run dev` (port 5173)
  // talks to uvicorn on :8000 without CORS. Production has no proxy — same origin.
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})

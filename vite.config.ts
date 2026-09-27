import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['VITE_', 'NEXT_PUBLIC_'])
  const processEnvDefines: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    processEnvDefines[`process.env.${key}`] = JSON.stringify(value)
  }

  const isPublicPages = mode === 'public-pages'
  const isGitHubPages = mode === 'github-pages'

  return {
    // Electron loads dist/index.html via file://, so packaged assets must be
    // relative. Public Phone Sales is a GitHub Pages project site.
    base: isPublicPages
      ? '/Nexfix-POS-Public/'
      : isGitHubPages
        ? '/Nexfix-POS/'
        : './',
    plugins: [react(), tailwindcss()],
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: processEnvDefines,
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            charts: ['recharts'],
          },
        },
      },
    },
    server: { port: 5173, host: true },
    preview: { port: 4173, host: true },
  }
})

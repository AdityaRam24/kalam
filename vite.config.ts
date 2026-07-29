import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read .env with no prefix filter so the shell and .env agree on ports with
  // the scripts in scripts/ (shell env wins, exactly like the backend).
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }

  const apiPort = Number(env.PORT || 3001)
  const clientPort = Number(env.CLIENT_PORT || 5173)
  // The dev server binds where the backend binds unless told otherwise.
  const clientHost = env.CLIENT_HOST || env.HOST || 'localhost'

  return {
    plugins: [react()],
    server: {
      host: clientHost,
      port: clientPort,
      // Fail loudly instead of silently sliding to 5174: anything pointed at
      // 5173 would otherwise get "connect ECONNREFUSED ...:5173".
      strictPort: true,
      proxy: {
        '/api': {
          // 127.0.0.1, not "localhost": on Linux localhost often resolves to
          // ::1 first, and the backend binds IPv4 — that mismatch is refused.
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
          secure: false,
        }
      }
    }
  }
})

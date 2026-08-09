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

  // Vite rejects any request whose Host header it does not recognise, so
  // reaching the dev server through a cluster ingress needs that hostname
  // listed. A leading dot matches the domain and every subdomain, which covers
  // the per-service PCAI hostnames (kubeflow.*, mlis.*, ...) in one entry.
  // Override with a comma-separated CLIENT_ALLOWED_HOSTS; "true" allows any.
  const allowedHostsEnv = (env.CLIENT_ALLOWED_HOSTS || '').trim()
  const allowedHosts =
    allowedHostsEnv === 'true'
      ? true
      : allowedHostsEnv
        ? allowedHostsEnv.split(',').map((h) => h.trim()).filter(Boolean)
        : ['.pcaicoe.com', '.ext.hpe.com']

  // Behind a TLS ingress the browser loads the page from :443 but HMR would
  // still dial ws://<host>:5173 directly, which the ingress does not publish —
  // the page renders and then live reload is quietly dead. Setting
  // CLIENT_PUBLIC_HOST to the ingress hostname points the socket back through
  // the ingress instead. Unset (plain local dev) leaves Vite's defaults alone.
  const publicHost = (env.CLIENT_PUBLIC_HOST || '').trim()
  const hmr = publicHost
    ? {
        host: publicHost,
        protocol: env.CLIENT_HMR_PROTOCOL || 'wss',
        clientPort: Number(env.CLIENT_HMR_PORT || 443),
      }
    : undefined

  return {
    plugins: [react()],
    server: {
      host: clientHost,
      port: clientPort,
      allowedHosts,
      ...(hmr ? { hmr } : {}),
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
    },
    // `vite preview` runs the same host check, so it needs the same list.
    preview: {
      host: clientHost,
      port: clientPort,
      allowedHosts,
    }
  }
})

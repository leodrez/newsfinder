import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "./components/theme-provider.tsx"
import { AuthGate } from "./components/auth-gate.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <AuthGate>
        <App />
      </AuthGate>
    </ThemeProvider>
  </StrictMode>
)

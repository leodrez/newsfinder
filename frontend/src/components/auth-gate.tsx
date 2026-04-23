import { type FormEvent, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useAuth } from "@/hooks/use-auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface AuthGateProps {
  children: React.ReactNode
}

export function AuthGate({ children }: AuthGateProps) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!user) {
    return <LoginForm />
  }

  return <>{children}</>
}

function LoginForm() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold tracking-tight text-primary">NewsFinder</h1>
          <p className="text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            type="email"
            placeholder="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  )
}

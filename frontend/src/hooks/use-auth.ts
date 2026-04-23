import { useEffect, useState } from "react"
import type { Session, User } from "@supabase/supabase-js"
import { supabase } from "@/lib/supabase"

interface UseAuthReturn {
  user: User | null
  session: Session | null
  loading: boolean
  signOut: () => Promise<void>
}

export function useAuth(): UseAuthReturn {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return { user: session?.user ?? null, session, loading, signOut }
}

import { createClient } from '@supabase/supabase-js'

// Set by vite.config.ts from the Supabase integration's variables.
const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_KEY as string

export const supabaseConfigured = Boolean(url && key)

export const supabase = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
})

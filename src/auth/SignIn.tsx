import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../supabase'
import { Logo } from '../ui/Logo'

const RESEND_AFTER = 30

/**
 * Email sign-in: Supabase sends one email with both a link and a 6-digit code. The code is for when the link
 * opens in a different browser. The address field is kept generic so a phone number can be added later.
 */
export function SignIn({ error: initialError }: { error?: string }) {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [info, setInfo] = useState<string>()
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000))
  useEffect(() => {
    if (!wait) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [wait])

  const send = async (to: string, again = false) => {
    setBusy(true)
    setError(undefined)
    setInfo(undefined)
    const { error } = await supabase.auth.signInWithOtp({ email: to, options: { emailRedirectTo: window.location.origin } })
    setBusy(false)
    if (error) return setError(error.message)
    setSentTo(to)
    setResendAt(Date.now() + RESEND_AFTER * 1000)
    setNow(Date.now())
    if (again) setInfo('Sent a new email. Use the newest code.')
  }

  const verify = async () => {
    if (!sentTo) return
    setBusy(true)
    setError(undefined)
    setInfo(undefined)
    const { error } = await supabase.auth.verifyOtp({ email: sentTo, token: code.trim(), type: 'email' })
    setBusy(false)
    // On success the auth listener in AuthGate takes over.
    if (error) setError(/expired|invalid/i.test(error.message) ? 'That code is wrong or has expired.' : error.message)
  }

  const reset = () => {
    setSentTo(null)
    setCode('')
    setError(undefined)
    setInfo(undefined)
  }

  return (
    <SignInFrame>
      {!sentTo ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send(email.trim())
          }}
        >
          <h2>Sign in</h2>
          <p className="signin-help">We&rsquo;ll email you a sign-in link and a 6-digit code. No password needed.</p>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={busy || !email.trim()}>
            {busy ? 'Sending…' : 'Continue'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void verify()
          }}
        >
          <h2>Check your email</h2>
          <p className="signin-help">
            We sent a sign-in link and a code to <strong>{sentTo}</strong>. Open the link, or enter the code here.
          </p>
          <label className="field">
            <span>Code</span>
            <input
              className="signin-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <button className="primary" type="submit" disabled={busy || code.length < 6}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="signin-links">
            <button type="button" className="link" disabled={busy || wait > 0} onClick={() => void send(sentTo, true)}>
              {wait ? `Resend in ${wait}s` : 'Resend email'}
            </button>
            <button type="button" className="link" onClick={reset}>
              Use a different email
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="signin-message error" role="alert">
          {error}
        </p>
      )}
      {info && !error && <p className="signin-message">{info}</p>}
    </SignInFrame>
  )
}

/** The centred card with the app's name, shared by sign-in and the not-configured message. */
export function SignInFrame({ children, footer = true }: { children: ReactNode; footer?: boolean }) {
  return (
    <main className="signin-page">
      <div className="signin">
        <header className="signin-brand">
          <span className="signin-mark">
            <Logo size={22} />
          </span>
          <div>
            <h1>Training notebook</h1>
            <p>Running, cycling and incline training.</p>
          </div>
        </header>
        <div className="signin-card">{children}</div>
        {footer && <p className="signin-footer">New here? Signing in creates your account.</p>}
      </div>
    </main>
  )
}

import { useEffect, useState } from 'react'
import Logo from '../components/Logo'
import { getCurrentUser, logout, redirectToGoogleLogin } from '../lib/api'
import './AuthPage.css'

// The only screen in the app right now. On mount it asks the backend whether
// the browser already has a valid session cookie, then shows either the
// Google sign-in button or a "signed in" confirmation — this lets us test
// the whole OAuth loop (login, session check, logout) from the frontend.
function AuthPage() {
  const [user, setUser] = useState(null)
  // 'loading' | 'signed-out' | 'signed-in' | 'error'
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    getCurrentUser()
      .then((currentUser) => {
        if (currentUser) {
          setUser(currentUser)
          setStatus('signed-in')
        } else {
          setStatus('signed-out')
        }
      })
      .catch(() => setStatus('error'))
  }, [])

  async function handleLogout() {
    await logout()
    setUser(null)
    setStatus('signed-out')
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Logo size="large" />
        <p className="auth-tagline">See what your class actually understood.</p>

        {status === 'loading' && (
          <p className="auth-status">Checking your session…</p>
        )}

        {status === 'error' && (
          <p className="auth-status auth-status--error">
            Couldn't reach the server. Is the backend running?
          </p>
        )}

        {status === 'signed-out' && (
          <button
            className="google-button"
            type="button"
            onClick={redirectToGoogleLogin}
          >
            <GoogleIcon />
            Continue with Google
          </button>
        )}

        {status === 'signed-in' && user && (
          <div className="signed-in-panel">
            <p>
              Signed in as <strong>{user.google_id}</strong>
            </p>
            <button className="logout-button" type="button" onClick={handleLogout}>
              Log out
            </button>
          </div>
        )}
      </div>
    </main>
  )
}

// Google's official multi-color "G" mark, inlined as SVG so the sign-in
// button doesn't need an extra image request.
function GoogleIcon() {
  return (
    <svg className="google-icon" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.61z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"
      />
    </svg>
  )
}

export default AuthPage

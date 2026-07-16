import { useEffect, useRef, useState } from 'react'
import Logo from '../components/Logo'
import { redirectToGoogleLogin } from '../lib/api'
import './AuthPage.css'

// The marketing/landing page shown before sign-in — App.jsx only renders this
// when there's no active session. Structured like a typical product landing
// page (nav -> hero -> features -> demo video -> closing CTA -> footer),
// with the demo section and closing CTA fading in as the user scrolls to them.
function AuthPage() {
  // 'checking' | 'ok' | 'error' — purely informational; doesn't block the page
  const [serverStatus, setServerStatus] = useState('checking')
  // null while unknown, then true/false once we've checked whether a demo
  // video file has actually been dropped in client/public/demo.mp4
  const [videoAvailable, setVideoAvailable] = useState(null)

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:8000'}/health`)
      .then((res) => setServerStatus(res.ok ? 'ok' : 'error'))
      .catch(() => setServerStatus('error'))
  }, [])

  useEffect(() => {
    fetch('/demo.mp4', { method: 'HEAD' })
      .then((res) => setVideoAvailable(res.ok))
      .catch(() => setVideoAvailable(false))
  }, [])

  return (
    <div className="landing">
      <nav className="landing-nav">
        <Logo size="small" />
        <button className="google-button google-button--nav" type="button" onClick={redirectToGoogleLogin}>
          <GoogleIcon />
          Sign in
        </button>
      </nav>

      <header className="landing-hero">
        <h1 className="landing-hero-title">See what your class actually understood.</h1>
        <p className="landing-hero-subtitle">
          Signal connects to Google Classroom, reads every submission your students turn in,
          and turns them into a clear report of what to reteach — before the next lesson.
        </p>

        {serverStatus === 'error' && (
          <p className="auth-status auth-status--error">
            Couldn't reach the server. Is the backend running?
          </p>
        )}

        <button className="google-button google-button--hero" type="button" onClick={redirectToGoogleLogin}>
          <GoogleIcon />
          Continue with Google
        </button>
      </header>

      <section className="landing-features">
        <FeatureCard
          icon="🔄"
          title="Syncs with Classroom"
          text="Connect your Google account once. Signal pulls in your classes, assignments, and every student submission automatically."
        />
        <FeatureCard
          icon="🧠"
          title="AI confusion reports"
          text="Every submission in an assignment is analyzed together to surface the misconceptions that showed up across the whole class."
        />
        <FeatureCard
          icon="✅"
          title="Built for action"
          text="Get concrete next steps for your next class — grounded in the rubric and learning goals you already provided."
        />
      </section>

      <Reveal className="landing-demo">
        <h2>See it in action</h2>
        <p>A quick look at importing an assignment and generating a confusion report.</p>
        <div className="demo-frame">
          {videoAvailable ? (
            <video className="demo-video" controls src="/demo.mp4" />
          ) : (
            <div className="demo-placeholder">
              <span className="demo-play" aria-hidden="true">▶</span>
              <p>Demo video coming soon</p>
            </div>
          )}
        </div>
      </Reveal>

      <Reveal className="landing-cta">
        <h2>Ready to see your class clearly?</h2>
        <button className="google-button google-button--hero" type="button" onClick={redirectToGoogleLogin}>
          <GoogleIcon />
          Continue with Google
        </button>
      </Reveal>

      <footer className="landing-footer">
        <Logo size="small" />
        <p className="landing-footer-text">Signal for teachers</p>
      </footer>
    </div>
  )
}

// Fades a section up into view the first time it scrolls into the viewport.
function Reveal({ children, className = '' }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.2 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <section ref={ref} className={`reveal ${visible ? 'reveal--visible' : ''} ${className}`}>
      {children}
    </section>
  )
}

function FeatureCard({ icon, title, text }) {
  return (
    <div className="feature-card">
      <span className="feature-icon" aria-hidden="true">{icon}</span>
      <h3 className="feature-title">{title}</h3>
      <p className="feature-text">{text}</p>
    </div>
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

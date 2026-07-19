import './Logo.css'

// Signal's wordmark. The "i"'s stem is a real dotless-i character (ı) so it
// sits on the baseline exactly like the rest of the word in whatever font is
// active — only the dot above it is a separate span, positioned absolutely so
// it can pulse independently like an active signal/status indicator.
function Logo({ size = 'medium' }) {
  return (
    <div className={`logo logo--${size}`} aria-label="Signal">
      <span aria-hidden="true">s</span>
      <span className="logo-i" aria-hidden="true">
        <span className="logo-i-dot" />
        ı
      </span>
      <span aria-hidden="true">gnal</span>
    </div>
  )
}

export default Logo

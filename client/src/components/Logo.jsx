import './Logo.css'

// Signal's wordmark. The "i" is built from two small divs (a stem + a dot)
// instead of being part of the plain text, so the dot can be animated on its
// own — it pulses like an active signal/status indicator.
function Logo({ size = 'medium' }) {
  return (
    <div className={`logo logo--${size}`} aria-label="Signal">
      <span aria-hidden="true">s</span>
      <span className="logo-i" aria-hidden="true">
        <span className="logo-i-dot" />
        <span className="logo-i-stem" />
      </span>
      <span aria-hidden="true">gnal</span>
    </div>
  )
}

export default Logo

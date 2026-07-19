import Sidebar from './Sidebar'
import Logo from './Logo'
import './AppShell.css'

// Persistent chrome shown on every screen once logged in: a left sidebar
// (Home/Account) and a top bar with the Signal logo and a "Hi, {name}" greeting
// in place of the old per-page Log out button (logout now lives on the Account page).
function AppShell({ active, displayName, onHome, onAccount, children }) {
  return (
    <div className="app-shell">
      <Sidebar active={active} onHome={onHome} onAccount={onAccount} />
      <div className="app-shell-content">
        <header className="app-topbar">
          <Logo size="medium" />
          <span className="app-topbar-greeting">Hi, {displayName || 'there'}</span>
        </header>
        {children}
      </div>
    </div>
  )
}

export default AppShell

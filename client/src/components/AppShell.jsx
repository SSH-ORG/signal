import { useState } from 'react'
import Sidebar from './Sidebar'
import Logo from './Logo'
import Icon from './Icon'
import './AppShell.css'

// Persistent chrome shown on every screen once logged in: a left sidebar
// (Home/Account/Help) and a top bar with the Signal logo and a "Hi, {name}"
// greeting in place of the old per-page Log out button (logout now lives on
// the Account page).
// The top bar always spans the full width, so the menu button and logo never
// move. The sidebar starts closed and opens underneath the top bar, pushing
// the main content over rather than the whole page.
function AppShell({ active, displayName, onHome, onReports, onAccount, onHelp, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  function toggleSidebar() {
    setSidebarOpen((open) => !open)
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <button
            type="button"
            className="app-icon-btn"
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
          >
            <Icon name="menu" className="app-menu-icon" />
          </button>
          <button type="button" className="app-logo-btn" aria-label="Go to homepage" onClick={onHome}>
            <Logo size="medium" />
          </button>
        </div>
        <span className="app-topbar-greeting">Hi, {displayName || 'there'}</span>
      </header>
      <div className={`app-body${sidebarOpen ? ' app-body--sidebar-open' : ''}`}>
        {sidebarOpen && (
          <Sidebar
            active={active}
            onHome={onHome}
            onReports={onReports}
            onAccount={onAccount}
            onHelp={onHelp}
          />
        )}
        <div className="app-shell-content">{children}</div>
      </div>
    </div>
  )
}

export default AppShell

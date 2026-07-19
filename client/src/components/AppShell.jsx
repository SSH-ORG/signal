import { useState } from 'react'
import Sidebar from './Sidebar'
import Logo from './Logo'
import Icon from './Icon'
import './AppShell.css'

// Persistent chrome shown on every screen once logged in: a left sidebar
// (Home/Account) and a top bar with the Signal logo and a "Hi, {name}" greeting
// in place of the old per-page Log out button (logout now lives on the Account page).
// The sidebar starts closed — only the menu icon opens/closes it.
function AppShell({ active, displayName, onHome, onAccount, onHelp, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  function toggleSidebar() {
    setSidebarOpen((open) => !open)
  }

  return (
    <div className="app-shell">
      {sidebarOpen && <Sidebar active={active} onHome={onHome} onAccount={onAccount} onHelp={onHelp} />}
      <div className="app-shell-content">
        <header className="app-topbar">
          <div className="app-topbar-left">
            <button
              type="button"
              className="app-icon-btn"
              aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              onClick={toggleSidebar}
            >
              <Icon name="menu" className="app-menu-icon" />
            </button>
            <Logo size="medium" />
          </div>
          <span className="app-topbar-greeting">Hi, {displayName || 'there'}</span>
        </header>
        {children}
      </div>
    </div>
  )
}

export default AppShell

import './Sidebar.css'

// Persistent left-hand navigation, visible on every screen once logged in.
// Kept to just Home + Account — the courses screen already lists classes,
// so there's no need to duplicate that list here the way Classroom's sidebar does.
function Sidebar({ active, onHome, onAccount }) {
  return (
    <nav className="sidebar" aria-label="Main">
      <button
        type="button"
        className={`sidebar-item${active === 'home' ? ' sidebar-item--active' : ''}`}
        onClick={onHome}
      >
        <HomeIcon />
        <span>Home</span>
      </button>

      <button
        type="button"
        className={`sidebar-item${active === 'account' ? ' sidebar-item--active' : ''}`}
        onClick={onAccount}
      >
        <AccountIcon />
        <span>Account</span>
      </button>
    </nav>
  )
}

function HomeIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 3l9 8h-3v9h-5v-6H11v6H6v-9H3z" />
    </svg>
  )
}

function AccountIcon() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 12c2.7 0 4.9-2.2 4.9-4.9S14.7 2.2 12 2.2 7.1 4.4 7.1 7.1 9.3 12 12 12zm0 2.4c-3.3 0-9.8 1.6-9.8 4.9v2.5h19.6v-2.5c0-3.3-6.5-4.9-9.8-4.9z"
      />
    </svg>
  )
}

export default Sidebar

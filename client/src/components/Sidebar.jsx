import Icon from './Icon'
import './Sidebar.css'

// Persistent left-hand navigation, visible on every screen once logged in.
// Kept to just Home, Account, and Help — the courses screen already lists
// classes, so there's no need to duplicate that list here the way
// Classroom's sidebar does.
function Sidebar({ active, onHome, onAccount, onHelp }) {
  return (
    <nav className="sidebar" aria-label="Main">
      <button
        type="button"
        className={`sidebar-item${active === 'home' ? ' sidebar-item--active' : ''}`}
        onClick={onHome}
      >
        <Icon name="home" className="sidebar-icon" />
        <span>Home</span>
      </button>

      <button
        type="button"
        className={`sidebar-item${active === 'account' ? ' sidebar-item--active' : ''}`}
        onClick={onAccount}
      >
        <Icon name="account_circle" className="sidebar-icon" />
        <span>Account</span>
      </button>

      <button
        type="button"
        className={`sidebar-item${active === 'help' ? ' sidebar-item--active' : ''}`}
        onClick={onHelp}
      >
        <Icon name="help" className="sidebar-icon" />
        <span>Help</span>
      </button>
    </nav>
  )
}

export default Sidebar

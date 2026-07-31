import { useState } from 'react'
import { updateProfile, deleteAccount, logout } from '../lib/api'
import { getTheme, setTheme } from '../lib/theme.js'
import './Screens.css'
import './AccountPage.css'

// Account management screen, reached via the sidebar. Lets the teacher edit
// their name/email, toggle email notification preference, log out, or
// permanently delete their account.
function AccountPage({ user, onProfileUpdated, onLoggedOut }) {
  const [displayName, setDisplayName] = useState(user.display_name || '')
  const [email, setEmail] = useState(user.email || '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState(null)
  const [profileSaved, setProfileSaved] = useState(false)

  const [theme, setThemeState] = useState(getTheme)

  const [emailEnabled, setEmailEnabled] = useState(!!user.email_notifications_enabled)
  const [notificationPref, setNotificationPref] = useState(user.notification_preference || 'daily')
  const [savingNotifications, setSavingNotifications] = useState(false)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  async function handleSaveProfile(e) {
    e.preventDefault()
    setSavingProfile(true)
    setProfileError(null)
    setProfileSaved(false)
    try {
      const updated = await updateProfile({ display_name: displayName, email })
      onProfileUpdated(updated)
      setProfileSaved(true)
    } catch (err) {
      setProfileError(err.message)
    } finally {
      setSavingProfile(false)
    }
  }

  function handleSetTheme(t) {
    setTheme(t)
    setThemeState(t)
  }

  async function handleToggleEmailEnabled() {
    const prev = emailEnabled
    const next = !prev
    setEmailEnabled(next)
    setSavingNotifications(true)
    try {
      const updated = await updateProfile({ email_notifications_enabled: next })
      onProfileUpdated(updated)
    } catch {
      setEmailEnabled(prev)
    } finally {
      setSavingNotifications(false)
    }
  }

  async function handleSetNotificationPref(pref) {
    const prev = notificationPref
    setNotificationPref(pref)
    setSavingNotifications(true)
    try {
      const updated = await updateProfile({ notification_preference: pref })
      onProfileUpdated(updated)
    } catch {
      setNotificationPref(prev)
    } finally {
      setSavingNotifications(false)
    }
  }

  async function handleLogout() {
    await logout()
    onLoggedOut()
  }

  async function handleDeleteAccount() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteAccount()
      onLoggedOut()
    } catch (err) {
      setDeleteError(err.message)
      setDeleting(false)
    }
  }

  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <h1 className="screen-title">account</h1>
          <p className="screen-subtitle">manage your profile and preferences</p>
        </div>

        <section className="detail-section">
          <h2 className="detail-section-title">Profile</h2>
          <form className="account-form" onSubmit={handleSaveProfile}>
            <label className="account-field">
              <span>Name</span>
              <input
                type="text"
                className="account-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
              />
            </label>
            <label className="account-field">
              <span>Email</span>
              <input
                type="email"
                className="account-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            {profileError && <p className="screen-status screen-status--error">{profileError}</p>}
            {profileSaved && <p className="account-saved">Saved</p>}

            <div className="detail-actions">
              <button type="submit" className="primary-btn" disabled={savingProfile}>
                {savingProfile ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </section>

        <section className="detail-section" id="notifications">
          <h2 className="detail-section-title">Email Notifications</h2>
          <div className="account-notif-toggle-row">
            <div>
              <span className="account-notif-label">Email me a summary</span>
              <p className="detail-section-hint">Emailed once reports are ready to be built or already are built.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={emailEnabled}
              className={`account-toggle${emailEnabled ? ' account-toggle--on' : ''}`}
              onClick={handleToggleEmailEnabled}
              disabled={savingNotifications}
            >
              <span className="account-toggle-knob" />
            </button>
          </div>

          {emailEnabled && (
            <div className="account-notif-options">
              {[
                { value: 'daily', label: 'Each day', hint: 'All reports from the past 24 hours' },
                { value: 'weekly', label: 'Each week', hint: 'All reports from the past week, emailed each Monday' },
              ].map(({ value, label, hint }) => (
                <label
                  key={value}
                  className={`account-notif-option${notificationPref === value ? ' account-notif-option--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="notification-cadence"
                    className="account-notif-radio"
                    checked={notificationPref === value}
                    onChange={() => handleSetNotificationPref(value)}
                    disabled={savingNotifications}
                  />
                  <span>
                    <span className="account-notif-label">{label}</span>
                    <span className="account-notif-hint">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>

        <section className="detail-section">
          <h2 className="detail-section-title">Appearance</h2>
          <p className="detail-section-hint">Choose how Signal looks. System follows your device setting.</p>
          <div className="theme-picker">
            {['system', 'light', 'dark'].map((t) => (
              <button
                key={t}
                type="button"
                className={`theme-btn${theme === t ? ' theme-btn--active' : ''}`}
                onClick={() => handleSetTheme(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </section>

        <section className="detail-section">
          <h2 className="detail-section-title">Account</h2>
          <div className="detail-actions">
            <button type="button" className="secondary-btn" onClick={handleLogout}>Log out</button>

            {!confirmingDelete && (
              <button
                type="button"
                className="account-delete-btn"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete account
              </button>
            )}
          </div>

          {confirmingDelete && (
            <div className="account-delete-confirm">
              <p>
                This permanently deletes your account and all synced assignments, submissions,
                and reports. This can&apos;t be undone.
              </p>
              {deleteError && <p className="screen-status screen-status--error">{deleteError}</p>}
              <div className="detail-actions">
                <button
                  type="button"
                  className="account-delete-btn"
                  onClick={handleDeleteAccount}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Yes, delete my account'}
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default AccountPage

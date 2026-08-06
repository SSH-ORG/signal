import { useState } from 'react'
import { updateProfile, deleteAccount, logout } from '../lib/api'
import { getTheme, setTheme } from '../lib/theme.js'
import './Screens.css'
import './AccountPage.css'

// Strips everything but digits, then any leading zeros — used on the
// submission-threshold stepper's text input so typing never shows something
// like "08"; a plain type="number" input leaves that up to the browser,
// which isn't consistent across them.
function sanitizeDigits(raw) {
  return raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '')
}

const MIN_IMMEDIATE_SUBMISSIONS = 5
const MAX_IMMEDIATE_SUBMISSIONS = 50

function clampMinSubmissions(value) {
  return Math.min(MAX_IMMEDIATE_SUBMISSIONS, Math.max(MIN_IMMEDIATE_SUBMISSIONS, value || MIN_IMMEDIATE_SUBMISSIONS))
}

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

  // Independent of the reminder-digest settings above — a separate beta feature,
  // see handleImmediateToggleClick for why enabling it goes through a modal first
  const [immediateEnabled, setImmediateEnabled] = useState(!!user.immediate_reports_enabled)
  const [immediateMinSubmissions, setImmediateMinSubmissions] = useState(String(user.immediate_min_submissions || 5))
  const [savingImmediate, setSavingImmediate] = useState(false)
  const [showImmediateModal, setShowImmediateModal] = useState(false)

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

  // Turning it on opens the walkthrough modal first (constraints + threshold
  // setup) since this fires without any review step — turning it back off
  // needs no such confirmation, so that goes straight through.
  function handleImmediateToggleClick() {
    if (immediateEnabled) {
      handleDisableImmediate()
    } else {
      setShowImmediateModal(true)
    }
  }

  async function handleDisableImmediate() {
    const prev = immediateEnabled
    setImmediateEnabled(false)
    setSavingImmediate(true)
    try {
      const updated = await updateProfile({ immediate_reports_enabled: false })
      onProfileUpdated(updated)
    } catch {
      setImmediateEnabled(prev)
    } finally {
      setSavingImmediate(false)
    }
  }

  async function handleEnableImmediate(minSubmissions) {
    setSavingImmediate(true)
    try {
      const updated = await updateProfile({
        immediate_reports_enabled: true,
        immediate_min_submissions: minSubmissions,
      })
      onProfileUpdated(updated)
      setImmediateEnabled(true)
      setImmediateMinSubmissions(String(updated.immediate_min_submissions || minSubmissions))
      setShowImmediateModal(false)
    } finally {
      setSavingImmediate(false)
    }
  }

  async function handleUpdateImmediateMinSubmissions(value) {
    const prev = immediateMinSubmissions
    setImmediateMinSubmissions(String(value))
    setSavingImmediate(true)
    try {
      const updated = await updateProfile({ immediate_min_submissions: value })
      onProfileUpdated(updated)
      setImmediateMinSubmissions(String(updated.immediate_min_submissions || value))
    } catch {
      setImmediateMinSubmissions(prev)
    } finally {
      setSavingImmediate(false)
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
              <p className="detail-section-hint">This name is used on emails sent to students.</p>
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
                {savingProfile ? 'Saving ..' : 'Save changes'}
              </button>
            </div>
          </form>
        </section>

        <section className="detail-section" id="notifications">
          <div className="account-notif-header-row">
            <h2 className="detail-section-title">Email Notifications</h2>
            <button
              type="button"
              role="switch"
              aria-checked={emailEnabled}
              aria-label="Email notifications"
              className={`account-toggle${emailEnabled ? ' account-toggle--on' : ''}`}
              onClick={handleToggleEmailEnabled}
              disabled={savingNotifications}
            >
              <span className="account-toggle-knob" />
            </button>
          </div>
          <p className="detail-section-hint">
            Email me once assignments reach their due date or have enough submissions to build a report.
          </p>

          {emailEnabled && (
            <div className="account-notif-toggle-group">
              {[
                { value: 'daily', label: 'Each day' },
                { value: 'weekly', label: 'Each week' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`account-notif-toggle-btn${notificationPref === value ? ' account-notif-toggle-btn--active' : ''}`}
                  onClick={() => handleSetNotificationPref(value)}
                  disabled={savingNotifications}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="detail-section" id="immediate-notifications">
          <div className="account-notif-header-row">
            <h2 className="detail-section-title">
              Auto-Send <span className="account-beta-badge">Beta</span>
            </h2>
            <button
              type="button"
              role="switch"
              aria-checked={immediateEnabled}
              aria-label="Auto-Send"
              className={`account-toggle${immediateEnabled ? ' account-toggle--on' : ''}`}
              onClick={handleImmediateToggleClick}
              disabled={savingImmediate}
            >
              <span className="account-toggle-knob" />
            </button>
          </div>
          <p className="detail-section-hint">
            Automatically builds and emails a class-wide report the moment an assignment is due
            and has enough submissions, instead of just reminding you to build it.
          </p>

          {immediateEnabled && (
            <div className="account-immediate-settings">
              {/* A plain div, not a <label> — a label wrapping more than one
                  interactive control (two buttons + an input, here) makes
                  browsers forward stray clicks in its empty space to one of
                  the nested controls, which read as "clicking whitespace
                  changes the count." */}
              <div className="account-field account-field--inline">
                <span>
                  Signal sets a minimum of 5 submissions before auto-building, you can edit this
                  based on your class size.
                </span>
                <div className="account-stepper">
                  <button
                    type="button"
                    className="account-stepper-btn account-stepper-btn--minus"
                    aria-label="Decrease minimum submissions"
                    onClick={() => handleUpdateImmediateMinSubmissions(
                      clampMinSubmissions((Number(immediateMinSubmissions) || 5) - 1),
                    )}
                    disabled={savingImmediate || Number(immediateMinSubmissions) <= MIN_IMMEDIATE_SUBMISSIONS}
                  >
                    &minus;
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className="account-stepper-input"
                    value={immediateMinSubmissions}
                    onChange={(e) => setImmediateMinSubmissions(sanitizeDigits(e.target.value))}
                    onBlur={(e) => handleUpdateImmediateMinSubmissions(clampMinSubmissions(Number(e.target.value)))}
                    disabled={savingImmediate}
                  />
                  <button
                    type="button"
                    className="account-stepper-btn account-stepper-btn--plus"
                    aria-label="Increase minimum submissions"
                    onClick={() => handleUpdateImmediateMinSubmissions(
                      clampMinSubmissions((Number(immediateMinSubmissions) || 5) + 1),
                    )}
                    disabled={savingImmediate || Number(immediateMinSubmissions) >= MAX_IMMEDIATE_SUBMISSIONS}
                  >
                    +
                  </button>
                </div>
              </div>
              {Number(immediateMinSubmissions) < MIN_IMMEDIATE_SUBMISSIONS && (
                <p className="detail-section-hint detail-section-hint--warning">
                  Minimum is 5 submissions.
                </p>
              )}
              {Number(immediateMinSubmissions) > MAX_IMMEDIATE_SUBMISSIONS && (
                <p className="detail-section-hint detail-section-hint--warning">
                  Max 50 submissions.
                </p>
              )}
              <p className="detail-section-hint">
                This only covers class-wide reports. Per-student reports and nudges need to be
                built in Signal.
              </p>
              <p className="detail-section-hint detail-section-hint--warning">
                Signal only syncs the assignment description automatically from Classroom. You
                can either add a Mental Model and rubric to your assignment description, or input
                these manually beforehand for a more accurate report. There&apos;s no review
                before it&apos;s emailed.
              </p>
              <p className="detail-section-hint">
                Only assignments due in the past 7 days are considered, and each one is only ever
                auto-sent once. Building a report yourself first (or after) won&apos;t trigger a
                duplicate email.
              </p>
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
                  {deleting ? 'Deleting ..' : 'Yes, delete my account'}
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

      {showImmediateModal && (
        <ImmediateModal
          initialMinSubmissions={immediateMinSubmissions}
          saving={savingImmediate}
          onCancel={() => setShowImmediateModal(false)}
          onConfirm={handleEnableImmediate}
        />
      )}
    </div>
  )
}

// Walkthrough gate shown the moment a teacher turns Auto-Send on — covers
// what it does, what it doesn't, what affects report quality, and lets them
// set their submission threshold, all in one place, since the goal is that a
// teacher shouldn't need to come back here again after enabling it.
function ImmediateModal({ initialMinSubmissions, saving, onCancel, onConfirm }) {
  const [minSubmissions, setMinSubmissions] = useState(String(initialMinSubmissions || 5))
  const belowFloor = Number(minSubmissions) < MIN_IMMEDIATE_SUBMISSIONS
  const aboveCeiling = Number(minSubmissions) > MAX_IMMEDIATE_SUBMISSIONS

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" aria-label="Close" onClick={onCancel}>
          &times;
        </button>
        <h2 className="modal-title">
          Turn on Auto-Send <span className="account-beta-badge">Beta</span>
        </h2>
        <p className="modal-text">
          Once an assignment is due and has enough submissions, Signal automatically builds and
          emails you its class-wide report. There is no need to open the app and do it manually!
        </p>
        <p className="modal-text">
          This only covers <strong>class-wide</strong> reports. Per-student reports and nudges
          need to be built in Signal.
        </p>
        <p className="modal-text">
          Signal only syncs the assignment description automatically from Classroom. You can
          either add a Mental Model and rubric to your assignment description, or input these
          manually beforehand for a more accurate report. There's no review before it's emailed.
        </p>
        <p className="modal-text">
          Only assignments due in the past 7 days are considered, and each one is only ever
          auto-sent once. Building a report yourself first (or after) won't trigger a duplicate
          email.
        </p>
        {/* A plain div, not a <label> — see the matching comment on the
            inline settings version of this stepper for why. */}
        <div className="account-field">
          <span>
            Signal sets a minimum of 5 submissions before auto-building, you can edit this based
            on your class size.
          </span>
          <div className="account-stepper">
            <button
              type="button"
              className="account-stepper-btn account-stepper-btn--minus"
              aria-label="Decrease minimum submissions"
              onClick={() => setMinSubmissions(String(clampMinSubmissions((Number(minSubmissions) || 5) - 1)))}
              disabled={Number(minSubmissions) <= MIN_IMMEDIATE_SUBMISSIONS}
            >
              &minus;
            </button>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="account-stepper-input"
              value={minSubmissions}
              onChange={(e) => setMinSubmissions(sanitizeDigits(e.target.value))}
            />
            <button
              type="button"
              className="account-stepper-btn account-stepper-btn--plus"
              aria-label="Increase minimum submissions"
              onClick={() => setMinSubmissions(String(clampMinSubmissions((Number(minSubmissions) || 5) + 1)))}
              disabled={Number(minSubmissions) >= MAX_IMMEDIATE_SUBMISSIONS}
            >
              +
            </button>
          </div>
        </div>
        {belowFloor && (
          <p className="detail-section-hint detail-section-hint--warning">Minimum is 5 submissions.</p>
        )}
        {aboveCeiling && (
          <p className="detail-section-hint detail-section-hint--warning">Max 50 submissions.</p>
        )}
        <div className="detail-actions">
          <button
            type="button"
            className="primary-btn"
            onClick={() => onConfirm(clampMinSubmissions(Number(minSubmissions)))}
            disabled={saving || belowFloor || aboveCeiling}
          >
            {saving ? 'Enabling ..' : 'Enable Auto-Send'}
          </button>
          <button type="button" className="secondary-btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export default AccountPage

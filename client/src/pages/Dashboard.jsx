import { useEffect, useState } from 'react'
import Logo from '../components/Logo'
import { logout, getGoogleCoursework, importCoursework, getImportedCoursework } from '../lib/api'
import './Dashboard.css'

// Main dashboard — shown after the teacher logs in
// Left panel: assignments pulled live from Google Classroom (not yet imported)
// Right panel: assignments already imported into Signal with submission counts
function Dashboard({ user, onLogout }) {
  const [gcAssignments, setGcAssignments] = useState([])   // Live from Google Classroom
  const [imported, setImported] = useState([])              // Stored in our database
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(null)          // Tracks which assignment is being imported
  const [error, setError] = useState(null)

  // Load both lists when the dashboard mounts
  useEffect(() => {
    async function load() {
      try {
        const [gc, imp] = await Promise.all([
          getGoogleCoursework(),
          getImportedCoursework(),
        ])
        setGcAssignments(gc)
        setImported(imp)
      } catch {
        setError('Failed to load assignments. Make sure the server is running.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Import a Google Classroom assignment into Signal
  async function handleImport(assignment) {
    setImporting(assignment.google_coursework_id)
    try {
      await importCoursework(assignment.google_coursework_id, assignment.course_id)
      // Refresh the imported list to show the newly added assignment
      const updated = await getImportedCoursework()
      setImported(updated)
    } catch (err) {
      alert(err.message)
    } finally {
      setImporting(null)
    }
  }

  async function handleLogout() {
    await logout()
    onLogout()
  }

  // Check if an assignment has already been imported so we can disable its button
  const importedIds = new Set(imported.map((cw) => cw.google_coursework_id))

  return (
    <div className="dashboard">
      {/* Top navigation bar */}
      <header className="dashboard-header">
        <Logo size="medium" />
        <button className="logout-button" onClick={handleLogout}>
          Log out
        </button>
      </header>

      <main className="dashboard-main">
        {loading && <p className="dashboard-status">Loading your assignments…</p>}
        {error && <p className="dashboard-status dashboard-status--error">{error}</p>}

        {!loading && !error && (
          <div className="dashboard-grid">

            {/* Left panel — Google Classroom assignments available to import */}
            <section className="dashboard-panel">
              <h2 className="panel-title">Google Classroom</h2>
              <p className="panel-subtitle">Select an assignment to import into Signal</p>

              {gcAssignments.length === 0 ? (
                <p className="empty-state">No assignments found in your Google Classroom.</p>
              ) : (
                <ul className="assignment-list">
                  {gcAssignments.map((assignment) => {
                    const alreadyImported = importedIds.has(assignment.google_coursework_id)
                    const isImporting = importing === assignment.google_coursework_id

                    return (
                      <li key={assignment.google_coursework_id} className="assignment-card">
                        <div className="assignment-info">
                          <span className="assignment-title">{assignment.title}</span>
                          <span className="assignment-course">{assignment.course_name}</span>
                        </div>
                        <button
                          className="import-button"
                          onClick={() => handleImport(assignment)}
                          disabled={alreadyImported || isImporting}
                        >
                          {alreadyImported ? 'Imported' : isImporting ? 'Importing…' : 'Import'}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {/* Right panel — assignments already imported into Signal */}
            <section className="dashboard-panel">
              <h2 className="panel-title">Imported Assignments</h2>
              <p className="panel-subtitle">Assignments ready for AI report generation</p>

              {imported.length === 0 ? (
                <p className="empty-state">No assignments imported yet. Import one from Google Classroom.</p>
              ) : (
                <ul className="assignment-list">
                  {imported.map((cw) => (
                    <li key={cw.coursework_id} className="assignment-card">
                      <div className="assignment-info">
                        <span className="assignment-title">{cw.title}</span>
                        <span className="assignment-course">
                          {cw.submission_count} {cw.submission_count === 1 ? 'submission' : 'submissions'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

          </div>
        )}
      </main>
    </div>
  )
}

export default Dashboard

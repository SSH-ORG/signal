import { useEffect, useState, useMemo } from 'react'
import Logo from '../components/Logo'
import { logout, getGoogleCoursework, importCoursework, getImportedCoursework } from '../lib/api'
import './Dashboard.css'

// Main dashboard shown after login
// Left panel: browse Google Classroom by class → click to see assignments → import them
// Right panel: assignments already imported into Signal, grouped by class
function Dashboard({ user, onLogout }) {
  const [gcAssignments, setGcAssignments] = useState([])    // Live from Google Classroom (flat list)
  const [imported, setImported] = useState([])              // Stored in our database
  const [selectedCourseId, setSelectedCourseId] = useState(null) // Which class is open in left panel
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(null)          // google_coursework_id being imported
  const [error, setError] = useState(null)

  // Load both lists on mount
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

  // Derive unique classes from the flat GC assignments list
  const courses = useMemo(() => {
    const seen = new Set()
    return gcAssignments
      .filter((a) => {
        if (seen.has(a.course_id)) return false
        seen.add(a.course_id)
        return true
      })
      .map((a) => ({ course_id: a.course_id, course_name: a.course_name }))
  }, [gcAssignments])

  // Assignments belonging to the currently selected class
  const selectedCourseAssignments = useMemo(() => {
    if (!selectedCourseId) return []
    return gcAssignments.filter((a) => a.course_id === selectedCourseId)
  }, [gcAssignments, selectedCourseId])

  // Group imported assignments by class name using the GC data as a lookup
  const importedByCourse = useMemo(() => {
    const grouped = {}
    for (const cw of imported) {
      const match = gcAssignments.find((a) => a.google_coursework_id === cw.google_coursework_id)
      const courseName = match?.course_name || 'Other'
      if (!grouped[courseName]) grouped[courseName] = []
      grouped[courseName].push(cw)
    }
    return grouped
  }, [imported, gcAssignments])

  // Set of already-imported google_coursework_ids so we can show Sync vs Import
  const importedIds = useMemo(
    () => new Set(imported.map((cw) => cw.google_coursework_id)),
    [imported]
  )

  async function handleImport(assignment) {
    setImporting(assignment.google_coursework_id)
    try {
      await importCoursework(assignment.google_coursework_id, assignment.course_id)
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

  const selectedCourseName = courses.find((c) => c.course_id === selectedCourseId)?.course_name

  return (
    <div className="dashboard">
      {/* Top navigation bar */}
      <header className="dashboard-header">
        <Logo size="medium" />
        <button className="logout-btn" onClick={handleLogout}>Log out</button>
      </header>

      <main className="dashboard-main">
        {loading && <p className="dashboard-status">Loading your assignments…</p>}
        {error && <p className="dashboard-status dashboard-status--error">{error}</p>}

        {!loading && !error && (
          <div className="dashboard-grid">

            {/* LEFT PANEL — Google Classroom browser */}
            <section className="panel">
              <div className="panel-header">
                {selectedCourseId ? (
                  // Show breadcrumb and back button when inside a class
                  <div className="panel-breadcrumb">
                    <button className="back-btn" onClick={() => setSelectedCourseId(null)}>
                      ← Classes
                    </button>
                    <span className="panel-title">{selectedCourseName}</span>
                  </div>
                ) : (
                  <div>
                    <h2 className="panel-title">Google Classroom</h2>
                    <p className="panel-subtitle">Select a class to view its assignments</p>
                  </div>
                )}
              </div>

              {/* Class list view */}
              {!selectedCourseId && (
                courses.length === 0 ? (
                  <p className="empty-state">No classes found in your Google Classroom.</p>
                ) : (
                  <ul className="item-list">
                    {courses.map((course) => {
                      // Count how many assignments in this class are already imported
                      const total = gcAssignments.filter((a) => a.course_id === course.course_id).length
                      const importedCount = gcAssignments
                        .filter((a) => a.course_id === course.course_id && importedIds.has(a.google_coursework_id))
                        .length

                      return (
                        <li key={course.course_id}>
                          <button
                            className="course-card"
                            onClick={() => setSelectedCourseId(course.course_id)}
                          >
                            <div className="course-info">
                              <span className="course-name">{course.course_name}</span>
                              <span className="course-meta">{total} assignment{total !== 1 ? 's' : ''}</span>
                            </div>
                            <div className="course-badges">
                              {importedCount > 0 && (
                                <span className="badge">{importedCount} imported</span>
                              )}
                              <span className="chevron">›</span>
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )
              )}

              {/* Assignment list view (inside a class) */}
              {selectedCourseId && (
                selectedCourseAssignments.length === 0 ? (
                  <p className="empty-state">No assignments in this class.</p>
                ) : (
                  <ul className="item-list">
                    {selectedCourseAssignments.map((assignment) => {
                      const alreadyImported = importedIds.has(assignment.google_coursework_id)
                      const isImporting = importing === assignment.google_coursework_id

                      return (
                        <li key={assignment.google_coursework_id} className="assignment-row">
                          <span className="assignment-title">{assignment.title}</span>
                          <button
                            className={`action-btn ${alreadyImported ? 'action-btn--sync' : 'action-btn--import'}`}
                            onClick={() => handleImport(assignment)}
                            disabled={isImporting}
                          >
                            {isImporting ? 'Syncing…' : alreadyImported ? 'Sync' : 'Import'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )
              )}
            </section>

            {/* RIGHT PANEL — Imported assignments grouped by class */}
            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">Imported Assignments</h2>
                <p className="panel-subtitle">Ready for AI report generation</p>
              </div>

              {imported.length === 0 ? (
                <p className="empty-state">No assignments imported yet.</p>
              ) : (
                Object.entries(importedByCourse).map(([courseName, assignments]) => (
                  <div key={courseName} className="imported-group">
                    <h3 className="group-title">{courseName}</h3>
                    <ul className="item-list">
                      {assignments.map((cw) => (
                        <li key={cw.coursework_id} className="assignment-row assignment-row--imported">
                          <div className="assignment-info">
                            <span className="assignment-title">{cw.title}</span>
                            <span className="assignment-meta">
                              {cw.submission_count} {cw.submission_count === 1 ? 'submission' : 'submissions'}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </section>

          </div>
        )}
      </main>
    </div>
  )
}

export default Dashboard

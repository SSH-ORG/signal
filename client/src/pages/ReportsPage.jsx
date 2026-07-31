import { useEffect, useMemo, useState } from 'react'
import { getAllReports, deleteReport } from '../lib/api'
import { loadStoredCourseColors, getCourseColor } from '../lib/courseColors'
import Icon from '../components/Icon'
import './Screens.css'
import './ReportsPage.css'

// Landing view is a class-card grid (like Courses) — each card shows only a
// report count, deliberately no flagged-student signal at this level. Clicking
// a card drills into that class's own reports: title-searchable, sorted by
// build date. Opening an assignment itself hands off to the Assignment Detail
// screen (same one reachable from Courses) rather than duplicating that view
// here — Email Report already lives one click away on that screen's AI Report
// tab, so this page's own job is just Delete, the one action that doesn't.
function ReportsPage({ onViewAssignment, onGoToClasses }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [selectedClass, setSelectedClass] = useState(null) // course_name, or null for the class-card grid
  const [search, setSearch] = useState('') // assignment-title search, scoped to the selected class

  const [deleteFeedback, setDeleteFeedback] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  // Read fresh on every mount (i.e. every time this screen is navigated to),
  // so a color changed on the Courses screen shows up here without needing a
  // full page reload — switching screens already unmounts/remounts this page
  const [courseColors] = useState(loadStoredCourseColors)

  useEffect(() => {
    getAllReports()
      .then(setReports)
      .catch(() => setError('Failed to load reports.'))
      .finally(() => setLoading(false))
  }, [])

  // One card per class that has at least one report. course_id is whichever
  // google_course_id shows up first for that class name, used to look up the
  // same custom color set on the Courses screen.
  const classes = useMemo(() => {
    const byName = new Map()
    reports.forEach(r => {
      const name = r.course_name || 'Archived Class'
      if (!byName.has(name)) byName.set(name, { course_name: name, course_id: r.google_course_id })
      const entry = byName.get(name)
      if (!entry.course_id && r.google_course_id) entry.course_id = r.google_course_id
    })
    return Array.from(byName.values())
  }, [reports])

  // Reports for the selected class — title-searched, always sorted by report
  // build date (most recent first). Not a toggle — this is the one sort that matters here.
  const classReports = useMemo(() => {
    if (!selectedClass) return []
    const q = search.trim().toLowerCase()
    return reports
      .filter(r => (r.course_name || 'Archived Class') === selectedClass)
      .filter(r => !q || r.title.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [reports, selectedClass, search])

  function handleSelectClass(courseName) {
    setSelectedClass(courseName)
    setSearch('')
  }

  function handleBackToClasses() {
    setSelectedClass(null)
  }

  async function handleDeleteReport(courseworkId) {
    if (!window.confirm('Are you sure? This action cannot be undone. You have the option to rebuild later.')) return
    setDeletingId(courseworkId)
    setDeleteFeedback(null)
    try {
      await deleteReport(courseworkId)
      setReports(prev => prev.filter(r => r.coursework_id !== courseworkId))
    } catch (err) {
      setDeleteFeedback({ coursework_id: courseworkId, message: err.message })
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) return (
    <div className="screen">
      <main className="screen-main"><p className="screen-status">Loading reports…</p></main>
    </div>
  )

  if (error) return (
    <div className="screen">
      <main className="screen-main"><p className="screen-status screen-status--error">{error}</p></main>
    </div>
  )

  return (
    <div className="screen">
      <main className="screen-main screen-main--wide">
        {!selectedClass ? (
          <>
            <div>
              <h1 className="screen-title">reports</h1>
              <p className="screen-subtitle">choose a class</p>
            </div>

            {classes.length === 0 ? (
              <p className="empty-state">
                No reports built yet.
                <button type="button" className="reports-empty-icon-btn" onClick={onGoToClasses}>
                  <Icon name="arrow_forward" />
                </button>
              </p>
            ) : (
              <div className="course-grid">
                {classes.map((c, i) => {
                  const color = getCourseColor(c.course_id, i, courseColors)
                  return (
                    <div key={c.course_name} className="course-card" style={{ '--course-color': color }}>
                      <button
                        type="button"
                        className="course-card-main"
                        onClick={() => handleSelectClass(c.course_name)}
                      >
                        <div className="course-card-banner" style={{ background: color }}>
                          <span className="course-card-name">{c.course_name}</span>
                        </div>
                        <div className="course-card-body" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <button className="back-btn" onClick={handleBackToClasses}>← reports</button>
            </div>
            <div>
              <h1 className="screen-title">{selectedClass}</h1>
              <p className="screen-subtitle">
                {classReports.length} report{classReports.length !== 1 ? 's' : ''}
              </p>
            </div>

            <div className="coursework-controls">
              <input
                type="text"
                className="search-input"
                placeholder="Search assignment titles…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                aria-label="Search assignment titles"
              />
            </div>

            {classReports.length === 0 ? (
              <p className="empty-state">No reports match your search.</p>
            ) : (
              <ul className="item-list">
                {classReports.map(report => (
                  <li key={report.report_id}>
                    <div className="item-card reports-item-card">
                      <button
                        type="button"
                        className="reports-item-main"
                        onClick={() => onViewAssignment(report.coursework_id)}
                      >
                        <div className="item-info">
                          <span className="item-name">{report.title}</span>
                          <span className="item-meta">
                            {new Date(report.created_at).toLocaleDateString('en-US', {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })}
                            {' · '}
                            {report.total_submissions} student{report.total_submissions !== 1 ? 's' : ''}
                            {report.flagged_count > 0 && (
                              <span className="reports-flagged-badge">{report.flagged_count} flagged</span>
                            )}
                          </span>
                        </div>
                        <span className="chevron">›</span>
                      </button>
                      <button
                        type="button"
                        className="reports-delete-btn"
                        aria-label={`Delete ${report.title} report`}
                        onClick={() => handleDeleteReport(report.coursework_id)}
                        disabled={deletingId === report.coursework_id}
                      >
                        <Icon name="delete" />
                      </button>
                    </div>

                    {deleteFeedback?.coursework_id === report.coursework_id && (
                      <p className="reports-email-status">{deleteFeedback.message}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default ReportsPage

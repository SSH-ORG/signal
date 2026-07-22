import { useEffect, useMemo, useState } from 'react'
import { getAllReports, emailReport, deleteReport } from '../lib/api'
import Icon from '../components/Icon'
import './Screens.css'
import './ReportsPage.css'

// Global Reports page — reached via the sidebar Reports item
// Lists all assignments that have a generated AI report, optionally filtered by class or time
// Clicking a report opens that assignment's detail page
function ReportsPage({ gcAssignments, onViewAssignment, onGoToAssignments, onGoToClasses }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [classFilter, setClassFilter] = useState('all') // 'all' or a course_name
  const [timeFilter, setTimeFilter] = useState('all')   // 'all' | '7days' | '30days'

  const [emailingId, setEmailingId] = useState(null)
  const [emailFeedback, setEmailFeedback] = useState(null) // { coursework_id, message, isError }
  const [deletingId, setDeletingId] = useState(null)

  async function handleEmailReport(courseworkId) {
    setEmailingId(courseworkId)
    setEmailFeedback(null)
    try {
      await emailReport(courseworkId)
      setEmailFeedback({ coursework_id: courseworkId, message: 'Sent to your email', isError: false })
    } catch (err) {
      setEmailFeedback({ coursework_id: courseworkId, message: err.message, isError: true })
    } finally {
      setEmailingId(null)
    }
  }

  async function handleDeleteReport(courseworkId) {
    if (!window.confirm('Delete this report? You can regenerate it anytime.')) return
    setDeletingId(courseworkId)
    try {
      await deleteReport(courseworkId)
      setReports((prev) => prev.filter((r) => r.coursework_id !== courseworkId))
    } catch (err) {
      setEmailFeedback({ coursework_id: courseworkId, message: err.message, isError: true })
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    getAllReports()
      .then(setReports)
      .catch(() => setError('Failed to load reports.'))
      .finally(() => setLoading(false))
  }, [])

  // Every class the teacher has — not just ones with reports — so picking a
  // report-less class from the filter still shows a real empty state for it
  const classes = useMemo(() => {
    const seen = new Set()
    return gcAssignments
      .filter((a) => {
        if (seen.has(a.course_id)) return false
        seen.add(a.course_id)
        return true
      })
      .map((a) => ({ course_id: a.course_id, course_name: a.course_name }))
  }, [gcAssignments])

  const filteredReports = reports.filter((r) => {
    if (classFilter !== 'all' && (r.course_name || 'Archived Class') !== classFilter) return false
    if (timeFilter !== 'all') {
      const days = timeFilter === '7days' ? 7 : 30
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - days)
      if (new Date(r.created_at) < cutoff) return false
    }
    return true
  })

  // Group reports by course name — course_name is stored in DB at import time
  // so it's available even for archived courses
  const grouped = filteredReports.reduce((acc, report) => {
    const courseName = report.course_name || 'Archived Class'
    if (!acc[courseName]) acc[courseName] = []
    acc[courseName].push(report)
    return acc
  }, {})

  // Only known when a specific class (not "All Classes") is selected — lets the
  // empty state link straight into that class's assignment list
  const selectedClass = classes.find((c) => c.course_name === classFilter)

  // Empty state copy + destination differ depending on whether a class is selected —
  // the text stays plain either way, only the arrow icon next to it is clickable
  const emptyState = selectedClass
    ? {
      text: 'No reports yet. Choose an assignment to get started.',
      ariaLabel: `Go to ${selectedClass.course_name} assignments`,
      onClick: () => onGoToAssignments(selectedClass.course_id, selectedClass.course_name),
    }
    : {
      text: 'No reports yet. Choose a class to get started.',
      ariaLabel: 'Go to classes',
      onClick: onGoToClasses,
    }

  return (
    <div className="screen">
      <main className="screen-main">
        <div className="reports-header">
          <div>
            <h1 className="screen-title">Reports</h1>
            <p className="screen-subtitle">
              {classFilter === 'all' ? 'Reports across all classes' : `Reports across ${classFilter}`}
            </p>
          </div>

          <div className="reports-filters">
            <label className="reports-filter">
              Time
              <span className="reports-filter-select-wrap">
                <select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value)}>
                  <option value="all">All time</option>
                  <option value="7days">Last 7 days</option>
                  <option value="30days">Last 30 days</option>
                </select>
                <Icon name="expand_more" className="reports-filter-chevron" />
              </span>
            </label>

            {classes.length > 0 && (
              <label className="reports-filter">
                Class
                <span className="reports-filter-select-wrap">
                  <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                    <option value="all">All classes</option>
                    {classes.map((c) => (
                      <option key={c.course_id} value={c.course_name}>{c.course_name}</option>
                    ))}
                  </select>
                  <Icon name="expand_more" className="reports-filter-chevron" />
                </span>
              </label>
            )}
          </div>
        </div>

        {loading && <p className="screen-status">Loading reports…</p>}
        {error && <p className="screen-status screen-status--error">{error}</p>}

        {!loading && !error && filteredReports.length === 0 && (
          <p className="screen-status">
            {emptyState.text}
            <button
              type="button"
              className="reports-empty-icon-btn"
              aria-label={emptyState.ariaLabel}
              onClick={emptyState.onClick}
            >
              <Icon name="arrow_forward" />
            </button>
          </p>
        )}

        {!loading && !error && Object.entries(grouped).map(([courseName, courseReports]) => (
          <div key={courseName} className="reports-group">
            <h2 className="reports-group-title">{courseName}</h2>
            <ul className="item-list">
              {courseReports.map((report) => (
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
                          Built {new Date(report.created_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                          })}
                        </span>
                      </div>
                      <span className="chevron">›</span>
                    </button>
                    <button
                      type="button"
                      className="reports-email-btn"
                      aria-label={`Email ${report.title} report`}
                      onClick={() => handleEmailReport(report.coursework_id)}
                      disabled={emailingId === report.coursework_id}
                    >
                      <Icon name="mail" />
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
                  {emailFeedback?.coursework_id === report.coursework_id && (
                    <p className={`reports-email-status${emailFeedback.isError ? ' reports-email-status--error' : ''}`}>
                      {emailFeedback.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </main>
    </div>
  )
}

export default ReportsPage

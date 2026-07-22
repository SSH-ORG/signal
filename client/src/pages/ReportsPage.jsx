import { useEffect, useMemo, useState } from 'react'
import { getAllReports, getReport, getSubmissions, emailReport, deleteReport } from '../lib/api'
import Icon from '../components/Icon'
import ReportBody from '../components/ReportBody'
import './Screens.css'
import './ReportsPage.css'

// Global Reports page — reached via the sidebar Reports item
// Lists all assignments that have a generated AI report, optionally filtered by class or time
// Click a card to expand the classwide report + individual student reports inline
function ReportsPage({ gcAssignments, onViewAssignment, onGoToAssignments, onGoToClasses }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [classFilter, setClassFilter] = useState('all') // 'all' or a course_name
  const [timeFilter, setTimeFilter] = useState('all')   // 'all' | '7days' | '30days'

  const [emailingId, setEmailingId] = useState(null)
  const [emailFeedback, setEmailFeedback] = useState(null) // { coursework_id, message, isError }
  const [deletingId, setDeletingId] = useState(null)

  // expandedId: which card is open
  // reportContents: { [coursework_id]: { content, loading, error } }
  // submissionsCache: { [coursework_id]: submission[] }
  const [expandedId, setExpandedId] = useState(null)
  const [reportContents, setReportContents] = useState({})
  const [submissionsCache, setSubmissionsCache] = useState({})

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

  // Toggle the inline report expansion.
  // Fetches classwide report content + submissions list the first time a card is opened.
  async function handleExpand(courseworkId) {
    if (expandedId === courseworkId) {
      setExpandedId(null)
      return
    }
    setExpandedId(courseworkId)

    // Fetch classwide report if not cached
    if (!reportContents[courseworkId]) {
      setReportContents((prev) => ({ ...prev, [courseworkId]: { loading: true } }))
      try {
        const data = await getReport(courseworkId)
        setReportContents((prev) => ({ ...prev, [courseworkId]: { content: data?.content } }))
      } catch {
        setReportContents((prev) => ({ ...prev, [courseworkId]: { error: 'Failed to load report.' } }))
      }
    }

    // Fetch submissions (with individual reports) if not cached
    if (!submissionsCache[courseworkId]) {
      try {
        const subs = await getSubmissions(courseworkId)
        setSubmissionsCache((prev) => ({ ...prev, [courseworkId]: subs }))
      } catch {
        setSubmissionsCache((prev) => ({ ...prev, [courseworkId]: [] }))
      }
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
              {classFilter === 'all' ? 'reports across all classes' : `reports across ${classFilter}`}
              {timeFilter !== 'all' && ` from the last ${timeFilter === '7days' ? '7' : '30'} days`}
            </p>
          </div>

          <div className="reports-filters">
            <label className="reports-filter">
              Time
              <span className="reports-filter-select-wrap">
                <select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value)}>
                  <option value="all">ALL</option>
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
                    <option value="all">ALL</option>
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
              {courseReports.map((report) => {
                const isExpanded = expandedId === report.coursework_id
                const cached = reportContents[report.coursework_id]
                return (
                  <li key={report.report_id}>
                    <div className={`item-card reports-item-card${isExpanded ? ' reports-item-card--expanded' : ''}`}>
                      {/* Main clickable row — expands/collapses the report inline */}
                      <button
                        type="button"
                        className="reports-item-main"
                        onClick={() => handleExpand(report.coursework_id)}
                      >
                        <div className="item-info">
                          <span className="item-name">{report.title}</span>
                          <span className="item-meta">
                            Built {new Date(report.created_at).toLocaleDateString('en-US', {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })}
                            {report.flagged_count > 0 && (
                              <span className="reports-flagged-badge">
                                {report.flagged_count} flagged
                              </span>
                            )}
                          </span>
                        </div>
                        <span className="chevron">{isExpanded ? '∨' : '›'}</span>
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

                    {/* Inline expanded view — classwide report + individual student history */}
                    {isExpanded && (
                      <div className="reports-expanded">
                        {/* ── Classwide Report ── */}
                        {cached?.loading && <p className="screen-status">Loading report…</p>}
                        {cached?.error && <p className="screen-status screen-status--error">{cached.error}</p>}
                        {cached?.content && <ReportBody content={cached.content} />}

                        {/* ── Individual Reports ── */}
                        {(() => {
                          const subs = submissionsCache[report.coursework_id] || []
                          const withReports = subs.filter((s) => s.individual_report)
                          if (subs.length === 0) return null
                          return (
                            <div className="reports-individual-section">
                              <h3 className="reports-individual-heading">
                                Individual Reports
                                {withReports.length > 0 && (
                                  <span className="reports-individual-count">
                                    {withReports.length} / {subs.length}
                                  </span>
                                )}
                              </h3>
                              {withReports.length === 0 ? (
                                <p className="screen-status">
                                  No individual reports generated yet.{' '}
                                  <button
                                    type="button"
                                    className="reports-link-btn"
                                    onClick={() => onViewAssignment(report.coursework_id)}
                                  >
                                    Open assignment to generate →
                                  </button>
                                </p>
                              ) : (
                                <div className="reports-individual-list">
                                  {subs.map((sub, i) => {
                                    const flagLevel = getReportFlagLevel(sub.individual_report)
                                    return (
                                      <div
                                        key={sub.submission_id}
                                        className={`reports-individual-card${flagLevel && flagLevel !== 'on-track' ? ' reports-individual-card--flagged' : ''}`}
                                      >
                                        <div className="reports-individual-card-header">
                                          <span className="reports-individual-name">
                                            {sub.student_name || `Student ${i + 1}`}
                                          </span>
                                          {flagLevel && (
                                            <span className={`flag-badge flag-badge--${flagLevel}`}>
                                              {flagLevel === 'misconception' && 'Misconception'}
                                              {flagLevel === 'partial' && 'Partial'}
                                              {flagLevel === 'no-engagement' && 'No response'}
                                              {flagLevel === 'on-track' && 'On track'}
                                            </span>
                                          )}
                                        </div>
                                        {sub.individual_report
                                          ? <ReportBody content={sub.individual_report} />
                                          : <p className="reports-individual-empty">No report generated yet.</p>
                                        }
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })()}

                        <div className="reports-expanded-footer">
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => onViewAssignment(report.coursework_id)}
                          >
                            Open Assignment
                          </button>
                        </div>
                      </div>
                    )}

                    {emailFeedback?.coursework_id === report.coursework_id && (
                      <p className={`reports-email-status${emailFeedback.isError ? ' reports-email-status--error' : ''}`}>
                        {emailFeedback.message}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </main>
    </div>
  )
}

// Mirrors AssignmentDetailPage's getFlagLevel — supports old and new prompt formats
function getReportFlagLevel(individualReport) {
  if (!individualReport) return null
  if (individualReport.includes('No engagement')) return 'no-engagement'
  if (individualReport.includes('Misconception present')) return 'misconception'
  if (individualReport.includes('Partial understanding')) return 'partial'
  if (individualReport.includes('Demonstrates understanding')) return 'on-track'
  if (
    individualReport.includes('Submission was blank') ||
    individualReport.includes('Submission too short') ||
    individualReport.includes('Submission did not address')
  ) return 'no-engagement'
  if (individualReport.includes('No misconceptions detected')) return 'on-track'
  if (individualReport.includes('Misconceptions Detected')) return 'misconception'
  return 'on-track'
}

export default ReportsPage

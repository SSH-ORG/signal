import { useEffect, useMemo, useState } from 'react'
import { getAllReports, getReport, getSubmissions, emailReport, deleteReport } from '../lib/api'
import { loadStoredCourseColors, getCourseColor } from '../lib/courseColors'
import Icon from '../components/Icon'
import ReportBody from '../components/ReportBody'
import './Screens.css'
import './ReportsPage.css'

const FLAG_SEVERITY = { misconception: 0, 'no-engagement': 1, partial: 2, 'on-track': 3 }

function getReportFlagLevel(report) {
  if (!report) return null
  if (report.includes('No engagement')) return 'no-engagement'
  if (report.includes('Misconception present')) return 'misconception'
  if (report.includes('Partial understanding')) return 'partial'
  if (report.includes('Demonstrates understanding')) return 'on-track'
  if (report.includes('Submission was blank') || report.includes('Submission too short') || report.includes('Submission did not address')) return 'no-engagement'
  if (report.includes('No misconceptions detected')) return 'on-track'
  if (report.includes('Misconceptions Detected')) return 'misconception'
  return 'on-track'
}

function getFlagLabel(level) {
  if (level === 'misconception') return 'Misconception'
  if (level === 'no-engagement') return 'No response'
  if (level === 'partial') return 'Partial'
  if (level === 'on-track') return 'On track'
  return null
}

// Landing view is a class-card grid (like Courses) — each card shows only a
// report count, deliberately no flagged-student signal at this level. Clicking
// a card drills into that class's own reports: title-searchable, sorted by
// build date. No cross-class student list lives here anymore — flagged
// students only ever appear once a teacher has opened one specific report.
function ReportsPage({ onViewAssignment, onGoToClasses }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [selectedClass, setSelectedClass] = useState(null) // course_name, or null for the class-card grid
  const [search, setSearch] = useState('') // assignment-title search, scoped to the selected class

  // Per-report-card state, all scoped to whichever card is currently expanded
  const [expandedCard, setExpandedCard] = useState(null)
  const [cardSubmissions, setCardSubmissions] = useState({}) // { [cwId]: submission[] } — lazy, only fetched on expand
  const [studentSearch, setStudentSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // 'all' | 'flagged' | 'on-track'
  const [expandedStudent, setExpandedStudent] = useState(null)
  const [classwideOpen, setClasswideOpen] = useState(false)
  const [reportContents, setReportContents] = useState({}) // { [cwId]: { content, loading, error } }

  const [emailingId, setEmailingId] = useState(null)
  const [emailFeedback, setEmailFeedback] = useState(null)
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
    setExpandedCard(null)
  }

  function handleBackToClasses() {
    setSelectedClass(null)
    setExpandedCard(null)
  }

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
      setReports(prev => prev.filter(r => r.coursework_id !== courseworkId))
      if (expandedCard === courseworkId) setExpandedCard(null)
    } catch (err) {
      setEmailFeedback({ coursework_id: courseworkId, message: err.message, isError: true })
    } finally {
      setDeletingId(null)
    }
  }

  function handleExpandCard(courseworkId) {
    if (expandedCard === courseworkId) {
      setExpandedCard(null)
      setExpandedStudent(null)
      setStudentSearch('')
      setStatusFilter('all')
      setClasswideOpen(false)
      return
    }
    setExpandedCard(courseworkId)
    setExpandedStudent(null)
    setStudentSearch('')
    setStatusFilter('all')
    setClasswideOpen(false)

    // Lazy — only fetched once a report is actually opened, not for every
    // report in the class up front
    if (!cardSubmissions[courseworkId]) {
      getSubmissions(courseworkId)
        .then(subs => setCardSubmissions(prev => ({ ...prev, [courseworkId]: subs })))
        .catch(() => setCardSubmissions(prev => ({ ...prev, [courseworkId]: [] })))
    }
    if (!reportContents[courseworkId]) {
      setReportContents(prev => ({ ...prev, [courseworkId]: { loading: true } }))
      getReport(courseworkId)
        .then(data => setReportContents(prev => ({ ...prev, [courseworkId]: { content: data?.content } })))
        .catch(() => setReportContents(prev => ({ ...prev, [courseworkId]: { error: 'Failed to load.' } })))
    }
  }

  function getCardStudents(courseworkId) {
    const subs = cardSubmissions[courseworkId] || []
    return subs
      .map(s => ({ ...s, flagLevel: getReportFlagLevel(s.individual_report) }))
      .filter(s => {
        if (studentSearch && !(s.student_name || '').toLowerCase().includes(studentSearch.toLowerCase())) return false
        if (statusFilter === 'flagged' && (s.flagLevel === 'on-track' || !s.flagLevel)) return false
        if (statusFilter === 'on-track' && s.flagLevel !== 'on-track') return false
        return true
      })
      .sort((a, b) => (FLAG_SEVERITY[a.flagLevel] ?? 4) - (FLAG_SEVERITY[b.flagLevel] ?? 4))
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
                {classReports.map(report => {
                  const isExpanded = expandedCard === report.coursework_id
                  const cardStudents = isExpanded ? getCardStudents(report.coursework_id) : []
                  const cached = reportContents[report.coursework_id]

                  return (
                    <li key={report.report_id}>
                      <div className={`item-card reports-item-card${isExpanded ? ' reports-item-card--expanded' : ''}`}>
                        <button
                          type="button"
                          className="reports-item-main"
                          onClick={() => handleExpandCard(report.coursework_id)}
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

                      {isExpanded && (
                        <div className="reports-expanded">
                          <div className="reports-student-controls">
                            <div className="reports-search-wrap reports-search-wrap--sm">
                              <Icon name="search" className="reports-search-icon" />
                              <input
                                className="reports-search"
                                type="search"
                                placeholder="Search students…"
                                value={studentSearch}
                                onChange={e => { setStudentSearch(e.target.value); setExpandedStudent(null) }}
                              />
                            </div>
                            <div className="reports-status-tabs">
                              {[
                                { key: 'all', label: 'All' },
                                { key: 'flagged', label: 'Flagged' },
                                { key: 'on-track', label: 'On Track' },
                              ].map(({ key, label }) => (
                                <button
                                  key={key}
                                  className={`reports-status-tab${statusFilter === key ? ' reports-status-tab--active' : ''}`}
                                  onClick={() => { setStatusFilter(key); setExpandedStudent(null) }}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>

                          {cardStudents.length === 0 ? (
                            <p className="screen-status">No students match.</p>
                          ) : (
                            <div className="reports-student-list">
                              {cardStudents.map((sub, i) => {
                                const isOpen = expandedStudent === sub.submission_id
                                return (
                                  <div
                                    key={sub.submission_id}
                                    className={`reports-student-item${isOpen ? ' reports-student-item--open' : ''}`}
                                  >
                                    <button
                                      className="reports-student-row"
                                      onClick={() => setExpandedStudent(isOpen ? null : sub.submission_id)}
                                    >
                                      <span className="reports-student-name">
                                        {sub.student_name || `Student ${i + 1}`}
                                      </span>
                                      <div className="reports-student-right">
                                        {sub.flagLevel && (
                                          <span className={`flag-badge flag-badge--${sub.flagLevel}`}>
                                            {getFlagLabel(sub.flagLevel)}
                                          </span>
                                        )}
                                        <Icon
                                          name={isOpen ? 'expand_less' : 'expand_more'}
                                          className="reports-student-chevron"
                                        />
                                      </div>
                                    </button>
                                    {isOpen && (
                                      <div className="reports-student-report">
                                        {sub.individual_report
                                          ? <ReportBody content={sub.individual_report} />
                                          : <p className="reports-individual-empty">No report generated yet.</p>
                                        }
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          <div className="reports-classwide-section">
                            <button
                              className="reports-classwide-toggle"
                              onClick={() => setClasswideOpen(v => !v)}
                            >
                              <span>Class Overview</span>
                              <Icon name={classwideOpen ? 'expand_less' : 'expand_more'} />
                            </button>
                            {classwideOpen && (
                              cached?.loading ? <p className="screen-status">Loading…</p>
                              : cached?.error ? <p className="screen-status screen-status--error">{cached.error}</p>
                              : cached?.content ? <ReportBody content={cached.content} mode="classwide" totalSubmissions={report.total_submissions} />
                              : <p className="screen-status">No class overview available.</p>
                            )}
                          </div>

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
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default ReportsPage

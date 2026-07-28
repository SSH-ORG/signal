import { useEffect, useMemo, useState } from 'react'
import { getAllReports, getReport, getSubmissions, emailReport, deleteReport } from '../lib/api'
import Icon from '../components/Icon'
import ReportBody from '../components/ReportBody'
import './Screens.css'
import './ReportsPage.css'

// Severity ordering for sorting flagged students
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

function ReportsPage({ gcAssignments, onViewAssignment, onGoToAssignments, onGoToClasses }) {
  const [reports, setReports] = useState([])
  const [allSubmissions, setAllSubmissions] = useState({}) // { [courseworkId]: submission[] }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Global controls
  const [search, setSearch] = useState('')
  const [classFilter, setClassFilter] = useState('all')
  const [timeFilter, setTimeFilter] = useState('all')
  const [showAllFlagged, setShowAllFlagged] = useState(false)

  // Per-card state
  const [expandedCard, setExpandedCard] = useState(null)
  const [studentSearch, setStudentSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // 'all' | 'flagged' | 'on-track'
  const [expandedStudent, setExpandedStudent] = useState(null)
  const [classwideOpen, setClasswideOpen] = useState(false)
  const [reportContents, setReportContents] = useState({}) // { [cwId]: { content, loading, error } }

  // Email / delete feedback
  const [emailingId, setEmailingId] = useState(null)
  const [emailFeedback, setEmailFeedback] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  // Load all reports on mount, then fetch submissions for all of them in parallel
  useEffect(() => {
    getAllReports()
      .then(data => {
        setReports(data)
        return data
      })
      .then(data =>
        Promise.all(
          data.map(r =>
            getSubmissions(r.coursework_id)
              .then(subs => ({ id: r.coursework_id, subs }))
              .catch(() => ({ id: r.coursework_id, subs: [] }))
          )
        )
      )
      .then(results => {
        const map = {}
        results.forEach(({ id, subs }) => { map[id] = subs })
        setAllSubmissions(map)
      })
      .catch(() => setError('Failed to load reports.'))
      .finally(() => setLoading(false))
  }, [])

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

    // Fetch class-wide report content if not already cached
    if (!reportContents[courseworkId]) {
      setReportContents(prev => ({ ...prev, [courseworkId]: { loading: true } }))
      getReport(courseworkId)
        .then(data => setReportContents(prev => ({ ...prev, [courseworkId]: { content: data?.content } })))
        .catch(() => setReportContents(prev => ({ ...prev, [courseworkId]: { error: 'Failed to load.' } })))
    }
  }

  // All flagged students across all assignments, sorted by severity (worst first)
  const needsAttention = useMemo(() => {
    const flagged = []
    Object.entries(allSubmissions).forEach(([cwId, subs]) => {
      const report = reports.find(r => r.coursework_id === parseInt(cwId))
      if (!report) return
      subs.forEach(sub => {
        const level = getReportFlagLevel(sub.individual_report)
        if (level && level !== 'on-track') {
          flagged.push({ ...sub, flagLevel: level, report })
        }
      })
    })
    return flagged.sort((a, b) => (FLAG_SEVERITY[a.flagLevel] ?? 4) - (FLAG_SEVERITY[b.flagLevel] ?? 4))
  }, [allSubmissions, reports])

  // Cross-assignment student search
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const results = []
    Object.entries(allSubmissions).forEach(([cwId, subs]) => {
      const report = reports.find(r => r.coursework_id === parseInt(cwId))
      if (!report) return
      subs.forEach(sub => {
        if ((sub.student_name || '').toLowerCase().includes(q)) {
          results.push({ ...sub, flagLevel: getReportFlagLevel(sub.individual_report), report })
        }
      })
    })
    return results.sort((a, b) => (FLAG_SEVERITY[a.flagLevel] ?? 4) - (FLAG_SEVERITY[b.flagLevel] ?? 4))
  }, [search, allSubmissions, reports])

  // Returns students for an expanded card, with search + filter + flagged-first sort
  function getCardStudents(courseworkId) {
    const subs = allSubmissions[courseworkId] || []
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

  const filteredReports = useMemo(() => reports.filter(r => {
    if (classFilter !== 'all' && (r.course_name || 'Archived Class') !== classFilter) return false
    if (timeFilter !== 'all') {
      const days = timeFilter === '7days' ? 7 : 30
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - days)
      if (new Date(r.created_at) < cutoff) return false
    }
    return true
  }), [reports, classFilter, timeFilter])

  const classes = useMemo(() => {
    const seen = new Set()
    return gcAssignments
      .filter(a => { if (seen.has(a.course_id)) return false; seen.add(a.course_id); return true })
      .map(a => ({ course_id: a.course_id, course_name: a.course_name }))
  }, [gcAssignments])

  const grouped = filteredReports.reduce((acc, r) => {
    const name = r.course_name || 'Archived Class'
    if (!acc[name]) acc[name] = []
    acc[name].push(r)
    return acc
  }, {})

  const selectedClass = classes.find(c => c.course_name === classFilter)
  const visibleFlagged = showAllFlagged ? needsAttention : needsAttention.slice(0, 10)

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
      <main className="screen-main">

        {/* ── Header + Controls ── */}
        <div className="reports-header">
          <div>
            <h1 className="screen-title">Reports</h1>
            <p className="screen-subtitle">
              {reports.length} assignment{reports.length !== 1 ? 's' : ''}
              {needsAttention.length > 0 && (
                <span className="reports-subtitle-flag"> · {needsAttention.length} flagged</span>
              )}
            </p>
          </div>
          <div className="reports-filters">
            <div className="reports-search-wrap">
              <Icon name="search" className="reports-search-icon" />
              <input
                className="reports-search"
                type="search"
                placeholder="Search students…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <label className="reports-filter">
              Class
              <span className="reports-filter-select-wrap">
                <select value={classFilter} onChange={e => setClassFilter(e.target.value)}>
                  <option value="all">ALL</option>
                  {classes.map(c => <option key={c.course_id} value={c.course_name}>{c.course_name}</option>)}
                </select>
                <Icon name="expand_more" className="reports-filter-chevron" />
              </span>
            </label>
            <label className="reports-filter">
              Time
              <span className="reports-filter-select-wrap">
                <select value={timeFilter} onChange={e => setTimeFilter(e.target.value)}>
                  <option value="all">ALL</option>
                  <option value="7days">Last 7 days</option>
                  <option value="30days">Last 30 days</option>
                </select>
                <Icon name="expand_more" className="reports-filter-chevron" />
              </span>
            </label>
          </div>
        </div>

        {/* ── Cross-assignment search results ── */}
        {search.trim() ? (
          <div className="reports-search-results">
            <p className="reports-section-label">
              {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for &ldquo;{search}&rdquo;
            </p>
            {searchResults.length === 0 ? (
              <p className="screen-status">No students match that name.</p>
            ) : (
              <div className="reports-attention-list">
                {searchResults.map(s => (
                  <StudentRow
                    key={`${s.report.coursework_id}-${s.submission_id}`}
                    name={s.student_name || `Student ${s.submission_id}`}
                    meta={`${s.report.title} · ${s.report.course_name}`}
                    flagLevel={s.flagLevel}
                    onView={() => onViewAssignment(s.report.coursework_id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ── Needs Attention ── */}
            {needsAttention.length > 0 && (
              <div className="reports-attention-section">
                <div className="reports-section-header">
                  <span className="reports-section-label">Needs Attention</span>
                  <span className="reports-flagged-count">{needsAttention.length} flagged</span>
                </div>
                <div className="reports-attention-list">
                  {visibleFlagged.map(s => (
                    <StudentRow
                      key={`${s.report.coursework_id}-${s.submission_id}`}
                      name={s.student_name || `Student ${s.submission_id}`}
                      meta={`${s.report.title} · ${s.report.course_name}`}
                      flagLevel={s.flagLevel}
                      onView={() => onViewAssignment(s.report.coursework_id)}
                    />
                  ))}
                </div>
                {needsAttention.length > 10 && (
                  <button className="reports-show-more" onClick={() => setShowAllFlagged(v => !v)}>
                    {showAllFlagged ? 'Show less' : `Show all ${needsAttention.length} flagged students`}
                  </button>
                )}
              </div>
            )}

            {/* ── Assignment cards ── */}
            {filteredReports.length === 0 ? (
              <p className="screen-status">
                No reports yet.
                <button
                  type="button"
                  className="reports-empty-icon-btn"
                  onClick={selectedClass
                    ? () => onGoToAssignments(selectedClass.course_id, selectedClass.course_name)
                    : onGoToClasses}
                >
                  <Icon name="arrow_forward" />
                </button>
              </p>
            ) : (
              Object.entries(grouped).map(([courseName, courseReports]) => (
                <div key={courseName} className="reports-group">
                  <h2 className="reports-group-title">{courseName}</h2>
                  <ul className="item-list">
                    {courseReports.map(report => {
                      const isExpanded = expandedCard === report.coursework_id
                      const subs = allSubmissions[report.coursework_id] || []
                      const flaggedCount = subs.filter(s => {
                        const l = getReportFlagLevel(s.individual_report)
                        return l && l !== 'on-track'
                      }).length
                      const cardStudents = isExpanded ? getCardStudents(report.coursework_id) : []
                      const cached = reportContents[report.coursework_id]

                      return (
                        <li key={report.report_id}>
                          {/* Compact card row */}
                          <div className={`item-card reports-item-card${isExpanded ? ' reports-item-card--expanded' : ''}`}>
                            <button
                              type="button"
                              className="reports-item-main"
                              onClick={() => handleExpandCard(report.coursework_id)}
                            >
                              <div className="item-info">
                                <span className="item-name">{report.title}</span>
                                <span className="item-meta">
                                  {subs.length} student{subs.length !== 1 ? 's' : ''}
                                  {flaggedCount > 0 && (
                                    <span className="reports-flagged-badge">{flaggedCount} flagged</span>
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

                          {/* Expanded panel */}
                          {isExpanded && (
                            <div className="reports-expanded">
                              {/* Student list controls */}
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
                                      {key === 'flagged' && flaggedCount > 0 && (
                                        <span className="reports-tab-count">{flaggedCount}</span>
                                      )}
                                      {key === 'on-track' && (
                                        <span className="reports-tab-count">{subs.length - flaggedCount}</span>
                                      )}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {/* Student accordion list */}
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

                              {/* Class overview — collapsed by default */}
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
                                  : cached?.content ? <ReportBody content={cached.content} mode="classwide" totalSubmissions={subs.length} />
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
                </div>
              ))
            )}
          </>
        )}
      </main>
    </div>
  )
}

// Reusable row used in both the Needs Attention section and search results
function StudentRow({ name, meta, flagLevel, onView }) {
  return (
    <div className={`reports-attention-item${flagLevel && flagLevel !== 'on-track' ? ' reports-attention-item--flagged' : ''}`}>
      <div className="reports-attention-left">
        <span className="reports-attention-name">{name}</span>
        <span className="reports-attention-meta">{meta}</span>
      </div>
      <div className="reports-attention-right">
        {flagLevel && (
          <span className={`flag-badge flag-badge--${flagLevel}`}>{getFlagLabel(flagLevel)}</span>
        )}
        <button className="reports-attention-view" onClick={onView}>
          View <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  )
}

export default ReportsPage

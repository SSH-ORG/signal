import { useEffect, useMemo, useState } from 'react'
import { getCourseAssignments } from '../lib/api'
import './Screens.css'

// Second screen — lists assignment titles for the selected class. Assignment
// data is fetched fresh, live from Google, every time this screen opens for a
// class — it's read-only and doesn't sync anything into our database. Syncing
// (submissions, content) only happens per-assignment, once a teacher actually
// opens one — see AssignmentDetailPage.
// Clicking an assignment drills down into AssignmentDetailPage.
function AssignmentsPage({ courseId, synced, onBack, onSelectAssignment }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [gcAssignments, setGcAssignments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!courseId) return

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await getCourseAssignments(courseId)
        setGcAssignments(data.coursework)
        if (data.failed) setError("Couldn't load some assignments for this class. Please refresh.")
      } catch {
        setError('Failed to load assignments from Google Classroom. Please try again in a moment.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [courseId])

  const assignments = useMemo(() => {
    const filtered = gcAssignments.filter((a) =>
      a.title.toLowerCase().includes(searchQuery.trim().toLowerCase())
    )

    // Always sorted by due date — it's the actionable signal (what needs attention
    // soonest), not a choice a teacher needs to make. Assignments with none set fall
    // to the end, ordered among themselves by creation date as a tiebreaker.
    return [...filtered].sort((a, b) => {
      if (!a.due_date && !b.due_date) return new Date(a.created_at) - new Date(b.created_at)
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date) - new Date(b.due_date) // soonest/most-overdue first
    })
  }, [gcAssignments, searchQuery])

  const syncedByGcId = useMemo(() => {
    const map = new Map()
    for (const cw of synced) map.set(cw.google_coursework_id, cw)
    return map
  }, [synced])

  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <button className="back-btn" onClick={onBack}>← courses</button>
        </div>
        <div>
          <h1 className="screen-title">coursework</h1>
          <p className="screen-subtitle">choose an assignment to build a report</p>
        </div>

        <div className="coursework-controls">
          <input
            type="text"
            className="search-input"
            placeholder="Search assignments…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search assignments"
          />
        </div>

        {loading && <p className="screen-status">Loading assignments ..</p>}
        {error && <p className="screen-status screen-status--error">{error}</p>}

        {!loading && !error && assignments.length === 0 ? (
          <p className="empty-state">
            {searchQuery ? 'No assignments match your search.' : 'No coursework made for this class yet.'}
          </p>
        ) : (
          !loading && !error && (
            <ul className="item-list">
              {assignments.map((assignment) => {
                const syncedRecord = syncedByGcId.get(assignment.google_coursework_id) || null

                return (
                  <li key={assignment.google_coursework_id}>
                    <button
                      className="item-card"
                      onClick={() => onSelectAssignment(assignment, syncedRecord)}
                    >
                      <div className="item-info">
                        <span className="item-name">{assignment.title}</span>
                      </div>
                      <div className="item-badges">
                        <span className="chevron">›</span>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )
        )}
      </main>
    </div>
  )
}

export default AssignmentsPage

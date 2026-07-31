import { useEffect, useMemo, useState } from 'react'
import { syncCourse } from '../lib/api'
import './Screens.css'

// Module-scoped (not component state) so it survives navigating away and back —
// skips re-syncing a course that was already synced in the last 30s, so quick
// back-and-forth navigation doesn't spam Google's API
const lastSyncedAt = new Map()
const SYNC_DEBOUNCE_MS = 30_000

// Second screen — lists assignment titles for the selected class.
// Clicking an assignment drills down into AssignmentDetailPage.
function AssignmentsPage({ courseId, courseName, gcAssignments, synced, onBack, onSelectAssignment, onDataChange }) {
  const [searchQuery, setSearchQuery] = useState('')

  // Syncing is automatic — opening or revisiting a course's Coursework screen
  // syncs every one of its assignments, so there's no manual "sync" button here
  useEffect(() => {
    if (!courseId) return
    const last = lastSyncedAt.get(courseId)
    if (last && Date.now() - last < SYNC_DEBOUNCE_MS) return
    lastSyncedAt.set(courseId, Date.now())
    syncCourse(courseId, courseName).then(onDataChange).catch(() => {})
  }, [courseId, courseName, onDataChange])

  const assignments = useMemo(() => {
    const filtered = gcAssignments
      .filter((a) => a.course_id === courseId)
      .filter((a) => a.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))

    // Always sorted by due date — it's the actionable signal (what needs attention
    // soonest), not a choice a teacher needs to make. Assignments with none set fall
    // to the end, ordered among themselves by creation date as a tiebreaker.
    return [...filtered].sort((a, b) => {
      if (!a.due_date && !b.due_date) return new Date(a.created_at) - new Date(b.created_at)
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date) - new Date(b.due_date) // soonest/most-overdue first
    })
  }, [gcAssignments, courseId, searchQuery])

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

        {assignments.length === 0 ? (
          <p className="empty-state">
            {searchQuery ? 'No assignments match your search.' : 'No coursework made for this class yet.'}
          </p>
        ) : (
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
                      {syncedRecord && (
                        <span className="item-meta">
                          {syncedRecord.submission_count} {syncedRecord.submission_count === 1 ? 'submission' : 'submissions'}
                        </span>
                      )}
                    </div>
                    <div className="item-badges">
                      <span className="chevron">›</span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </div>
  )
}

export default AssignmentsPage

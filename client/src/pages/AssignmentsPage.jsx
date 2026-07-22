import { useMemo } from 'react'
import './Screens.css'

// Second screen — lists assignment titles for the selected class.
// Clicking an assignment drills down into AssignmentDetailPage.
function AssignmentsPage({ courseId, gcAssignments, imported, onBack, onSelectAssignment }) {
  const assignments = useMemo(
    () => gcAssignments.filter((a) => a.course_id === courseId),
    [gcAssignments, courseId]
  )

  const importedByGcId = useMemo(() => {
    const map = new Map()
    for (const cw of imported) map.set(cw.google_coursework_id, cw)
    return map
  }, [imported])

  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <button className="back-btn" onClick={onBack}>← Classes</button>
        </div>
        <div>
          <h1 className="screen-title">Coursework</h1>
          <p className="screen-subtitle">choose an assignment to build a report</p>
        </div>

        {assignments.length === 0 ? (
          <p className="empty-state">No assignments in this class.</p>
        ) : (
          <ul className="item-list">
            {assignments.map((assignment) => {
              const importedRecord = importedByGcId.get(assignment.google_coursework_id) || null

              return (
                <li key={assignment.google_coursework_id}>
                  <button
                    className="item-card"
                    onClick={() => onSelectAssignment(assignment, importedRecord)}
                  >
                    <div className="item-info">
                      <span className="item-name">{assignment.title}</span>
                      {importedRecord && (
                        <span className="item-meta">
                          {importedRecord.submission_count} {importedRecord.submission_count === 1 ? 'submission' : 'submissions'}
                        </span>
                      )}
                    </div>
                    <div className="item-badges">
                      {importedRecord && <span className="badge">Synced</span>}
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

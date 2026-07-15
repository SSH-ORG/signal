import { useMemo } from 'react'
import Logo from '../components/Logo'
import './Screens.css'

// First screen after login — lists the teacher's Google Classroom courses.
// Clicking a course drills down into AssignmentsPage.
function CoursesPage({ gcAssignments, imported, loading, error, onLogout, onSelectCourse }) {
  // Derive unique courses from the flat GC assignments list
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

  const importedIds = useMemo(
    () => new Set(imported.map((cw) => cw.google_coursework_id)),
    [imported]
  )

  return (
    <div className="screen">
      <header className="screen-header">
        <Logo size="medium" />
        <button className="logout-btn" onClick={onLogout}>Log out</button>
      </header>

      <main className="screen-main">
        <div>
          <h1 className="screen-title">Your Classes</h1>
          <p className="screen-subtitle">Select a class to view its assignments</p>
        </div>

        {loading && <p className="screen-status">Loading your classes…</p>}
        {error && <p className="screen-status screen-status--error">{error}</p>}

        {!loading && !error && (
          courses.length === 0 ? (
            <p className="empty-state">No classes found in your Google Classroom.</p>
          ) : (
            <ul className="item-list">
              {courses.map((course) => {
                const total = gcAssignments.filter((a) => a.course_id === course.course_id).length
                const importedCount = gcAssignments
                  .filter((a) => a.course_id === course.course_id && importedIds.has(a.google_coursework_id))
                  .length

                return (
                  <li key={course.course_id}>
                    <button
                      className="item-card"
                      onClick={() => onSelectCourse(course.course_id, course.course_name)}
                    >
                      <div className="item-info">
                        <span className="item-name">{course.course_name}</span>
                        <span className="item-meta">{total} assignment{total !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="item-badges">
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
      </main>
    </div>
  )
}

export default CoursesPage

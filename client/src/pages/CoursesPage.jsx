import { useMemo } from 'react'
import Logo from '../components/Logo'
import './Screens.css'

// Banner colors cycle across cards the same way Google Classroom assigns a
// color per class — picked to stay in-family with the app's purple accent.
const BANNER_COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1']

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
            <div className="course-grid">
              {courses.map((course, i) => {
                const total = gcAssignments.filter((a) => a.course_id === course.course_id).length
                const importedCount = gcAssignments
                  .filter((a) => a.course_id === course.course_id && importedIds.has(a.google_coursework_id))
                  .length

                return (
                  <button
                    key={course.course_id}
                    className="course-card"
                    onClick={() => onSelectCourse(course.course_id, course.course_name)}
                  >
                    <div
                      className="course-card-banner"
                      style={{ background: BANNER_COLORS[i % BANNER_COLORS.length] }}
                    >
                      <span className="course-card-name">{course.course_name}</span>
                    </div>
                    <div className="course-card-body">
                      <span className="item-meta">{total} assignment{total !== 1 ? 's' : ''}</span>
                      {importedCount > 0 && (
                        <span className="badge">{importedCount} imported</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )
        )}
      </main>
    </div>
  )
}

export default CoursesPage

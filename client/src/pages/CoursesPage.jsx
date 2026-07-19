import { useMemo } from 'react'
import Icon from '../components/Icon'
import './Screens.css'

// Banner colors cycle across cards the same way Google Classroom assigns a
// color per class — picked to stay in-family with the app's purple accent.
const BANNER_COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1']

// First screen after login — lists the teacher's Google Classroom courses.
// Clicking a course drills down into AssignmentsPage.
function CoursesPage({ gcAssignments, loading, error, onSelectCourse, onSelectReports }) {
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

  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <h1 className="screen-title">Classes</h1>
          <p className="screen-subtitle">Choose a course to see its contents</p>
        </div>

        {loading && <p className="screen-status">Loading your classes…</p>}
        {error && <p className="screen-status screen-status--error">{error}</p>}

        {!loading && !error && (
          courses.length === 0 ? (
            <p className="empty-state">No classes found in your Google Classroom.</p>
          ) : (
            <div className="course-grid">
              {courses.map((course, i) => {
                return (
                  <div key={course.course_id} className="course-card">
                    <button
                      className="course-card-main"
                      onClick={() => onSelectCourse(course.course_id, course.course_name)}
                    >
                      <div
                        className="course-card-banner"
                        style={{ background: BANNER_COLORS[i % BANNER_COLORS.length] }}
                      >
                        <span className="course-card-name">{course.course_name}</span>
                      </div>
                      <div className="course-card-body" />
                    </button>

                    <div className="course-card-footer">
                      <button
                        type="button"
                        className="course-icon-btn"
                        data-tooltip="Reports"
                        aria-label="Reports"
                        onClick={() => onSelectReports(course.course_id, course.course_name)}
                      >
                        <Icon name="analytics" className="course-icon-svg" />
                      </button>
                    </div>
                  </div>
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

import { useMemo } from 'react'
import Logo from '../components/Logo'
import './Screens.css'

// Banner colors cycle across cards the same way Google Classroom assigns a
// color per class — picked to stay in-family with the app's purple accent.
const BANNER_COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1']

// First screen after login — lists the teacher's Google Classroom courses.
// Clicking a course drills down into AssignmentsPage.
function CoursesPage({ gcAssignments, loading, error, onLogout, onSelectCourse }) {
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
                        data-tooltip="My assignments"
                        aria-label="My assignments"
                        onClick={() => onSelectCourse(course.course_id, course.course_name)}
                      >
                        <AssignmentIcon />
                      </button>
                      <button
                        type="button"
                        className="course-icon-btn"
                        data-tooltip="My reports"
                        aria-label="My reports"
                        onClick={() => onSelectCourse(course.course_id, course.course_name)}
                      >
                        <AnalyticsIcon />
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

// Material-style "assignment" glyph (clipboard with a checklist) — used for
// the "My assignments" quick-action on each course card.
function AssignmentIcon() {
  return (
    <svg className="course-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 16H5V5h2v3h10V5h2v14z"
      />
    </svg>
  )
}

// Material-style "analytics" glyph (ascending bar chart) — used for the
// "My reports" quick-action on each course card.
function AnalyticsIcon() {
  return (
    <svg className="course-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 9.2h3V19H5V9.2zm5.6-4.2h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z"
      />
    </svg>
  )
}

export default CoursesPage

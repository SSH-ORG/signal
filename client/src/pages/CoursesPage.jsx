import './Screens.css'

// Banner colors cycle across cards the same way Google Classroom assigns a
// color per class — picked to stay in-family with the app's purple accent.
const BANNER_COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1']

// First screen after login — lists every one of the teacher's active Google
// Classroom courses, including ones with no assignments yet. Clicking a
// course drills down into AssignmentsPage, which shows its own empty state
// for classes with no coursework.
function CoursesPage({ courses, loading, error, onSelectCourse }) {
  return (
    <div className="screen">
      <main className="screen-main screen-main--wide">
        <div>
          <h1 className="screen-title">Classes</h1>
          <p className="screen-subtitle">choose a course</p>
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

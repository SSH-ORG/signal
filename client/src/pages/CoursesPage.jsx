import { useEffect, useState } from 'react'
import Icon from '../components/Icon'
import './Screens.css'

// Banner colors cycle across cards the same way Google Classroom assigns a
// color per class — picked to stay in-family with the app's purple accent.
const BANNER_COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1']
// Offered in the color-picker popup — the default cycle plus a couple extras,
// since a teacher might want a color that isn't in the auto-assigned rotation.
const COLOR_OPTIONS = [...BANNER_COLORS, '#ef4444', '#14b8a6']

// Per-teacher color overrides are a display preference only, not app data —
// kept in localStorage rather than the backend so this stays a small, purely
// client-side feature.
const COLOR_STORAGE_KEY = 'signal:course-colors'

function loadStoredColors() {
  try {
    return JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY)) || {}
  } catch {
    return {}
  }
}

// First screen after login — lists every one of the teacher's active Google
// Classroom courses, including ones with no assignments yet. Clicking a
// course drills down into AssignmentsPage, which shows its own empty state
// for classes with no coursework.
function CoursesPage({ courses, loading, error, onSelectCourse }) {
  const [courseColors, setCourseColors] = useState(loadStoredColors)
  // course_id whose color-picker popup is open, or null
  const [colorPickerFor, setColorPickerFor] = useState(null)

  // Closes the color picker on Escape or on any click outside it
  useEffect(() => {
    if (!colorPickerFor) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') setColorPickerFor(null)
    }
    function handleClickOutside() {
      setColorPickerFor(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    const timer = setTimeout(() => window.addEventListener('click', handleClickOutside), 0)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('click', handleClickOutside)
      clearTimeout(timer)
    }
  }, [colorPickerFor])

  function handlePickColor(courseId, color) {
    setCourseColors((prev) => {
      const next = { ...prev, [courseId]: color }
      localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(next))
      return next
    })
    setColorPickerFor(null)
  }

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
                const color = courseColors[course.course_id] || BANNER_COLORS[i % BANNER_COLORS.length]
                return (
                  <div key={course.course_id} className="course-card" style={{ '--course-color': color }}>
                    <button
                      className="course-card-main"
                      onClick={() => onSelectCourse(course.course_id, course.course_name)}
                    >
                      <div className="course-card-banner" style={{ background: color }}>
                        <span className="course-card-name">{course.course_name}</span>
                      </div>
                      <div className="course-card-body" />
                    </button>

                    <button
                      type="button"
                      className="course-color-btn"
                      aria-label="Change class color"
                      onClick={(e) => {
                        e.stopPropagation()
                        setColorPickerFor((prev) => (prev === course.course_id ? null : course.course_id))
                      }}
                    >
                      <Icon name="edit" className="course-color-icon" />
                    </button>

                    {colorPickerFor === course.course_id && (
                      <div className="color-picker" onClick={(e) => e.stopPropagation()}>
                        {COLOR_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            className="color-swatch"
                            style={{ background: option }}
                            aria-label={`Set class color to ${option}`}
                            onClick={() => handlePickColor(course.course_id, option)}
                          />
                        ))}
                      </div>
                    )}
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

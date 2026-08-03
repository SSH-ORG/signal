// Per-teacher class color overrides for the Courses screen only — a display
// preference, not app data, so it's kept in localStorage rather than the
// backend. Reports-screen cards deliberately don't read this: those are
// Signal-generated, not the teacher's own class cards, so they're always
// shown in the fixed brand purple instead (see ReportsPage.jsx).

// Picked to stay in-family with the app's purple accent — cycled across cards
// that don't have a stored override yet.
export const BANNER_COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1']

export const COLOR_STORAGE_KEY = 'signal:course-colors'

export function loadStoredCourseColors() {
  try {
    return JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY)) || {}
  } catch {
    return {}
  }
}

// index is only used as a fallback for courses with no stored override yet
export function getCourseColor(courseId, index, storedColors) {
  return storedColors[courseId] || BANNER_COLORS[index % BANNER_COLORS.length]
}

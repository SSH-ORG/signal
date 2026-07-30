// Per-teacher class color overrides — a display preference only, not app data,
// so it's kept in localStorage rather than the backend. Shared between
// CoursesPage (where a teacher sets it) and ReportsPage (where it's read), so
// a color change on one screen is reflected on the other automatically.

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

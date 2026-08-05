// Base URL of the FastAPI backend. Override with VITE_API_URL in a .env file
// if the backend isn't running on the default local port.
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// Set by App.jsx once, so any page's failed request reacts the same way to an
// expired Google session instead of each page deciding (or forgetting) on its own
let sessionExpiredHandler = () => {}
export function setSessionExpiredHandler(handler) {
  sessionExpiredHandler = handler
}

// Builds an Error from a failed response, preferring the backend's actual detail
// message over a generic fallback, and tagging the status code so callers can
// branch on the failure reason (e.g. expired session vs a Google API failure).
// Also fires the session-expired handler on 401 — every function below routes
// its errors through here, so this is the one place that needs to know.
async function readErrorDetail(response, fallback) {
  let detail
  try {
    detail = (await response.json()).detail
  } catch {
    // Body wasn't JSON — use the fallback below
  }
  const error = new Error(detail || fallback)
  error.status = response.status
  if (response.status === 401) sessionExpiredHandler()
  return error
}

// Fetches every active Google Classroom course (even ones with no assignments
// yet) — a live, read-only list, nothing saved. Used by the Courses screen,
// which only ever needs course names, not assignment data.
export async function getGoogleCourses() {
  const response = await fetch(`${API_BASE_URL}/api/google/courses`, {
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to fetch Google Classroom courses')
  return response.json()
}

// Fetches one course's live assignment list from Google Classroom (title, due
// date, description) — a pure read, nothing saved. Used by the Assignments
// screen to display a class's assignments before any of them are synced.
export async function getCourseAssignments(courseId) {
  const response = await fetch(`${API_BASE_URL}/api/google/courses/${courseId}/coursework`, {
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, "Failed to fetch this class's assignments from Google Classroom")
  return response.json()
}

// Syncs a specific Google Classroom assignment and its submissions into our database
// context is optional — the teacher-reviewed mental model/reference material text from the
// Assignment Detail screen. Only used the first time an assignment is synced (ignored on re-sync).
export async function syncCoursework(googleCourseworkId, courseId, courseName = '') {
  const response = await fetch(`${API_BASE_URL}/api/google/coursework/${googleCourseworkId}/sync`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ course_id: courseId, course_name: courseName }),
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to sync assignment')
  return response.json()
}

// Updates the mental model/reference material used by the AI report for an already-synced
// assignment — 3 separate fields, not one combined string, so nothing here needs parsing.
export async function updateCourseworkContext(courseworkId, {
  mentalModel, assignmentDescription, rubric, includeDescription, includeRubric,
}) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mental_model: mentalModel,
      assignment_description: assignmentDescription,
      rubric,
      include_description: includeDescription,
      include_rubric: includeRubric,
    }),
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to update context')
  return response.json()
}

// Fetches the structured rubric from Google Classroom and returns it as formatted text
// Returns null if the assignment has no rubric attached
export async function getGCRubric(googleCourseworkId, courseId) {
  const response = await fetch(
    `${API_BASE_URL}/api/google/coursework/${googleCourseworkId}/rubric?course_id=${courseId}`,
    { credentials: 'include' }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to fetch rubric from Google Classroom')
  const data = await response.json()
  return data.rubric_text  // null if no rubric exists
}

// Fetches the assignment's current description directly from Google Classroom —
// a pure read, doesn't touch submissions/roster. Used by "Sync Description" so
// a teacher can deliberately pull in a live edit instead of it silently
// overwriting their own custom description.
export async function getGCDescription(googleCourseworkId, courseId) {
  const response = await fetch(
    `${API_BASE_URL}/api/google/coursework/${googleCourseworkId}/description?course_id=${courseId}`,
    { credentials: 'include' }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to fetch description from Google Classroom')
  const data = await response.json()
  return data.description
}

// Returns all assignments the teacher has already synced into Signal
export async function getSyncedCoursework() {
  const response = await fetch(`${API_BASE_URL}/api/coursework/`, {
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to fetch synced assignments')
  return response.json()
}

// Returns all assignments that have a built report, across all courses
export async function getAllReports() {
  const response = await fetch(`${API_BASE_URL}/api/reports`, {
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to fetch reports')
  return response.json()
}

// Returns the existing AI report for an assignment (404 if not built yet)
export async function getReport(courseworkId) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}/report`, {
    credentials: 'include',
  })
  if (response.status === 404) return null
  if (!response.ok) throw await readErrorDetail(response, 'Failed to fetch report')
  return response.json()
}

// Triggers the AI to build a confusion report for an assignment
// Sends all stored submissions to the AI and saves the response
export async function buildReport(courseworkId) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}/report`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to build report')
  return response.json()
}

// Returns all submissions for an assignment, including any student reports already built
export async function getSubmissions(courseworkId) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}/report/submissions`, {
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to fetch submissions')
  return response.json()
}

// Builds an AI report for one specific student's submission
export async function buildStudentReport(courseworkId, submissionId) {
  const response = await fetch(
    `${API_BASE_URL}/api/coursework/${courseworkId}/report/submissions/${submissionId}`,
    { method: 'POST', credentials: 'include' }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to build student report')
  return response.json()
}

// Deletes the report for an assignment so the teacher can rebuild it
export async function deleteReport(courseworkId) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}/report`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to delete report')
  return response.json()
}

// Emails the existing report for an assignment to the teacher's own address
export async function emailReport(courseworkId) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}/report/email`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) throw await readErrorDetail(response, 'Failed to email report')
  return response.json()
}

// Emails one student's report to the teacher's own address —
// they can forward it on to the student themselves afterward if they want to
export async function emailStudentReport(courseworkId, submissionId) {
  const response = await fetch(
    `${API_BASE_URL}/api/coursework/${courseworkId}/report/submissions/${submissionId}/email`,
    { method: 'POST', credentials: 'include' }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to email report')
  return response.json()
}

// Drafts a second-person rewrite of a student's report (all 5 sections) for a
// teacher to review/edit before sending — generated fresh on each call, right
// before "Email to student" is used, never cached/persisted server-side.
export async function draftStudentEmail(courseworkId, submissionId) {
  const response = await fetch(
    `${API_BASE_URL}/api/coursework/${courseworkId}/report/submissions/${submissionId}/draft-student-email`,
    { method: 'POST', credentials: 'include' }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to draft student email')
  return response.json()
}

// Sends one student's report directly to the student's own email, instead of
// to the teacher — the "student agency" path, so the student gets feedback
// without the teacher having to manually forward it themselves.
// sectionOverrides is optional — lets a teacher tailor any section's wording
// (e.g. "you should..." instead of "the student should...") for just this
// email, without changing the report as stored. Keys: submissionSummary,
// understands, misconceptions, nextStep. No submissionQuality — that's
// teacher-facing information the student-facing email never shows.
export async function sendReportToStudent(courseworkId, submissionId, sectionOverrides = {}) {
  const response = await fetch(
    `${API_BASE_URL}/api/coursework/${courseworkId}/report/submissions/${submissionId}/send-to-student`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submission_summary_override: sectionOverrides.submissionSummary || null,
        understands_override: sectionOverrides.understands || null,
        misconceptions_override: sectionOverrides.misconceptions || null,
        next_step_override: sectionOverrides.nextStep || null,
      }),
    }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to send report to student')
  return response.json()
}

// Builds a "how to get started" nudge for a student with no submission —
// grounded only in the assignment's context, since there's nothing to analyze.
export async function buildNudge(courseworkId, submissionId) {
  const response = await fetch(
    `${API_BASE_URL}/api/coursework/${courseworkId}/report/submissions/${submissionId}/nudge`,
    { method: 'POST', credentials: 'include' }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to build nudge')
  return response.json()
}

// Sends that nudge directly to the student's own email. startHereOverride is
// optional — lets a teacher tailor the wording for just this email, without
// changing the nudge as stored.
export async function sendNudge(courseworkId, submissionId, startHereOverride) {
  const response = await fetch(
    `${API_BASE_URL}/api/coursework/${courseworkId}/report/submissions/${submissionId}/send-nudge`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_here_override: startHereOverride || null }),
    }
  )
  if (!response.ok) throw await readErrorDetail(response, 'Failed to send nudge')
  return response.json()
}

// Opens Google's consent screen in a popup instead of navigating the main window,
// so Google's own page never becomes part of the main window's browser history —
// that's what avoids the "back button lands on a stale, already-used Google page"
// problem a full-page redirect through Google leaves behind.
// Resolves true once the popup's backend callback confirms login succeeded, or
// false if the teacher closes the popup without completing it (or the popup was
// blocked and we fell back to a full-page redirect instead, which never resolves
// this promise at all since the page navigates away).
export function loginWithGooglePopup() {
  const url = `${API_BASE_URL}/auth/google`
  const width = 500
  const height = 650
  const left = window.screenX + (window.outerWidth - width) / 2
  const top = window.screenY + (window.outerHeight - height) / 2

  // Must be called synchronously from the click handler with no `await` before
  // it — browsers silently block popups opened after any async delay
  const popup = window.open(url, 'signal-google-login', `width=${width},height=${height},left=${left},top=${top}`)

  if (!popup) {
    // Blocked — fall back to the old full-page redirect rather than failing silently
    window.location.href = url
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    function cleanup() {
      window.removeEventListener('message', handleMessage)
      clearInterval(closeCheck)
      if (!popup.closed) popup.close()
    }

    function handleMessage(event) {
      if (event.origin !== API_BASE_URL || event.data?.type !== 'signal-auth-success') return
      cleanup()
      resolve(true)
    }

    // Also resolves if the teacher closes the popup themselves without finishing
    // login, so the caller isn't left waiting forever
    const closeCheck = setInterval(() => {
      if (popup.closed) {
        cleanup()
        resolve(false)
      }
    }, 500)

    window.addEventListener('message', handleMessage)
  })
}

// Asks the backend who's currently logged in, based on the session cookie.
// Resolves to the user object, or null if there is no active session.
export async function getCurrentUser() {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    credentials: 'include', // required so the session cookie is sent
  })

  if (response.status === 401) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch current user (status ${response.status})`)
  }

  return response.json()
}

// Clears the session cookie on the backend, logging the teacher out.
export async function logout() {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error(`Failed to log out (status ${response.status})`)
  }
}

// Updates editable profile fields. Pass only the fields that changed —
// e.g. { email_notifications_enabled: true } to flip just the toggle.
export async function updateProfile(fields) {
  const response = await fetch(`${API_BASE_URL}/auth/profile`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.detail || 'Failed to update profile')
  }
  return response.json()
}

// Permanently deletes the teacher's account and all their data (cascades
// through their synced coursework, submissions, and reports).
export async function deleteAccount() {
  const response = await fetch(`${API_BASE_URL}/auth/account`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Failed to delete account (status ${response.status})`)
  }
}

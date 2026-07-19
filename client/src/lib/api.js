// Base URL of the FastAPI backend. Override with VITE_API_URL in a .env file
// if the backend isn't running on the default local port.
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// Fetches all assignments from the teacher's Google Classroom courses (live, not stored)
export async function getGoogleCoursework() {
  const response = await fetch(`${API_BASE_URL}/api/google/coursework`, {
    credentials: 'include',
  })
  if (!response.ok) throw new Error('Failed to fetch Google Classroom assignments')
  return response.json()
}

// Imports a specific Google Classroom assignment and its submissions into our database
// context is optional — the teacher-reviewed rubric/learning-goal text from the Assignment
// Detail screen. Only used the first time an assignment is imported (ignored on re-sync).
export async function importCoursework(googleCourseworkId, courseId, context) {
  const response = await fetch(`${API_BASE_URL}/api/google/coursework/${googleCourseworkId}/import`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ course_id: courseId, context }),
  })
  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.detail || 'Failed to import assignment')
  }
  return response.json()
}

// Updates the rubric/learning-goal context used by the AI report for an already-imported assignment
export async function updateCourseworkContext(courseworkId, context) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  })
  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.detail || 'Failed to update context')
  }
  return response.json()
}

// Fetches the structured rubric from Google Classroom and returns it as formatted text
// Returns null if the assignment has no rubric attached
export async function getGCRubric(googleCourseworkId, courseId) {
  const response = await fetch(
    `${API_BASE_URL}/api/google/coursework/${googleCourseworkId}/rubric?course_id=${courseId}`,
    { credentials: 'include' }
  )
  if (!response.ok) throw new Error('Failed to fetch rubric from Google Classroom')
  const data = await response.json()
  return data.rubric_text  // null if no rubric exists
}

// Returns all assignments the teacher has already imported into Signal
export async function getImportedCoursework() {
  const response = await fetch(`${API_BASE_URL}/api/coursework/`, {
    credentials: 'include',
  })
  if (!response.ok) throw new Error('Failed to fetch imported assignments')
  return response.json()
}

// Returns the existing AI report for an assignment (404 if not generated yet)
export async function getReport(courseworkId) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}/report`, {
    credentials: 'include',
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Failed to fetch report')
  return response.json()
}

// Triggers Gemini to generate a confusion report for an assignment
// Sends all stored submissions to the AI and saves the response
export async function generateReport(courseworkId) {
  const response = await fetch(`${API_BASE_URL}/api/coursework/${courseworkId}/report`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.detail || 'Failed to generate report')
  }
  return response.json()
}

// Sends the whole browser to Google's consent screen (via our backend).
// This must be a full page redirect rather than a fetch, since Google needs
// to redirect the actual browser tab through its login flow and back.
export function redirectToGoogleLogin() {
  window.location.href = `${API_BASE_URL}/auth/google`
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
// through their imported coursework, submissions, and reports).
export async function deleteAccount() {
  const response = await fetch(`${API_BASE_URL}/auth/account`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Failed to delete account (status ${response.status})`)
  }
}

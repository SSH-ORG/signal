// Base URL of the FastAPI backend. Override with VITE_API_URL in a .env file
// if the backend isn't running on the default local port.
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

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

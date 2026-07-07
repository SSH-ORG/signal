import { useEffect, useState } from 'react'
import AuthPage from './pages/AuthPage'
import Dashboard from './pages/Dashboard'
import { getCurrentUser } from './lib/api'

// App is the root component — it decides which page to show based on auth state
// If the teacher is logged in, show the Dashboard
// If not, show the AuthPage (login screen)
function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true) // Prevents flash of wrong page on load

  // On first load, check if the teacher already has an active session
  useEffect(() => {
    getCurrentUser()
      .then((currentUser) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  // Don't render anything until we know the auth state
  if (loading) return null

  if (user) {
    return (
      <Dashboard
        user={user}
        onLogout={() => setUser(null)} // Clear user state when teacher logs out
      />
    )
  }

  // After Google OAuth redirect, the page reloads and getCurrentUser will return the user
  // AuthPage handles the redirect to Google — no extra props needed
  return <AuthPage />
}

export default App

import { useEffect, useState } from 'react'
import AuthPage from './pages/AuthPage'
import Dashboard from './pages/Dashboard'
import ReportPage from './pages/ReportPage'
import { getCurrentUser } from './lib/api'

// App is the root component — it decides which page to show based on auth state
// Pages: 'dashboard' (default after login) or 'report' (when a teacher opens an assignment)
function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)       // Prevents flash of wrong page on load
  const [page, setPage] = useState('dashboard')       // Which page is active
  const [selectedCoursework, setSelectedCoursework] = useState(null) // Assignment open in ReportPage

  // On first load, check if the teacher already has an active session
  useEffect(() => {
    getCurrentUser()
      .then((currentUser) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  // Don't render anything until we know the auth state
  if (loading) return null

  if (!user) {
    // AuthPage handles the redirect to Google — no extra props needed
    return <AuthPage />
  }

  // Navigate to the report page for a specific assignment
  function handleViewReport(coursework) {
    setSelectedCoursework(coursework)
    setPage('report')
  }

  // Go back to the dashboard and clear the selected assignment
  function handleBack() {
    setSelectedCoursework(null)
    setPage('dashboard')
  }

  if (page === 'report' && selectedCoursework) {
    return <ReportPage coursework={selectedCoursework} onBack={handleBack} />
  }

  return (
    <Dashboard
      user={user}
      onLogout={() => setUser(null)}
      onViewReport={handleViewReport} // Passed down so Dashboard can trigger navigation
    />
  )
}

export default App

import { useEffect, useState } from 'react'
import AuthPage from './pages/AuthPage'
import CoursesPage from './pages/CoursesPage'
import AssignmentsPage from './pages/AssignmentsPage'
import AssignmentDetailPage from './pages/AssignmentDetailPage'
import AccountPage from './pages/AccountPage'
import AppShell from './components/AppShell'
import { getCurrentUser, getGoogleCoursework, getImportedCoursework } from './lib/api'

// App is the root component — it owns the shared Classroom/imported-assignment data
// and drives the three-screen drill-down: Courses -> Assignments -> Assignment Detail.
function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true) // Prevents flash of wrong page on load

  const [gcAssignments, setGcAssignments] = useState([]) // Live from Google Classroom (flat list)
  const [imported, setImported] = useState([])           // Stored in our database
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState(null)

  // 'courses' | 'assignments' | 'detail' | 'account'
  const [screen, setScreen] = useState('courses')
  const [selectedCourse, setSelectedCourse] = useState(null) // { course_id, course_name }
  const [selectedAssignment, setSelectedAssignment] = useState(null) // GC assignment object
  const [selectedImportedRecord, setSelectedImportedRecord] = useState(null)

  // On first load, check if the teacher already has an active session
  useEffect(() => {
    getCurrentUser()
      .then((currentUser) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false))
  }, [])

  // Once logged in, load both the live Classroom data and what's already imported
  useEffect(() => {
    if (!user) return

    async function load() {
      setDataLoading(true)
      try {
        const [gc, imp] = await Promise.all([
          getGoogleCoursework(),
          getImportedCoursework(),
        ])
        setGcAssignments(gc)
        setImported(imp)
      } catch {
        setDataError('Failed to load assignments. Make sure the server is running.')
      } finally {
        setDataLoading(false)
      }
    }
    load()
  }, [user])

  // Don't render anything until we know the auth state
  if (authLoading) return null

  if (!user) {
    // AuthPage handles the redirect to Google — no extra props needed
    return <AuthPage />
  }

  // Called after AccountPage has already logged out / deleted the account on
  // the backend — just resets local state so AuthPage shows again.
  function handleLoggedOut() {
    setUser(null)
    setScreen('courses')
  }

  function handleProfileUpdated(updatedUser) {
    setUser(updatedUser)
  }

  // Re-fetches the imported list only — used after import/sync/context-save so
  // badges and submission counts stay fresh when navigating back
  async function refreshImported() {
    try {
      const imp = await getImportedCoursework()
      setImported(imp)
    } catch {
      // Non-fatal — the detail screen already has the latest data locally
    }
  }

  function handleSelectCourse(courseId, courseName) {
    setSelectedCourse({ course_id: courseId, course_name: courseName })
    setScreen('assignments')
  }

  function handleSelectAssignment(assignment, importedRecord) {
    setSelectedAssignment({ ...assignment, course_name: selectedCourse.course_name })
    setSelectedImportedRecord(importedRecord)
    setScreen('detail')
  }

  function handleBackToCourses() {
    setSelectedCourse(null)
    setScreen('courses')
  }

  function handleBackToAssignments() {
    setSelectedAssignment(null)
    setSelectedImportedRecord(null)
    setScreen('assignments')
  }

  function handleGoAccount() {
    setScreen('account')
  }

  // Sidebar shows Account as active on the account screen, Home as active everywhere else
  const sidebarActive = screen === 'account' ? 'account' : 'home'

  let page
  if (screen === 'account') {
    page = (
      <AccountPage
        user={user}
        onProfileUpdated={handleProfileUpdated}
        onLoggedOut={handleLoggedOut}
      />
    )
  } else if (screen === 'assignments' && selectedCourse) {
    page = (
      <AssignmentsPage
        courseId={selectedCourse.course_id}
        courseName={selectedCourse.course_name}
        gcAssignments={gcAssignments}
        imported={imported}
        onBack={handleBackToCourses}
        onSelectAssignment={handleSelectAssignment}
      />
    )
  } else if (screen === 'detail' && selectedAssignment) {
    page = (
      <AssignmentDetailPage
        assignment={selectedAssignment}
        importedRecord={selectedImportedRecord}
        onBack={handleBackToAssignments}
        onDataChange={refreshImported}
      />
    )
  } else {
    page = (
      <CoursesPage
        gcAssignments={gcAssignments}
        imported={imported}
        loading={dataLoading}
        error={dataError}
        onSelectCourse={handleSelectCourse}
      />
    )
  }

  return (
    <AppShell
      active={sidebarActive}
      displayName={user.display_name}
      onHome={handleBackToCourses}
      onAccount={handleGoAccount}
    >
      {page}
    </AppShell>
  )
}

export default App

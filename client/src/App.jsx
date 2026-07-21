import { useEffect, useState } from 'react'
import AuthPage from './pages/AuthPage'
import CoursesPage from './pages/CoursesPage'
import AssignmentsPage from './pages/AssignmentsPage'
import AssignmentDetailPage from './pages/AssignmentDetailPage'
import AccountPage from './pages/AccountPage'
import HelpPage from './pages/HelpPage'
import ReportsPage from './pages/ReportsPage'
import AppShell from './components/AppShell'
import { getCurrentUser, getGoogleCoursework, getImportedCoursework } from './lib/api'

// App is the root component — it owns the shared Classroom/imported-assignment data
// and switches between screens: Classes -> Coursework -> Assignment Detail, plus
// Account, Help, and Reports reached via the sidebar.
function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true) // Prevents flash of wrong page on load

  const [gcAssignments, setGcAssignments] = useState([]) // Live from Google Classroom (flat list)
  const [imported, setImported] = useState([])           // Stored in our database
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState(null)

  // 'courses' | 'assignments' | 'detail' | 'account' | 'help' | 'reports'
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

  function handleGoHelp() {
    setScreen('help')
  }

  function handleGoReports() {
    setScreen('reports')
  }

  // Navigate to an assignment's detail page directly from the Reports page
  // Looks up the full assignment object and imported record by coursework_id
  function handleViewAssignmentById(courseworkId) {
    const importedRecord = imported.find((cw) => cw.coursework_id === courseworkId)
    if (!importedRecord) return
    const gcAssignment = gcAssignments.find(
      (a) => a.google_coursework_id === importedRecord.google_coursework_id
    )
    if (!gcAssignment) return
    setSelectedCourse({ course_id: gcAssignment.course_id, course_name: gcAssignment.course_name })
    setSelectedAssignment({ ...gcAssignment, course_name: gcAssignment.course_name })
    setSelectedImportedRecord(importedRecord)
    setScreen('detail')
  }

  // Sidebar shows the matching item as active; Home is the fallback
  const sidebarActive = ['account', 'help', 'reports'].includes(screen) ? screen : 'home'

  let page
  if (screen === 'account') {
    page = (
      <AccountPage
        user={user}
        onProfileUpdated={handleProfileUpdated}
        onLoggedOut={handleLoggedOut}
      />
    )
  } else if (screen === 'help') {
    page = <HelpPage />
  } else if (screen === 'reports') {
    page = (
      <ReportsPage
        gcAssignments={gcAssignments}
        onViewAssignment={handleViewAssignmentById}
        onGoToAssignments={handleSelectCourse}
        onGoToClasses={handleBackToCourses}
      />
    )
  } else if (screen === 'assignments' && selectedCourse) {
    page = (
      <AssignmentsPage
        courseId={selectedCourse.course_id}
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
      onReports={handleGoReports}
      onAccount={handleGoAccount}
      onHelp={handleGoHelp}
    >
      {page}
    </AppShell>
  )
}

export default App

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

  const [gcCourses, setGcCourses] = useState([])         // Every active Google Classroom course, even ones with no assignments
  const [gcAssignments, setGcAssignments] = useState([]) // Live from Google Classroom (flat list)
  const [imported, setImported] = useState([])           // Stored in our database
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState(null)
  // Names of courses whose assignments failed to sync (not just empty) — shown as a
  // non-blocking warning since the rest of the screen still loaded successfully
  const [failedCourses, setFailedCourses] = useState([])

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

  // Load live Classroom data and imported assignments on login and every time
  // the teacher navigates back to the Classes screen — this way new classes or
  // assignments added in Google Classroom appear without a full page refresh
  useEffect(() => {
    if (!user || screen !== 'courses') return

    async function load() {
      setDataLoading(true)
      setDataError(null) // Clear any error from a previous failed attempt before retrying
      try {
        const [gc, imp] = await Promise.all([
          getGoogleCoursework(),
          getImportedCoursework(),
        ])
        setGcCourses(gc.courses)
        setGcAssignments(gc.coursework)
        setImported(imp)
        setFailedCourses(gc.failed_courses || [])
      } catch (err) {
        // Logged for us — the teacher-facing message below is deliberately
        // simplified and shouldn't include raw backend/Google error text
        console.error('Failed to load courses:', err)

        if (err instanceof TypeError) {
          // fetch() itself threw — the request never reached the server. A teacher
          // can't act on "the server," so point at what they can check instead;
          // the console.error above has the real cause for us.
          setDataError('Please check your internet and try again.')
        } else if (err.status === 401 || err.status === 404) {
          setDataError('Your Google session expired. Please log in again.')
        } else {
          setDataError('Failed to load courses from Google Classroom. Please try again in a moment.')
        }
      } finally {
        setDataLoading(false)
      }
    }
    load()
  }, [user, screen])

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
        onViewAssignment={handleViewAssignmentById}
        onGoToClasses={handleBackToCourses}
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
        onDataChange={refreshImported}
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
        courses={gcCourses}
        loading={dataLoading}
        error={dataError}
        failedCourses={failedCourses}
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

import { useEffect, useState } from 'react'
import AuthPage from './pages/AuthPage'
import CoursesPage from './pages/CoursesPage'
import AssignmentsPage from './pages/AssignmentsPage'
import AssignmentDetailPage from './pages/AssignmentDetailPage'
import AccountPage from './pages/AccountPage'
import HelpPage from './pages/HelpPage'
import ReportsPage from './pages/ReportsPage'
import AppShell from './components/AppShell'
import { getCurrentUser, getGoogleCoursework, getSyncedCoursework } from './lib/api'

// App is the root component — it owns the shared Classroom/synced-assignment data
// and switches between screens: Classes -> Coursework -> Assignment Detail, plus
// Account, Help, and Reports reached via the sidebar.
function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true) // Prevents flash of wrong page on load

  const [gcCourses, setGcCourses] = useState([])         // Every active Google Classroom course, even ones with no assignments
  const [gcAssignments, setGcAssignments] = useState([]) // Live from Google Classroom (flat list)
  const [synced, setSynced] = useState([])                // Stored in our database
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState(null)
  // Names of courses whose assignments failed to sync (not just empty) — shown as a
  // non-blocking warning since the rest of the screen still loaded successfully
  const [failedCourses, setFailedCourses] = useState([])

  // 'courses' | 'assignments' | 'detail' | 'account' | 'help' | 'reports'
  const [screen, setScreen] = useState('courses')
  const [selectedCourse, setSelectedCourse] = useState(null) // { course_id, course_name }
  const [selectedAssignment, setSelectedAssignment] = useState(null) // GC assignment object
  const [selectedSyncedRecord, setSelectedSyncedRecord] = useState(null)
  // Which tab Assignment Detail should open on — 'context' when arriving via
  // Courses (nothing to report on yet is the common case), 'report' when
  // arriving via the Reports screen (the whole point of that click is the report)
  const [detailInitialTab, setDetailInitialTab] = useState('context')

  // On first load, check if the teacher already has an active session
  useEffect(() => {
    getCurrentUser()
      .then((currentUser) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false))
  }, [])

  // Load live Classroom data and synced assignments on login and every time
  // the teacher navigates back to the Classes screen — this way new classes or
  // assignments added in Google Classroom appear without a full page refresh
  useEffect(() => {
    if (!user || screen !== 'courses') return

    async function load() {
      setDataLoading(true)
      setDataError(null) // Clear any error from a previous failed attempt before retrying
      try {
        const [gc, syncedData] = await Promise.all([
          getGoogleCoursework(),
          getSyncedCoursework(),
        ])
        setGcCourses(gc.courses)
        setGcAssignments(gc.coursework)
        setSynced(syncedData)
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

  // Called once the Google login popup confirms the session was created —
  // re-checks who's logged in so the app switches off AuthPage immediately,
  // without a full page reload (the main window never navigated away)
  async function handleLoginSuccess() {
    const currentUser = await getCurrentUser()
    setUser(currentUser)
  }

  if (!user) {
    return <AuthPage onLoginSuccess={handleLoginSuccess} />
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

  // Re-fetches the synced list only — used after sync/context-save so
  // badges and submission counts stay fresh when navigating back
  async function refreshSynced() {
    try {
      const syncedData = await getSyncedCoursework()
      setSynced(syncedData)
    } catch {
      // Non-fatal — the detail screen already has the latest data locally
    }
  }

  function handleSelectCourse(courseId, courseName) {
    setSelectedCourse({ course_id: courseId, course_name: courseName })
    setScreen('assignments')
  }

  function handleSelectAssignment(assignment, syncedRecord) {
    setSelectedAssignment({ ...assignment, course_name: selectedCourse.course_name })
    setSelectedSyncedRecord(syncedRecord)
    setDetailInitialTab('context')
    setScreen('detail')
  }

  function handleBackToCourses() {
    setSelectedCourse(null)
    setScreen('courses')
  }

  function handleBackToAssignments() {
    setSelectedAssignment(null)
    setSelectedSyncedRecord(null)
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
  // Looks up the full assignment object and synced record by coursework_id
  function handleViewAssignmentById(courseworkId) {
    const syncedRecord = synced.find((cw) => cw.coursework_id === courseworkId)
    if (!syncedRecord) return
    const gcAssignment = gcAssignments.find(
      (a) => a.google_coursework_id === syncedRecord.google_coursework_id
    )
    if (!gcAssignment) return
    setSelectedCourse({ course_id: gcAssignment.course_id, course_name: gcAssignment.course_name })
    setSelectedAssignment({ ...gcAssignment, course_name: gcAssignment.course_name })
    setSelectedSyncedRecord(syncedRecord)
    setDetailInitialTab('report')
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
        synced={synced}
        onBack={handleBackToCourses}
        onSelectAssignment={handleSelectAssignment}
        onDataChange={refreshSynced}
      />
    )
  } else if (screen === 'detail' && selectedAssignment) {
    page = (
      <AssignmentDetailPage
        assignment={selectedAssignment}
        syncedRecord={selectedSyncedRecord}
        initialTab={detailInitialTab}
        onBack={handleBackToAssignments}
        onDataChange={refreshSynced}
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

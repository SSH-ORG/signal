import { useEffect, useState } from 'react'
import AuthPage from './pages/AuthPage'
import CoursesPage from './pages/CoursesPage'
import AssignmentsPage from './pages/AssignmentsPage'
import AssignmentDetailPage from './pages/AssignmentDetailPage'
import { getCurrentUser, logout, getGoogleCoursework, getImportedCoursework } from './lib/api'

// App is the root component — it owns the shared Classroom/imported-assignment data
// and drives the three-screen drill-down: Courses -> Assignments -> Assignment Detail.
function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true) // Prevents flash of wrong page on load

  const [gcAssignments, setGcAssignments] = useState([]) // Live from Google Classroom (flat list)
  const [imported, setImported] = useState([])           // Stored in our database
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState(null)

  // 'courses' | 'assignments' | 'detail'
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

  async function handleLogout() {
    await logout()
    setUser(null)
    setScreen('courses')
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

  if (screen === 'assignments' && selectedCourse) {
    return (
      <AssignmentsPage
        courseId={selectedCourse.course_id}
        courseName={selectedCourse.course_name}
        gcAssignments={gcAssignments}
        imported={imported}
        onBack={handleBackToCourses}
        onSelectAssignment={handleSelectAssignment}
      />
    )
  }

  if (screen === 'detail' && selectedAssignment) {
    return (
      <AssignmentDetailPage
        assignment={selectedAssignment}
        importedRecord={selectedImportedRecord}
        onBack={handleBackToAssignments}
        onDataChange={refreshImported}
      />
    )
  }

  return (
    <CoursesPage
      gcAssignments={gcAssignments}
      imported={imported}
      loading={dataLoading}
      error={dataError}
      onLogout={handleLogout}
      onSelectCourse={handleSelectCourse}
    />
  )
}

export default App

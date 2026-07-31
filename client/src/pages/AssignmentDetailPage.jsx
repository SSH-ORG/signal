import { useEffect, useMemo, useRef, useState } from 'react'
import { getReport, buildReport, emailReport, syncCoursework, updateCourseworkContext, getGCRubric, getGCDescription, getSubmissions, buildStudentReport, emailStudentReport, sendReportToStudent, getCourseRoster } from '../lib/api'
import Icon from '../components/Icon'
import ReportBody, { StudentReportSummary } from '../components/ReportBody'
import { parseFlaggedStudents, splitSections, findBody, parseBullets } from '../lib/reportParsing'
import './Screens.css'
import './AssignmentDetailPage.css'

// Pulls one labeled section (Mental Model / Assignment Description / Rubric)
// back out of a previously-saved combined context string, so reopening an
// assignment restores each field to where it actually belongs instead of
// resetting to blank or dumping everything into the wrong box.
function extractContextSection(savedContext, label) {
  if (!savedContext) return ''
  const pattern = new RegExp(
    `${label}:\\n([\\s\\S]*?)(?:\\n\\n(?:Mental Model|Assignment Description|Rubric):|$)`
  )
  const match = savedContext.match(pattern)
  return match ? match[1].trim() : ''
}

// Pulls the current Next Step text out of a student report, so the "Email to
// student" draft starts pre-filled with what's already there — same fallback
// as StudentReportSummary in case the AI didn't use bullet formatting
function extractNextStep(studentReport) {
  if (!studentReport) return ''
  const body = findBody(splitSections(studentReport), 'Next Step')
  const bullets = parseBullets(body)
  return bullets[0] || body.trim()
}

// Third screen — shown when a teacher clicks into a specific assignment.
// Lets the teacher review/edit the mental model and supporting materials,
// sync submissions, and build/view the AI confusion report.
function AssignmentDetailPage({ assignment, syncedRecord, initialTab, onBack, onDataChange }) {
  // Local copy of the synced record so this screen can react immediately to
  // sync/context-save actions without waiting on a parent re-fetch
  const [record, setRecord] = useState(syncedRecord)
  // 'context' | 'report' — only relevant once record exists (before that,
  // there's nothing to report on yet, so Context is the only thing shown).
  // Arriving from the Reports screen opens straight to Report, since that's
  // the entire point of that click.
  const [activeTab, setActiveTab] = useState(initialTab || 'context')
  // The teacher's own words — restored from the saved context, never touched by syncing
  const [mentalModelText, setMentalModelText] = useState(
    () => extractContextSection(syncedRecord?.context, 'Mental Model')
  )
  // Restored from the saved context like Mental Model/Rubric, so a teacher's edits
  // survive a revisit — falls back to the live Classroom description only the first
  // time, before anything has ever been saved.
  const [descriptionText, setDescriptionText] = useState(
    () => extractContextSection(syncedRecord?.context, 'Assignment Description') || assignment.description || ''
  )
  const [rubricText, setRubricText] = useState(
    () => extractContextSection(syncedRecord?.context, 'Rubric')
  )
  // Each reference material can be left out of what's actually sent to the AI
  // while still staying visible/editable — e.g. excluding the rubric if a
  // teacher doesn't want its grading-criteria framing to influence the report.
  const [includeDescription, setIncludeDescription] = useState(true)
  const [includeRubric, setIncludeRubric] = useState(true)
  const [syncingSubmissions, setSyncingSubmissions] = useState(false)
  const [syncingDescription, setSyncingDescription] = useState(false)
  const [syncingRubric, setSyncingRubric] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [descriptionError, setDescriptionError] = useState(null)
  const [rubricError, setRubricError] = useState(null)
  const [actionError, setActionError] = useState(null)

  const [report, setReport] = useState(null)
  const [loadingReport, setLoadingReport] = useState(!!syncedRecord)
  const [building, setBuilding] = useState(false)
  const [reportError, setReportError] = useState(null)
  const [emailing, setEmailing] = useState(false)
  const [emailError, setEmailError] = useState(null)
  const [emailSuccess, setEmailSuccess] = useState(false)

  // 'classwide' | 'students' — Students lists everyone (submitted or not), works
  // whether or not a classwide report has ever been built, and highlights
  // whoever the classwide report flagged once one exists
  const [reportMode, setReportMode] = useState('classwide')
  const [submissions, setSubmissions] = useState([])
  // null = not fetched yet (fetched once, on first visit to the Students tab —
  // never re-fetched on later tab switches, so flipping between tabs doesn't
  // repeatedly hit Google's API)
  const [roster, setRoster] = useState(null)
  const [studentSearch, setStudentSearch] = useState('')
  // { key, message } for whichever student's Build press just failed/was
  // rejected — shown inline on that specific row instead of a single banner
  // at the top of a potentially long, scrolled list, so it's actually visible
  // right where the teacher was looking when they clicked
  const [studentActionError, setStudentActionError] = useState(null)
  const [buildingStudentId, setBuildingStudentId] = useState(null) // submission_id currently building
  // submission_id of the student whose report is open in the popup, or null
  const [openReportId, setOpenReportId] = useState(null)
  const [emailingStudent, setEmailingStudent] = useState(false)
  const [sendingToStudent, setSendingToStudent] = useState(false)
  const [studentEmailSuccess, setStudentEmailSuccess] = useState(null) // 'me' | 'student' | null
  const [studentEmailError, setStudentEmailError] = useState(null)
  // Whether the "Email Report" dropdown (To me / To student) is open —
  // collapses back whenever the modal switches students
  const [choosingEmailRecipient, setChoosingEmailRecipient] = useState(false)
  // Whether "Email to student" has opened the Next Step edit-before-send view
  const [editingNextStep, setEditingNextStep] = useState(false)
  const [nextStepDraft, setNextStepDraft] = useState('')
  const emailDropdownRef = useRef(null)

  // Closes the email dropdown on Escape or on any click outside it
  useEffect(() => {
    if (!choosingEmailRecipient) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') setChoosingEmailRecipient(false)
    }
    function handleClickOutside(e) {
      if (emailDropdownRef.current && !emailDropdownRef.current.contains(e.target)) {
        setChoosingEmailRecipient(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    const timer = setTimeout(() => window.addEventListener('click', handleClickOutside), 0)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('click', handleClickOutside)
      clearTimeout(timer)
    }
  }, [choosingEmailRecipient])

  const courseworkId = record?.coursework_id

  // Load the existing classwide report (if any) once the assignment has been synced
  useEffect(() => {
    if (!courseworkId) return
    getReport(courseworkId)
      .then((data) => setReport(data))
      .catch(() => setReportError('Failed to load report.'))
      .finally(() => setLoadingReport(false))
  }, [courseworkId])

  // Load submissions (with any student reports) when switching to the Students tab
  useEffect(() => {
    if (!courseworkId || reportMode !== 'students') return
    getSubmissions(courseworkId).then(setSubmissions).catch(() => {})
  }, [courseworkId, reportMode])

  // Roster is fetched once, the first time the Students tab is opened — the
  // `roster !== null` check means flipping back to this tab later never
  // re-fetches it, so it never hits Google's API more than once per visit
  // to this page. Falls back to an empty list (submitters only) on failure
  // instead of retrying forever.
  useEffect(() => {
    if (!assignment.course_id || reportMode !== 'students' || roster !== null) return
    getCourseRoster(assignment.course_id).then(setRoster).catch(() => setRoster([]))
  }, [assignment.course_id, reportMode, roster])

  // Flagged students come straight from the classwide report's own "Flagged
  // Students" section — no student report needs to exist yet to know who's flagged
  const flaggedStudents = useMemo(() => parseFlaggedStudents(report?.content), [report])

  // _displayName matches on the same positional "Student N" fallback the
  // backend used when building the classwide prompt (raw fetch order) — this
  // is what flagged-name matching below has to compare against, since that's
  // literally what the AI was told to call this student. _niceName is purely
  // for what's shown to the teacher — falls back to the roster's real name
  // before resorting to "Student N", for submissions synced before names were
  // backfilled. Keeping these separate means a nicer displayed name can never
  // cause a real flagged student to stop matching.
  const submissionsWithDisplayNames = useMemo(() => {
    const rosterNameById = new Map((roster || []).map((r) => [r.google_user_id, r.name]))
    return submissions.map((s, i) => {
      const fallbackName = `Student ${i + 1}`
      return {
        ...s,
        _displayName: s.student_name || fallbackName,
        _niceName: s.student_name || rosterNameById.get(s.google_user_id) || fallbackName,
      }
    })
  }, [submissions, roster])

  // Full student list for the Students tab — everyone who submitted, plus
  // anyone from the roster who hasn't, so a teacher can search/select any
  // student rather than only whoever the AI happened to flag. "Flagged" is
  // now just a highlight/sort cue on top of that, not a gate.
  const allStudents = useMemo(() => {
    const flaggedNameSet = new Set(flaggedStudents.map((f) => f.name.trim().toLowerCase()))
    const isFlagged = (name) => flaggedNameSet.has(name.trim().toLowerCase())

    const submittedUserIds = new Set(
      submissionsWithDisplayNames.map((s) => s.google_user_id).filter(Boolean)
    )

    const submitters = submissionsWithDisplayNames.map((s) => ({
      key: `submission-${s.submission_id}`,
      name: s._niceName,
      // What flagged-name matching actually compares against — kept separate
      // from the (possibly nicer) displayed name, see the comment above
      matchName: s._displayName,
      hasSubmitted: true,
      flagged: isFlagged(s._displayName),
      submission: s,
    }))

    const nonSubmitters = (roster || [])
      .filter((r) => !submittedUserIds.has(r.google_user_id))
      .map((r) => ({
        key: `roster-${r.google_user_id}`,
        name: r.name,
        matchName: r.name,
        hasSubmitted: false,
        flagged: isFlagged(r.name),
        submission: null,
      }))

    return [...submitters, ...nonSubmitters].sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [submissionsWithDisplayNames, roster, flaggedStudents])

  const filteredStudents = useMemo(() => {
    const query = studentSearch.trim().toLowerCase()
    if (!query) return allStudents
    return allStudents.filter((s) => s.name.toLowerCase().includes(query))
  }, [allStudents, studentSearch])

  // Flagged by the AI, but no student (submitted or not) matched that name —
  // a data problem (e.g. a roster mismatch), not a clean report
  const unmatchedFlaggedCount = useMemo(() => {
    const matchedNames = new Set(allStudents.filter((s) => s.flagged).map((s) => s.matchName.trim().toLowerCase()))
    return flaggedStudents.filter((f) => !matchedNames.has(f.name.trim().toLowerCase())).length
  }, [flaggedStudents, allStudents])

  // Opens/closes the student report popup and clears any leftover email
  // status from a previous student in the same step, so it never leaks
  // between them — called from every place that changes which report is
  // open, instead of a separate effect watching openReportId for this
  useEffect(() => {
    if (!openReportId) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') setStudentReportModal(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openReportId])

  function setStudentReportModal(submissionId) {
    setEmailingStudent(false)
    setSendingToStudent(false)
    setStudentEmailSuccess(null)
    setStudentEmailError(null)
    setChoosingEmailRecipient(false)
    setEditingNextStep(false)
    setOpenReportId(submissionId)
  }

  // Mental model, description, and rubric are edited separately but combined
  // into one labeled string for the AI — the report only reads a single context
  // field, but labeling each piece lets the model tell the teacher's own goal
  // apart from reference material instead of reading one undifferentiated blob.
  function combinedContext() {
    return [
      mentalModelText && `Mental Model:\n${mentalModelText}`,
      includeDescription && descriptionText && `Assignment Description:\n${descriptionText}`,
      includeRubric && rubricText && `Rubric:\n${rubricText}`,
    ].filter(Boolean).join('\n\n')
  }

  // First sync now happens automatically when a teacher opens or revisits the
  // Coursework screen (see AssignmentsPage), so by the time this page is reached
  // an assignment is normally already synced — this button just refreshes the
  // submission count. It's still able to create the record too (syncCoursework
  // is idempotent either way), which only matters if this page is somehow reached
  // before that automatic sync has run yet. Deliberately does NOT touch the
  // description — see handleSyncDescription for that, same pattern as Sync Rubric.
  async function handleRefreshSubmissions() {
    setSyncingSubmissions(true)
    setActionError(null)
    try {
      const result = await syncCoursework(
        assignment.google_coursework_id, assignment.course_id, combinedContext(), assignment.course_name
      )
      if (!record) setLoadingReport(true) // first sync — the effect above is about to fetch the (nonexistent) report
      setRecord((prev) => ({
        coursework_id: result.coursework_id,
        google_coursework_id: assignment.google_coursework_id,
        title: result.title,
        context: prev ? prev.context : combinedContext(),
        submission_count: result.total_submissions,
      }))
      // The Students tab's own submissions list only refetches when reportMode
      // changes — if a teacher is already on that tab when they click Refresh,
      // it would otherwise sit stale (new/updated submissions invisible, "Build"
      // unavailable for anyone just synced in) until they left and came back.
      if (reportMode === 'students') {
        getSubmissions(result.coursework_id).then(setSubmissions).catch(() => {})
      }
      onDataChange()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setSyncingSubmissions(false)
    }
  }

  // Pulls the current description from Google Classroom — a pure read, so it
  // works even before the assignment has been synced into Signal at all.
  // Replaces descriptionText outright, same as Sync Rubric — this is the only
  // thing that should ever overwrite a teacher's own custom description.
  async function handleSyncDescription() {
    setSyncingDescription(true)
    setDescriptionError(null)
    try {
      const freshDescription = await getGCDescription(assignment.google_coursework_id, assignment.course_id)
      setDescriptionText(freshDescription || '')
      setSaveSuccess(false)
    } catch (err) {
      setDescriptionError(err.message)
    } finally {
      setSyncingDescription(false)
    }
  }

  // Pulls the current rubric from Google Classroom — a pure read, so it works
  // even before the assignment has been synced into Signal at all. Replaces
  // rubricText rather than appending, since that box mirrors Classroom's rubric.
  async function handleSyncRubric() {
    setSyncingRubric(true)
    setRubricError(null)
    try {
      const freshRubric = await getGCRubric(assignment.google_coursework_id, assignment.course_id)
      if (freshRubric) {
        setRubricText(freshRubric)
      } else {
        setRubricError('No rubric found on this assignment in Google Classroom.')
      }
    } catch (err) {
      setRubricError(err.message)
    } finally {
      setSyncingRubric(false)
    }
  }

  async function handleSaveContext() {
    if (!record) return
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      const updated = await updateCourseworkContext(record.coursework_id, combinedContext())
      setRecord((prev) => ({ ...prev, context: updated.context }))
      onDataChange()
      setSaveSuccess(true)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleBuild() {
    setBuilding(true)
    setReportError(null)
    try {
      const data = await buildReport(record.coursework_id)
      setReport(data)
      setActiveTab('report')
    } catch (err) {
      setReportError(err.message)
    } finally {
      setBuilding(false)
    }
  }

  async function handleEmailReport() {
    setEmailing(true)
    setEmailError(null)
    setEmailSuccess(false)
    try {
      await emailReport(record.coursework_id)
      setEmailSuccess(true)
    } catch (err) {
      setEmailError(err.message)
    } finally {
      setEmailing(false)
    }
  }

  // Returns whether it succeeded, so a single-card click can decide whether
  // to auto-open the report right after building it
  async function handleBuildSubmissionReport(submissionId) {
    setBuildingStudentId(submissionId)
    try {
      const result = await buildStudentReport(record.coursework_id, submissionId)
      setSubmissions((prev) =>
        prev.map((s) =>
          s.submission_id === submissionId
            ? { ...s, student_report: result.student_report }
            : s
        )
      )
      return true
    } catch {
      return false
    } finally {
      setBuildingStudentId(null)
    }
  }

  async function handleEmailStudent(submissionId) {
    setChoosingEmailRecipient(false)
    setEmailingStudent(true)
    setStudentEmailError(null)
    setStudentEmailSuccess(null)
    try {
      await emailStudentReport(record.coursework_id, submissionId)
      setStudentEmailSuccess('me')
    } catch (err) {
      setStudentEmailError(err.message)
    } finally {
      setEmailingStudent(false)
    }
  }

  // "Email to student" opens this edit view instead of sending right away —
  // pre-filled with the current Next Step text so a teacher can tailor the
  // wording (e.g. "you should..." instead of "the student should...") before
  // it goes out, without that edit touching the stored report
  function handleOpenNextStepEdit(studentReport) {
    setChoosingEmailRecipient(false)
    setStudentEmailError(null)
    setNextStepDraft(extractNextStep(studentReport))
    setEditingNextStep(true)
  }

  async function handleSendToStudent(submissionId) {
    setEditingNextStep(false)
    setSendingToStudent(true)
    setStudentEmailError(null)
    setStudentEmailSuccess(null)
    try {
      await sendReportToStudent(record.coursework_id, submissionId, nextStepDraft)
      setStudentEmailSuccess('student')
    } catch (err) {
      setStudentEmailError(err.message)
    } finally {
      setSendingToStudent(false)
    }
  }

  // Opening an existing report never costs anything, so this is safe to fire
  // straight from a click with no confirmation step
  function handleViewStudentReport(student) {
    setStudentReportModal(student.submission.submission_id)
  }

  // Building one does cost a Groq call, so this is only ever wired to its own
  // explicit "Build" button — never triggered just by clicking/selecting a
  // student — so browsing the list never silently spends anything. A
  // non-submitter has nothing to build from, so this shows a message instead.
  async function handleBuildStudentReport(student) {
    setStudentActionError(null)
    if (!student.hasSubmitted) {
      setStudentActionError({
        key: student.key,
        message: `${student.name} hasn't turned this in.`,
      })
      return
    }
    const success = await handleBuildSubmissionReport(student.submission.submission_id)
    if (success) {
      setStudentReportModal(student.submission.submission_id)
    } else {
      setStudentActionError({ key: student.key, message: `Failed to build a report for ${student.name}. Try again.` })
    }
  }

  // A report with nothing to compare submissions against is nearly always
  // shallow and generic — Build/Refresh are disabled until there's at least
  // a mental model, description, or rubric to work with
  const hasContext = combinedContext().trim().length > 0

  return (
    <div className="screen">
      <main className="screen-main detail-main">
        <div>
          <button className="back-btn" onClick={onBack}>← coursework</button>
        </div>

        <div>
          <h1 className="screen-title">{assignment.title}</h1>

          {/* Submission count and the action that refreshes it live together —
              creates the record on first click (unlocking everything below)
              and re-syncs the count afterward. Not Context-specific, so it
              lives outside both tabs. */}
          <div className="submission-status">
            <p className="screen-subtitle">
              {record
                ? `${record.submission_count} ${record.submission_count === 1 ? 'submission' : 'submissions'}`
                : 'Not synced yet'}
            </p>
            <button
              type="button"
              className="sync-icon-btn"
              onClick={handleRefreshSubmissions}
              disabled={syncingSubmissions}
              aria-label={syncingSubmissions ? 'refreshing…' : 'refresh'}
              data-tooltip={syncingSubmissions ? 'refreshing…' : 'refresh'}
            >
              <Icon name="sync" className="sync-btn-icon" />
            </button>
          </div>
          {actionError && <p className="report-error">{actionError}</p>}
        </div>

        {/* Once synced, Context and AI Report are separate tabs — before
            that, there's nothing to report on yet, so just Context shows. */}
        {record && (
          <div className="tab-list" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'context'}
              className={`tab-btn${activeTab === 'context' ? ' tab-btn--active' : ''}`}
              onClick={() => setActiveTab('context')}
            >
              Context
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'report'}
              className={`tab-btn${activeTab === 'report' ? ' tab-btn--active' : ''}`}
              onClick={() => setActiveTab('report')}
            >
              AI Report
            </button>
          </div>
        )}

        {(!record || activeTab === 'context') && (
          <section className="detail-section">
            {/* No tabs exist yet before the first sync, so this needs its own
                label; once record exists, the "Context" tab already says it. */}
            {!record && <h2 className="detail-section-title">Context</h2>}

            {/* Mental Model (primary) sits side by side with Reference
                Materials (secondary) — both feed into the same combined
                context string the AI report reads. */}
            <div className="context-columns">
              <div className="context-column-group">
                <div className="context-column">
                  <h3 className="context-group-label">Mental Model</h3>
                  <p className="detail-section-hint">
                    What does student understanding look like? This is what the AI compares
                    submissions against.
                  </p>
                  <textarea
                    className="context-textarea"
                    value={mentalModelText}
                    onChange={(e) => { setMentalModelText(e.target.value); setSaveSuccess(false) }}
                    placeholder="e.g., Students should be able to explain photosynthesis in their own words."
                    rows={8}
                  />
                </div>
                {/* Kept right under the Mental Model box (but outside it) instead of at
                    the bottom of the whole section, so it's not easy to miss after editing */}
                {record && (
                  <div className="context-actions">
                    <button className="primary-btn" onClick={handleSaveContext} disabled={saving}>
                      {saving ? 'Saving…' : 'Save Context'}
                    </button>
                    {saveSuccess && <p className="save-success">Saved</p>}
                    {saveError && <p className="report-error">{saveError}</p>}
                  </div>
                )}
              </div>

              <div className="context-column supporting-materials">
                <h3 className="context-group-label">Reference Materials</h3>
                <p className="detail-section-hint">
                  Materials synced from Google Classroom. Can be used alongside your mental
                  model or as context on its own.
                </p>

                <div className="context-field">
                  <div className="context-field-header">
                    <h4 className="context-field-label">Assignment Description</h4>
                    <label className="context-field-toggle">
                      <input
                        type="checkbox"
                        checked={includeDescription}
                        onChange={(e) => { setIncludeDescription(e.target.checked); setSaveSuccess(false) }}
                      />
                      Include
                    </label>
                  </div>
                  <textarea
                    className="context-textarea context-textarea--small"
                    value={descriptionText}
                    onChange={(e) => { setDescriptionText(e.target.value); setSaveSuccess(false) }}
                    placeholder="No description found in Google Classroom, add one here."
                    rows={3}
                  />
                  <button
                    type="button"
                    className="sync-btn sync-btn--small"
                    onClick={handleSyncDescription}
                    disabled={syncingDescription}
                  >
                    <Icon name="sync" className="sync-btn-icon" />
                    {syncingDescription ? 'Syncing…' : 'Sync Description'}
                  </button>
                  {descriptionError && <p className="report-error">{descriptionError}</p>}
                </div>

                <div className="context-field">
                  <div className="context-field-header">
                    <h4 className="context-field-label">Rubric</h4>
                    <label className="context-field-toggle">
                      <input
                        type="checkbox"
                        checked={includeRubric}
                        onChange={(e) => { setIncludeRubric(e.target.checked); setSaveSuccess(false) }}
                      />
                      Include
                    </label>
                  </div>
                  <p className="detail-section-hint">
                    Used as context to assess understanding. NOT for grading submissions.
                  </p>
                  <textarea
                    className="context-textarea context-textarea--small"
                    value={rubricText}
                    onChange={(e) => { setRubricText(e.target.value); setSaveSuccess(false) }}
                    placeholder="No rubric yet. Sync Rubric from Google Classroom, or add one here."
                    rows={3}
                  />
                  <button
                    type="button"
                    className="sync-btn sync-btn--small"
                    onClick={handleSyncRubric}
                    disabled={syncingRubric}
                  >
                    <Icon name="sync" className="sync-btn-icon" />
                    {syncingRubric ? 'Syncing…' : 'Sync Rubric'}
                  </button>
                  {rubricError && <p className="report-error">{rubricError}</p>}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* AI report — its own tab, only reachable once the assignment has been synced */}
        {record && activeTab === 'report' && (
          <section className="detail-section">
            {/* Classwide vs Flagged mode toggle */}
            <div className="report-mode-toggle">
              <button
                type="button"
                className={`report-mode-btn${reportMode === 'classwide' ? ' report-mode-btn--active' : ''}`}
                onClick={() => setReportMode('classwide')}
              >
                Classwide
              </button>
              <button
                type="button"
                className={`report-mode-btn${reportMode === 'students' ? ' report-mode-btn--active' : ''}`}
                onClick={() => setReportMode('students')}
              >
                Student
              </button>
            </div>

            {/* ── CLASSWIDE ── */}
            {reportMode === 'classwide' && (
              <>
                {loadingReport && <p className="report-status">Loading…</p>}

                {!loadingReport && !report && !reportError && (
                  <div className="report-empty">
                    <p className={hasContext ? 'report-empty-text' : 'report-empty-text report-empty-text--warning'}>
                      {hasContext
                        ? 'No report built yet.'
                        : 'No report built yet. Add context first.'}
                    </p>
                    <button className="build-btn" onClick={handleBuild} disabled={building || !hasContext}>
                      {building ? 'Building…' : 'Build'}
                    </button>
                  </div>
                )}

                {!loadingReport && report && (
                  <div className="report-content">
                    <div className="report-header">
                      <div className="report-timestamp">
                        {new Date(report.created_at).toLocaleDateString('en-US', {
                          month: 'long', day: 'numeric', year: 'numeric',
                        })}
                      </div>
                      <div className="report-actions">
                        <button
                          className="secondary-btn"
                          onClick={handleBuild}
                          disabled={building}
                        >
                          {building ? 'Refreshing…' : 'Refresh Report'}
                        </button>
                        <button className="secondary-btn" onClick={handleEmailReport} disabled={emailing}>
                          {emailing ? 'Sending…' : 'Email Report'}
                        </button>
                      </div>
                    </div>
                    {emailSuccess && <p className="save-success">Sent to your email</p>}
                    {emailError && <p className="report-error">{emailError}</p>}
                    <ReportBody content={report.content} mode="classwide" />
                  </div>
                )}

                {reportError && !building && <p className="report-error">{reportError}</p>}
              </>
            )}

            {/* ── STUDENTS ── */}
            {reportMode === 'students' && (
              <div className="student-list">
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search students…"
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  aria-label="Search students"
                />

                {!report && (
                  <p className="report-status">
                    No classwide report yet — you can still search for and build a report for any student below.
                  </p>
                )}

                {/* Distinguished from "no students flagged" — this means the report DID
                    flag students, but none of those names matched anyone in this list
                    (e.g. a roster mismatch), which is a data problem, not a clean report. */}
                {report && unmatchedFlaggedCount > 0 && (
                  <p className="report-error">
                    {unmatchedFlaggedCount} flagged student{unmatchedFlaggedCount !== 1 ? 's' : ''} couldn't be
                    matched to anyone below. Try refreshing the report.
                  </p>
                )}

                {allStudents.length === 0 && (
                  <p className="report-status">No students found for this assignment yet.</p>
                )}

                {allStudents.length > 0 && filteredStudents.length === 0 && (
                  <p className="report-status">No students match your search.</p>
                )}

                <div className="student-card-grid">
                  {filteredStudents.map((student) =>
                    student.hasSubmitted && student.submission.student_report ? (
                      <button
                        key={student.key}
                        type="button"
                        className="student-row student-row--clickable"
                        onClick={() => handleViewStudentReport(student)}
                      >
                        <div className="student-card-info">
                          <span className="student-card-name">{student.name}</span>
                          {student.flagged && <span className="student-flagged-badge">Flagged</span>}
                        </div>
                        <Icon name="chevron_right" className="student-card-chevron" />
                      </button>
                    ) : (
                      <div key={student.key} className="student-row student-row--column">
                        <div className="student-row-main">
                          <div className="student-card-info">
                            <span className="student-card-name">{student.name}</span>
                            {student.flagged && <span className="student-flagged-badge">Flagged</span>}
                          </div>
                          {buildingStudentId === student.submission?.submission_id ? (
                            <span className="student-card-building">…</span>
                          ) : (
                            <button
                              type="button"
                              className="student-build-btn"
                              onClick={() => handleBuildStudentReport(student)}
                            >
                              Build
                            </button>
                          )}
                        </div>
                        {/* Shown right on the row that triggered it, not a banner elsewhere
                            on the page — otherwise it can render off-screen above a
                            scrolled list and look like nothing happened at all */}
                        {studentActionError?.key === student.key && (
                          <p className="report-error student-row-error">{studentActionError.message}</p>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Student report popup — opened by clicking a student's name above */}
        {openReportId && (() => {
          const sub = submissions.find((s) => s.submission_id === openReportId)
          if (!sub || !sub.student_report) return null
          const idx = submissions.indexOf(sub)
          const displayName = sub.student_name || `Student ${idx + 1}`
          return (
            <div className="modal-backdrop" onClick={() => setStudentReportModal(null)}>
              <div
                className="modal-card modal-card--report"
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="modal-close"
                  type="button"
                  aria-label="Close"
                  onClick={() => setStudentReportModal(null)}
                >
                  <Icon name="close" />
                </button>
                <div className="modal-header-row">
                  <h2 className="modal-title">{displayName}</h2>
                  <div className="report-actions">
                    <button
                      className="secondary-btn"
                      onClick={() => handleBuildSubmissionReport(sub.submission_id)}
                      disabled={buildingStudentId === sub.submission_id}
                    >
                      {buildingStudentId === sub.submission_id ? 'Refreshing…' : 'Refresh Report'}
                    </button>
                    <div className="email-dropdown-wrapper" ref={emailDropdownRef}>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => setChoosingEmailRecipient((v) => !v)}
                        disabled={emailingStudent || sendingToStudent}
                      >
                        {emailingStudent || sendingToStudent ? 'Sending…' : 'Email Report'}
                        <Icon name={choosingEmailRecipient ? 'expand_less' : 'expand_more'} />
                      </button>
                      {choosingEmailRecipient && (
                        <div className="email-dropdown-menu">
                          <button
                            type="button"
                            className="email-dropdown-item"
                            onClick={() => handleEmailStudent(sub.submission_id)}
                          >
                            Email to me
                          </button>
                          <button
                            type="button"
                            className="email-dropdown-item"
                            onClick={() => handleOpenNextStepEdit(sub.student_report)}
                          >
                            Email to student
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {editingNextStep && (
                  <p className="next-step-edit-pointer">
                    <Icon name="arrow_downward" />
                    Edit the Next Step below before sending.
                  </p>
                )}
                {studentEmailSuccess === 'me' && <p className="save-success">Sent to your email</p>}
                {studentEmailSuccess === 'student' && <p className="save-success">Sent to the student</p>}
                {studentEmailError && <p className="report-error">{studentEmailError}</p>}

                <div className="student-report-body">
                  <StudentReportSummary
                    content={sub.student_report}
                    submissionContent={sub.content}
                    studentName={displayName}
                    editingNextStep={editingNextStep}
                    nextStepDraft={nextStepDraft}
                    onNextStepDraftChange={setNextStepDraft}
                    onSendToStudent={() => handleSendToStudent(sub.submission_id)}
                    onCancelEdit={() => setEditingNextStep(false)}
                    sendingToStudent={sendingToStudent}
                  />
                </div>
              </div>
            </div>
          )
        })()}
      </main>
    </div>
  )
}


export default AssignmentDetailPage

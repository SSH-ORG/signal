import { useEffect, useMemo, useRef, useState } from 'react'
import { getReport, buildReport, emailReport, syncCoursework, updateCourseworkContext, getGCRubric, getGCDescription, getSubmissions, buildStudentReport, emailStudentReport, draftStudentEmail, sendReportToStudent, buildNudge, sendNudge } from '../lib/api'
import Icon from '../components/Icon'
import ReportBody, { StudentReportSummary, NudgeSummary } from '../components/ReportBody'
import { parseFlaggedStudents, parseSolidStudents } from '../lib/reportParsing'
import './Screens.css'
import './AssignmentDetailPage.css'

// Module-scoped (not component state) so it survives navigating away and back —
// skips re-syncing an assignment that was already synced in the last 10s, so
// quick back-and-forth navigation doesn't spam Google's API
const lastSyncedAt = new Map()
const SYNC_DEBOUNCE_MS = 10_000


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
  // The teacher's own words — read directly from its own column, never touched
  // by syncing. No parsing: each field is stored separately on the backend now,
  // so a teacher's own text can never be mistaken for a section boundary and
  // silently truncated (the bug that used to make a saved Mental Model vanish).
  const [mentalModelText, setMentalModelText] = useState(() => syncedRecord?.mental_model || '')
  // Restored from its own column like Mental Model/Rubric, so a teacher's edits
  // survive a revisit — falls back to the live Classroom description only the first
  // time, before anything has ever been saved.
  const [descriptionText, setDescriptionText] = useState(
    () => syncedRecord?.assignment_description || assignment.description || ''
  )
  const [rubricText, setRubricText] = useState(() => syncedRecord?.rubric || '')
  // Each reference material can be left out of what's actually sent to the AI
  // while still staying visible/editable — e.g. excluding the rubric if a
  // teacher doesn't want its grading-criteria framing to influence the report.
  // Restored from the saved record so the choice persists across visits.
  const [includeDescription, setIncludeDescription] = useState(() => syncedRecord?.include_description ?? true)
  const [includeRubric, setIncludeRubric] = useState(() => syncedRecord?.include_rubric ?? true)
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
  // Skip the loading state entirely when we already know (from the synced list)
  // that no report has been built yet — no point spinning for a call we know will 404
  const [loadingReport, setLoadingReport] = useState(!!syncedRecord && syncedRecord.has_report !== false)
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
  const [studentSearch, setStudentSearch] = useState('')
  // { key, message } for whichever student's Build press just failed/was
  // rejected — shown inline on that specific row instead of a single banner
  // at the top of a potentially long, scrolled list, so it's actually visible
  // right where the teacher was looking when they clicked
  const [studentActionError, setStudentActionError] = useState(null)
  // Error from the open modal's own Refresh Report button — separate from
  // studentActionError (the row-level list), since the modal is a different
  // place on screen and needs its own visible spot for a failure
  const [modalActionError, setModalActionError] = useState(null)
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
  // Whether "Email to student" has opened the review/edit-before-send view
  const [editingStudentEmail, setEditingStudentEmail] = useState(false)
  // { submissionSummary, understands, misconceptions, nextStep } | null
  const [emailDraft, setEmailDraft] = useState(null)
  // True while the second-person AI rewrite is being drafted, between clicking
  // "Email to student" and the review view actually opening
  const [draftingStudentEmail, setDraftingStudentEmail] = useState(false)
  // Same review/edit-before-send pattern as editingStudentEmail, but for a
  // no-submission student's single "Start Here" nudge instead of a 5-section report
  const [editingNudge, setEditingNudge] = useState(false)
  const [nudgeDraft, setNudgeDraft] = useState('')
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

  // Load the existing classwide report (if any) once the assignment has been
  // synced — skipped entirely when the synced list already told us no report
  // exists yet, instead of firing a call we already know will 404
  useEffect(() => {
    if (!courseworkId) return

    async function load() {
      if (record?.has_report === false) {
        setLoadingReport(false)
        return
      }
      try {
        setReport(await getReport(courseworkId))
      } catch {
        setReportError('Failed to load report.')
      } finally {
        setLoadingReport(false)
      }
    }
    load()
  }, [courseworkId, record?.has_report])

  // Load submissions when switching to the Students tab — one row per enrolled
  // student, submitted or not (see get_submissions_list/sync_coursework), so
  // this is the only fetch this tab needs; no separate live roster call.
  useEffect(() => {
    if (!courseworkId || reportMode !== 'students') return
    getSubmissions(courseworkId).then(setSubmissions).catch(() => {})
  }, [courseworkId, reportMode])

  // Flagged/solid students come straight from the classwide report's own
  // sections — no student report needs to exist yet to know who's who
  const flaggedStudents = useMemo(() => parseFlaggedStudents(report?.content), [report])
  const solidStudents = useMemo(() => parseSolidStudents(report?.content), [report])

  // _displayName is what flagged-name matching below compares against, since
  // that's literally what the AI was told to call this student. _niceName is
  // purely for what's shown to the teacher.
  const submissionsWithDisplayNames = useMemo(() => {
    // For an unnamed student, the fallback is keyed on their permanent
    // submission_id — the exact same fallback build_report's own resolution
    // step uses (see _resolve_student_references in report.py) — never a
    // sequential position. Position isn't a stable identity: it shifts
    // whenever the set of students with real content changes, which would
    // silently point a stored report's flagged name at the wrong student.
    // submission_id never shifts, so this always agrees with the report.
    return submissions.map((s) => {
      const isEmpty = s.has_submitted && !s.content
      const fallbackName = `Submission #${s.submission_id}`
      return {
        ...s,
        _displayName: s.student_name || fallbackName,
        _niceName: s.student_name || fallbackName,
        // Turned in per Google, but nothing readable came out of it (empty doc,
        // or an attachment type we can't extract) — distinct from never submitting at all
        _isEmpty: isEmpty,
      }
    })
  }, [submissions])

  // Full student list for the Students tab — every enrolled student, submitted
  // or not (see get_submissions_list), so a teacher can search/select anyone,
  // not just whoever the AI happened to flag. "Flagged" is a highlight/sort
  // cue on top of that, not a gate.
  const allStudents = useMemo(() => {
    const flaggedNameSet = new Set(flaggedStudents.map((f) => f.name.trim().toLowerCase()))
    const isFlagged = (name) => flaggedNameSet.has(name.trim().toLowerCase())
    const solidNameSet = new Set(solidStudents.map((n) => n.trim().toLowerCase()))
    const isSolid = (name) => solidNameSet.has(name.trim().toLowerCase())

    return submissionsWithDisplayNames
      .map((s) => ({
        key: `submission-${s.submission_id}`,
        name: s._niceName,
        // What flagged/solid-name matching actually compares against — kept
        // separate from the (possibly nicer) displayed name, see the comment above
        matchName: s._displayName,
        hasSubmitted: s.has_submitted,
        // A non-submitted or empty submission is always excluded from what the AI
        // sees (report.py), so it can never actually appear in either list —
        // this just makes that explicit instead of relying on that by construction
        flagged: s.has_submitted && !s._isEmpty && isFlagged(s._displayName),
        solid: s.has_submitted && !s._isEmpty && isSolid(s._displayName),
        isEmpty: s._isEmpty,
        submission: s,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [submissionsWithDisplayNames, flaggedStudents, solidStudents])

  // Categorized view for the default (non-search) Student tab — flagged
  // students surfaced first since they need the most attention, then
  // empty/no-submission (invisible to the AI report entirely, so this is the
  // only place they're ever called out), then solid understanding, with
  // everyone else in the plain list below. Mutually exclusive by construction:
  // flagged/solid both require a real, non-empty submission (see allStudents),
  // so a student can only ever land in one of the first three groups.
  const flaggedGroup = useMemo(() => allStudents.filter((s) => s.flagged), [allStudents])
  const noSubmissionGroup = useMemo(
    () => allStudents.filter((s) => !s.hasSubmitted || s.isEmpty), [allStudents]
  )
  const solidGroup = useMemo(() => allStudents.filter((s) => s.solid), [allStudents])
  const restGroup = useMemo(
    () => allStudents.filter((s) => !s.flagged && !s.solid && s.hasSubmitted && !s.isEmpty),
    [allStudents]
  )

  const filteredStudents = useMemo(() => {
    const query = studentSearch.trim().toLowerCase()
    if (!query) return allStudents
    return allStudents.filter((s) => s.name.toLowerCase().includes(query))
  }, [allStudents, studentSearch])

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
    setEditingStudentEmail(false)
    setEmailDraft(null)
    setDraftingStudentEmail(false)
    setEditingNudge(false)
    setNudgeDraft('')
    setModalActionError(null)
    setOpenReportId(submissionId)
  }

  // Shared by the automatic sync-on-open effect below and the manual Refresh
  // button. Deliberately does NOT touch the description — see
  // handleSyncDescription for that, same pattern as Sync Rubric. Doesn't pass
  // or touch context at all — sync only ever creates the row or refreshes
  // submissions; editing context always goes through Save Context below.
  async function performSync() {
    setSyncingSubmissions(true)
    setActionError(null)
    try {
      const result = await syncCoursework(assignment.google_coursework_id, assignment.course_id, assignment.course_name)
      if (!record) setLoadingReport(true) // first sync — the effect above is about to fetch the (nonexistent) report
      setRecord((prev) => ({
        ...prev,
        coursework_id: result.coursework_id,
        google_coursework_id: assignment.google_coursework_id,
        title: result.title,
        submission_count: result.total_submissions,
      }))
      // The Students tab's own submissions list only refetches when reportMode
      // changes — if a teacher is already on that tab when this runs, it would
      // otherwise sit stale (new/updated submissions invisible, "Build"
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

  // Syncs this one assignment automatically every time its Detail screen opens
  // (from either Assignments or Reports) — this is what catches a late submitter
  // without a teacher having to remember to hit Refresh. Debounced so quick
  // back-and-forth navigation doesn't spam Google's API.
  useEffect(() => {
    const gcId = assignment.google_coursework_id
    if (!gcId) return
    const last = lastSyncedAt.get(gcId)
    if (last && Date.now() - last < SYNC_DEBOUNCE_MS) return
    lastSyncedAt.set(gcId, Date.now())

    async function autoSync() {
      await performSync()
    }
    autoSync()
    // Deliberately only keyed on which assignment this is — reportMode reads
    // the latest value when this fires, it shouldn't re-trigger a sync
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.google_coursework_id])

  // The manual Refresh button always runs regardless of the debounce window,
  // for the moment a teacher knows a student just submitted right now
  async function handleRefreshSubmissions() {
    lastSyncedAt.set(assignment.google_coursework_id, Date.now())
    await performSync()
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
      const updated = await updateCourseworkContext(record.coursework_id, {
        mentalModel: mentalModelText,
        assignmentDescription: descriptionText,
        rubric: rubricText,
        includeDescription,
        includeRubric,
      })
      setRecord((prev) => ({
        ...prev,
        mental_model: updated.mental_model,
        assignment_description: updated.assignment_description,
        rubric: updated.rubric,
        include_description: updated.include_description,
        include_rubric: updated.include_rubric,
      }))
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

  // Returns {success, message} so a caller can both decide whether to
  // auto-open the report and show the real reason on failure — this used to
  // just return true/false and silently swallow the actual error, which is
  // exactly why the modal's own Refresh Report button looked like it was
  // doing nothing when a submission turned out to be empty
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
      return { success: true }
    } catch (err) {
      return { success: false, message: err.message }
    } finally {
      setBuildingStudentId(null)
    }
  }

  // Wraps handleBuildSubmissionReport specifically for the modal's own
  // Refresh Report button, so a failure (e.g. the submission is now empty)
  // shows right there in the modal instead of disappearing silently
  async function handleRefreshOpenReport(submissionId) {
    setModalActionError(null)
    const result = await handleBuildSubmissionReport(submissionId)
    if (!result.success) {
      setModalActionError(result.message || 'Failed to refresh this report. Try again.')
    }
  }

  // Same shape as handleBuildSubmissionReport, but for a student with no
  // submission — grounded only in the assignment's context, since there's
  // nothing to analyze from a submission that doesn't exist
  async function handleBuildNudge(submissionId) {
    setBuildingStudentId(submissionId)
    try {
      const result = await buildNudge(record.coursework_id, submissionId)
      setSubmissions((prev) =>
        prev.map((s) =>
          s.submission_id === submissionId
            ? { ...s, student_report: result.student_report }
            : s
        )
      )
      return { success: true }
    } catch (err) {
      return { success: false, message: err.message }
    } finally {
      setBuildingStudentId(null)
    }
  }

  async function handleRefreshNudge(submissionId) {
    setModalActionError(null)
    const result = await handleBuildNudge(submissionId)
    if (!result.success) {
      setModalActionError(result.message || 'Failed to refresh this nudge. Try again.')
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

  // "Email to student" drafts a second-person rewrite of the whole report
  // (done fresh here, not cached at Build time — see draft_student_email)
  // and opens the review/edit view with it, instead of sending right away —
  // so a teacher can tailor any section's wording before it goes out, without
  // any of this touching the stored report.
  async function handleOpenStudentEmailEdit(submissionId) {
    setChoosingEmailRecipient(false)
    setStudentEmailError(null)
    setDraftingStudentEmail(true)
    try {
      const draft = await draftStudentEmail(record.coursework_id, submissionId)
      setEmailDraft({
        submissionSummary: draft.submission_summary,
        understands: draft.understands,
        misconceptions: draft.misconceptions,
        nextStep: draft.next_step,
      })
      setEditingStudentEmail(true)
    } catch (err) {
      setStudentEmailError(err.message)
    } finally {
      setDraftingStudentEmail(false)
    }
  }

  function handleEmailDraftChange(field, value) {
    setEmailDraft((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSendToStudent(submissionId) {
    setSendingToStudent(true)
    setStudentEmailError(null)
    setStudentEmailSuccess(null)
    try {
      await sendReportToStudent(record.coursework_id, submissionId, emailDraft)
      setStudentEmailSuccess('student')
      setEditingStudentEmail(false)
    } catch (err) {
      setStudentEmailError(err.message)
    } finally {
      setSendingToStudent(false)
    }
  }

  function handleOpenNudgeEdit(studentReport) {
    setChoosingEmailRecipient(false)
    setStudentEmailError(null)
    setNudgeDraft((studentReport || '').replace(/^[-*]\s+/, '').trim())
    setEditingNudge(true)
  }

  async function handleSendNudge(submissionId) {
    setSendingToStudent(true)
    setStudentEmailError(null)
    setStudentEmailSuccess(null)
    try {
      await sendNudge(record.coursework_id, submissionId, nudgeDraft)
      setStudentEmailSuccess('student')
      setEditingNudge(false)
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
  // student — so browsing the list never silently spends anything. A student
  // with no submission gets a "how to get started" nudge instead of a
  // diagnostic report, since there's nothing to analyze.
  async function handleBuildStudentReport(student) {
    setStudentActionError(null)
    const isNudgeType = !student.hasSubmitted || student.isEmpty
    const result = isNudgeType
      ? await handleBuildNudge(student.submission.submission_id)
      : await handleBuildSubmissionReport(student.submission.submission_id)
    if (result.success) {
      setStudentReportModal(student.submission.submission_id)
    } else {
      setStudentActionError({
        key: student.key,
        message: result.message || `Failed to build ${isNudgeType ? 'a nudge' : 'a report'} for ${student.name}. Try again.`,
      })
    }
  }

  // A report with nothing to compare submissions against is nearly always
  // shallow and generic — Build/Refresh are disabled until there's at least
  // a mental model, description, or rubric to work with
  const hasContext = Boolean(
    mentalModelText.trim()
    || (includeDescription && descriptionText.trim())
    || (includeRubric && rubricText.trim())
  )
  const hasMentalModel = mentalModelText.trim().length > 0

  // Shared row markup for both the categorized default view and the flat
  // search-mode list below, so the two never drift out of sync with each
  // other. showBadges is false in the grouped/category views — a student's
  // box (Flagged/Empty/Solid) already says what they are, so the badge would
  // just repeat it; only the flat search list (which mixes categories
  // together) actually needs the badge to convey that.
  function renderStudentRow(student, showBadges = false) {
    return student.submission.student_report ? (
      <button
        key={student.key}
        type="button"
        className="student-row student-row--clickable"
        onClick={() => handleViewStudentReport(student)}
      >
        <div className="student-card-info">
          <span className="student-card-name">{student.name}</span>
          {showBadges && student.flagged && <span className="student-flagged-badge">Flagged</span>}
          {showBadges && student.solid && <span className="student-solid-badge">Solid</span>}
          {showBadges && student.isEmpty && <span className="student-empty-badge">Empty submission</span>}
          {showBadges && !student.hasSubmitted && <span className="student-empty-badge">Unsubmitted</span>}
        </div>
        <Icon name="chevron_right" className="student-card-chevron" />
      </button>
    ) : (
      <div key={student.key} className="student-row student-row--column">
        <div className="student-row-main">
          <div className="student-card-info">
            <span className="student-card-name">{student.name}</span>
            {showBadges && student.flagged && <span className="student-flagged-badge">Flagged</span>}
            {showBadges && student.solid && <span className="student-solid-badge">Solid</span>}
            {showBadges && student.isEmpty && <span className="student-empty-badge">Empty submission</span>}
            {showBadges && !student.hasSubmitted && <span className="student-empty-badge">Unsubmitted</span>}
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
  }

  // One outlined box per category, skipped entirely when empty — never an
  // empty box with nothing in it. Only shown in the default (non-search) view;
  // searching collapses back to a flat list so a match isn't hidden in a
  // category the teacher isn't currently looking at.
  function renderStudentGroup(students, label, colorClass) {
    if (students.length === 0) return null
    return (
      <div className={`student-group ${colorClass}`}>
        <h3 className="student-group-title">{label} ({students.length})</h3>
        <div className="student-card-grid">
          {students.map((s) => renderStudentRow(s, false))}
        </div>
      </div>
    )
  }

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
                : syncingSubmissions ? 'Loading ..' : 'Not synced yet'}
            </p>
            <button
              type="button"
              className="sync-icon-btn"
              onClick={handleRefreshSubmissions}
              disabled={syncingSubmissions}
              aria-label={syncingSubmissions ? 'refreshing ..' : 'refresh'}
              data-tooltip={syncingSubmissions ? 'refreshing ..' : 'refresh'}
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
                  {hasContext && !hasMentalModel && (
                    <p className="detail-section-hint detail-section-hint--warning">
                      No Mental Model set. AI leans on Description/Rubric instead, this may be less precise.
                    </p>
                  )}
                </div>
                {/* Kept right under the Mental Model box (but outside it) instead of at
                    the bottom of the whole section, so it's not easy to miss after editing */}
                {record && (
                  <div className="context-actions">
                    <button className="primary-btn" onClick={handleSaveContext} disabled={saving}>
                      {saving ? 'Saving ..' : 'Save Context'}
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
                    {syncingDescription ? 'Syncing ..' : 'Sync Description'}
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
                    {syncingRubric ? 'Syncing ..' : 'Sync Rubric'}
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
                {/* Shown right up top, before any existing report content — a Refresh
                    failure used to render below the entire report body, which for a
                    real class-wide report (several sections long) meant scrolling
                    past everything just to find one line of red text */}
                {reportError && !building && <p className="report-error">{reportError}</p>}

                {loadingReport && <p className="report-status">Loading ..</p>}

                {!loadingReport && !report && !reportError && (
                  <div className="report-empty">
                    <p className={hasContext ? 'report-empty-text' : 'report-empty-text report-empty-text--warning'}>
                      {hasContext
                        ? 'No report built yet.'
                        : 'No report built yet. Add context first.'}
                    </p>
                    <button className="build-btn" onClick={handleBuild} disabled={building || !hasContext}>
                      {building ? 'Building ..' : 'Build'}
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
                          {building ? 'Refreshing ..' : 'Refresh Report'}
                        </button>
                        <button className="secondary-btn" onClick={handleEmailReport} disabled={emailing}>
                          {emailing ? 'Sending ..' : 'Email Report'}
                        </button>
                      </div>
                    </div>
                    {emailSuccess && <p className="save-success">Sent to your email</p>}
                    {emailError && <p className="report-error">{emailError}</p>}
                    <ReportBody content={report.content} mode="classwide" totalStudents={record?.total_students} />
                  </div>
                )}
              </>
            )}

            {/* ── STUDENTS ── */}
            {reportMode === 'students' && (
              <div className="student-list">
                <div className="coursework-controls">
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search students…"
                    value={studentSearch}
                    onChange={(e) => setStudentSearch(e.target.value)}
                    aria-label="Search students"
                  />
                </div>

                {allStudents.length === 0 && (
                  <p className="report-status">No students found for this assignment yet.</p>
                )}

                {allStudents.length > 0 && filteredStudents.length === 0 && (
                  <p className="report-status">No students match your search.</p>
                )}

                {studentSearch.trim() ? (
                  // Searching collapses to a flat list — a match shouldn't be
                  // hidden inside a category box the teacher isn't looking at.
                  // Badges show here since categories are mixed together with
                  // nothing else distinguishing them.
                  filteredStudents.length > 0 && (
                    <div className="student-card-grid">
                      {filteredStudents.map((s) => renderStudentRow(s, true))}
                    </div>
                  )
                ) : (
                  <>
                    {renderStudentGroup(flaggedGroup, 'Flagged', 'student-group--red')}
                    {renderStudentGroup(noSubmissionGroup, 'Empty / No submission', 'student-group--yellow')}
                    {renderStudentGroup(solidGroup, 'Solid grasp', 'student-group--green')}
                    {restGroup.length > 0 && (
                      <div className="student-card-grid">
                        {restGroup.map((s) => renderStudentRow(s, false))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {/* Student report popup — opened by clicking a student's name above */}
        {openReportId && (() => {
          const sub = submissions.find((s) => s.submission_id === openReportId)
          if (!sub || !sub.student_report) return null
          const displayName = sub.student_name || `Submission #${sub.submission_id}`
          // Whether this student has a "how to get started" nudge instead of a
          // real diagnostic report — same test as the row list above
          const isNudgeType = !sub.has_submitted || !sub.content
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
                      onClick={() => (isNudgeType ? handleRefreshNudge(sub.submission_id) : handleRefreshOpenReport(sub.submission_id))}
                      disabled={buildingStudentId === sub.submission_id}
                    >
                      {buildingStudentId === sub.submission_id
                        ? 'Refreshing ..'
                        : (isNudgeType ? 'Refresh Nudge' : 'Refresh Report')}
                    </button>
                    {isNudgeType ? (
                      // No submission to email a copy of to yourself — this
                      // nudge only ever makes sense going to the student, so
                      // there's nothing to choose and no dropdown needed
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => handleOpenNudgeEdit(sub.student_report)}
                        disabled={sendingToStudent}
                      >
                        {sendingToStudent ? 'Sending ..' : 'Email to Student'}
                      </button>
                    ) : (
                      <div className="email-dropdown-wrapper" ref={emailDropdownRef}>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => setChoosingEmailRecipient((v) => !v)}
                          disabled={emailingStudent || sendingToStudent || draftingStudentEmail}
                        >
                          {draftingStudentEmail
                            ? 'Drafting ..'
                            : emailingStudent || sendingToStudent
                              ? 'Sending ..'
                              : 'Email Report'}
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
                              onClick={() => handleOpenStudentEmailEdit(sub.submission_id)}
                            >
                              Email to student
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {(editingStudentEmail || editingNudge) && (
                  <p className="next-step-edit-pointer">
                    <Icon name="arrow_downward" />
                    Edit the message below before sending.
                  </p>
                )}
                {studentEmailSuccess === 'me' && <p className="save-success">Sent to your email</p>}
                {studentEmailSuccess === 'student' && <p className="save-success">Sent to the student</p>}
                {studentEmailError && <p className="report-error">{studentEmailError}</p>}
                {modalActionError && <p className="report-error">{modalActionError}</p>}

                <div className="student-report-body">
                  {isNudgeType ? (
                    <NudgeSummary
                      content={sub.student_report}
                      studentName={displayName}
                      editingNudge={editingNudge}
                      nudgeDraft={nudgeDraft}
                      onNudgeDraftChange={setNudgeDraft}
                      onSendNudge={() => handleSendNudge(sub.submission_id)}
                      onCancelEdit={() => setEditingNudge(false)}
                      sendingNudge={sendingToStudent}
                    />
                  ) : (
                    <StudentReportSummary
                      content={sub.student_report}
                      submissionContent={sub.content}
                      studentName={displayName}
                      editingStudentEmail={editingStudentEmail}
                      emailDraft={emailDraft}
                      onEmailDraftChange={handleEmailDraftChange}
                      onSendToStudent={() => handleSendToStudent(sub.submission_id)}
                      onCancelEdit={() => setEditingStudentEmail(false)}
                      sendingToStudent={sendingToStudent}
                    />
                  )}
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

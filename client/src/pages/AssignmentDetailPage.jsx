import { useEffect, useMemo, useState } from 'react'
import { getReport, generateReport, emailReport, importCoursework, updateCourseworkContext, getGCRubric, getGCDescription, getSubmissions, generateIndividualReport } from '../lib/api'
import Icon from '../components/Icon'
import ReportBody, { IndividualReportSummary } from '../components/ReportBody'
import { parseFlaggedStudents } from '../lib/reportParsing'
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

// Third screen — shown when a teacher clicks into a specific assignment.
// Lets the teacher review/edit the mental model and supporting materials,
// sync submissions, and generate/view the AI confusion report.
function AssignmentDetailPage({ assignment, importedRecord, onBack, onDataChange }) {
  // Local copy of the imported record so this screen can react immediately to
  // sync/context-save actions without waiting on a parent re-fetch
  const [record, setRecord] = useState(importedRecord)
  // 'context' | 'report' — only relevant once record exists (before that,
  // there's nothing to report on yet, so Context is the only thing shown)
  const [activeTab, setActiveTab] = useState('context')
  // The teacher's own words — restored from the saved context, never touched by syncing
  const [mentalModelText, setMentalModelText] = useState(
    () => extractContextSection(importedRecord?.context, 'Mental Model')
  )
  // Restored from the saved context like Mental Model/Rubric, so a teacher's edits
  // survive a revisit — falls back to the live Classroom description only the first
  // time, before anything has ever been saved.
  const [descriptionText, setDescriptionText] = useState(
    () => extractContextSection(importedRecord?.context, 'Assignment Description') || assignment.description || ''
  )
  const [rubricText, setRubricText] = useState(
    () => extractContextSection(importedRecord?.context, 'Rubric')
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
  const [loadingReport, setLoadingReport] = useState(!!importedRecord)
  const [generating, setGenerating] = useState(false)
  const [reportError, setReportError] = useState(null)
  const [emailing, setEmailing] = useState(false)
  const [emailError, setEmailError] = useState(null)
  const [emailSuccess, setEmailSuccess] = useState(false)

  // 'classwide' | 'flagged' — Flagged only ever shows students the classwide
  // report already flagged, never the full roster
  const [reportMode, setReportMode] = useState('classwide')
  const [submissions, setSubmissions] = useState([])
  const [generatingIndividual, setGeneratingIndividual] = useState(null) // submission_id currently generating
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generateProgress, setGenerateProgress] = useState({ done: 0, total: 0 })
  // submission_id of the student whose report is open in the popup, or null
  const [openReportId, setOpenReportId] = useState(null)

  const courseworkId = record?.coursework_id

  // Load the existing classwide report (if any) once the assignment has been imported
  useEffect(() => {
    if (!courseworkId) return
    getReport(courseworkId)
      .then((data) => setReport(data))
      .catch(() => setReportError('Failed to load report.'))
      .finally(() => setLoadingReport(false))
  }, [courseworkId])

  // Load submissions (with any individual reports) when switching to the Flagged tab
  useEffect(() => {
    if (!courseworkId || reportMode !== 'flagged') return
    getSubmissions(courseworkId).then(setSubmissions).catch(() => {})
  }, [courseworkId, reportMode])

  // Flagged students come straight from the classwide report's own "Flagged
  // Students" section — no individual report needs to exist yet to know who's flagged
  const flaggedStudents = useMemo(() => parseFlaggedStudents(report?.content), [report])

  const flaggedSubmissions = useMemo(() => {
    if (flaggedStudents.length === 0) return []
    // Matches on the same positional "Student N" fallback the backend used when
    // building the classwide prompt (raw fetch order), not the alphabetically
    // sorted display order, so unnamed students still line up correctly
    const withDisplayNames = submissions.map((s, i) => ({
      ...s,
      _displayName: s.student_name || `Student ${i + 1}`,
    }))

    return flaggedStudents
      .map(({ name }) => {
        return withDisplayNames.find(
          (s) => s._displayName.trim().toLowerCase() === name.trim().toLowerCase()
        ) || null
      })
      .filter(Boolean)
      .sort((a, b) => a._displayName.localeCompare(b._displayName))
  }, [submissions, flaggedStudents])

  // Closes the individual report popup on Escape
  useEffect(() => {
    if (!openReportId) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpenReportId(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openReportId])

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
  // submission count. It's still able to create the record too (importCoursework
  // is idempotent either way), which only matters if this page is somehow reached
  // before that automatic sync has run yet. Deliberately does NOT touch the
  // description — see handleSyncDescription for that, same pattern as Sync Rubric.
  async function handleRefreshSubmissions() {
    setSyncingSubmissions(true)
    setActionError(null)
    try {
      const result = await importCoursework(
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

  async function handleGenerate() {
    setGenerating(true)
    setReportError(null)
    try {
      const data = await generateReport(record.coursework_id)
      setReport(data)
      setActiveTab('report')
    } catch (err) {
      setReportError(err.message)
    } finally {
      setGenerating(false)
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
  // to auto-open the report right after generating it
  async function handleGenerateIndividual(submissionId) {
    setGeneratingIndividual(submissionId)
    try {
      const result = await generateIndividualReport(record.coursework_id, submissionId)
      setSubmissions((prev) =>
        prev.map((s) =>
          s.submission_id === submissionId
            ? { ...s, individual_report: result.individual_report }
            : s
        )
      )
      return true
    } catch {
      return false
    } finally {
      setGeneratingIndividual(null)
    }
  }

  // Clicking a flagged student's card either opens their existing report, or
  // generates one on the spot and opens it as soon as it's ready
  async function handleFlaggedCardClick(sub) {
    if (sub.individual_report) {
      setOpenReportId(sub.submission_id)
      return
    }
    const success = await handleGenerateIndividual(sub.submission_id)
    if (success) setOpenReportId(sub.submission_id)
  }

  // Generates individual reports for every flagged student that doesn't have
  // one yet, one at a time so Groq isn't hammered with parallel requests.
  // Updates each card live as its report finishes.
  async function handleGenerateAll() {
    const toGenerate = flaggedSubmissions.filter((s) => !s.individual_report)
    if (toGenerate.length === 0) return
    setGeneratingAll(true)
    setGenerateProgress({ done: 0, total: toGenerate.length })
    for (const sub of toGenerate) {
      await handleGenerateIndividual(sub.submission_id)
      setGenerateProgress((prev) => ({ ...prev, done: prev.done + 1 }))
    }
    setGeneratingAll(false)
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

        {/* Once imported, Context and AI Report are separate tabs — before
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
                className={`report-mode-btn${reportMode === 'flagged' ? ' report-mode-btn--active' : ''}`}
                onClick={() => setReportMode('flagged')}
              >
                Flagged
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
                    <button className="generate-btn" onClick={handleGenerate} disabled={generating || !hasContext}>
                      {generating ? 'Building…' : 'Build'}
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
                          onClick={handleGenerate}
                          disabled={generating}
                        >
                          {generating ? 'Refreshing…' : 'Refresh Report'}
                        </button>
                        <button className="secondary-btn" onClick={handleEmailReport} disabled={emailing}>
                          {emailing ? 'Sending…' : 'Email Report'}
                        </button>
                      </div>
                    </div>
                    {emailSuccess && <p className="save-success">Sent to your email</p>}
                    {emailError && <p className="report-error">{emailError}</p>}
                    <ReportBody content={report.content} mode="classwide" totalSubmissions={submissions.length} />
                  </div>
                )}

                {reportError && !generating && <p className="report-error">{reportError}</p>}
              </>
            )}

            {/* ── FLAGGED ── */}
            {reportMode === 'flagged' && (
              <div className="individual-list">
                {!report && (
                  <p className="report-status">Build the classwide report first to see flagged students.</p>
                )}

                {/* Distinguished from "no students flagged" — this means the report DID
                    flag students, but none of those names matched a synced submission
                    (e.g. a roster mismatch), which is a data problem, not a clean report. */}
                {report && flaggedStudents.length > 0 && flaggedSubmissions.length === 0 && (
                  <p className="report-status">
                    The report flagged {flaggedStudents.length} student{flaggedStudents.length !== 1 ? 's' : ''},
                    but none could be matched to a synced submission. Try refreshing the report.
                  </p>
                )}

                {report && flaggedStudents.length === 0 && (
                  <p className="report-status">No students flagged in the latest report.</p>
                )}

                {report && flaggedSubmissions.length > 0 && (
                  <>
                    {flaggedSubmissions.length < flaggedStudents.length && (
                      <p className="report-error">
                        {flaggedStudents.length - flaggedSubmissions.length} flagged student
                        {flaggedStudents.length - flaggedSubmissions.length !== 1 ? 's' : ''} couldn't be matched
                        to a synced submission and aren't shown below.
                      </p>
                    )}

                    {/* Generate All bar — only shown while there's something left to
                        generate; once everything's done it just disappears instead of
                        sitting there as a disabled, redundant "All Reports Generated" */}
                    {(generatingAll || flaggedSubmissions.some((s) => !s.individual_report)) && (
                      <div className="individual-bar">
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={handleGenerateAll}
                          disabled={generatingAll}
                        >
                          {generatingAll
                            ? `Generating… ${generateProgress.done} / ${generateProgress.total}`
                            : `Generate All (${flaggedSubmissions.filter((s) => !s.individual_report).length} remaining)`}
                        </button>
                      </div>
                    )}

                    <div className="individual-card-grid">
                      {flaggedSubmissions.map((sub) => (
                        <button
                          key={sub.submission_id}
                          type="button"
                          className="individual-row individual-row--flagged individual-row--clickable"
                          onClick={() => handleFlaggedCardClick(sub)}
                          disabled={generatingIndividual === sub.submission_id || generatingAll}
                        >
                          <div className="individual-card-info">
                            <span className="individual-card-name">{sub._displayName}</span>
                          </div>
                          {generatingIndividual === sub.submission_id ? (
                            <span className="individual-card-generating">…</span>
                          ) : (
                            <Icon name="chevron_right" className="individual-card-chevron" />
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {/* Individual report popup — opened by clicking a student's name above */}
        {openReportId && (() => {
          const sub = submissions.find((s) => s.submission_id === openReportId)
          if (!sub || !sub.individual_report) return null
          const idx = submissions.indexOf(sub)
          const displayName = sub.student_name || `Student ${idx + 1}`
          return (
            <div className="modal-backdrop" onClick={() => setOpenReportId(null)}>
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
                  onClick={() => setOpenReportId(null)}
                >
                  <Icon name="close" />
                </button>
                <h2 className="modal-title">{displayName}</h2>
                <div className="individual-report-body">
                  <IndividualReportSummary content={sub.individual_report} />
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

import { useEffect, useState } from 'react'
import { getReport, generateReport, emailReport, importCoursework, updateCourseworkContext, getGCRubric, getSubmissions, generateIndividualReport } from '../lib/api'
import Icon from '../components/Icon'
import ReportBody from '../components/ReportBody'
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
  // Description always mirrors the live Classroom description — it's free to fetch,
  // so there's no need to sync before it's editable.
  const [descriptionText, setDescriptionText] = useState(assignment.description || '')
  const [rubricText, setRubricText] = useState(
    () => extractContextSection(importedRecord?.context, 'Rubric')
  )
  // Each reference material can be left out of what's actually sent to the AI
  // while still staying visible/editable — e.g. excluding the rubric if a
  // teacher doesn't want its grading-criteria framing to influence the report.
  const [includeDescription, setIncludeDescription] = useState(true)
  const [includeRubric, setIncludeRubric] = useState(true)
  const [syncingSubmissions, setSyncingSubmissions] = useState(false)
  const [syncingRubric, setSyncingRubric] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [rubricError, setRubricError] = useState(null)
  const [actionError, setActionError] = useState(null)

  const [report, setReport] = useState(null)
  const [loadingReport, setLoadingReport] = useState(!!importedRecord)
  const [generating, setGenerating] = useState(false)
  const [reportError, setReportError] = useState(null)
  const [emailing, setEmailing] = useState(false)
  const [emailError, setEmailError] = useState(null)
  const [emailSuccess, setEmailSuccess] = useState(false)

  // Individual report state — 'classwide' | 'individual'
  const [reportMode, setReportMode] = useState('classwide')
  const [submissions, setSubmissions] = useState([])
  const [generatingIndividual, setGeneratingIndividual] = useState(null) // submission_id currently generating
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generateProgress, setGenerateProgress] = useState({ done: 0, total: 0 })

  const courseworkId = record?.coursework_id

  // Load the existing classwide report (if any) once the assignment has been imported
  useEffect(() => {
    if (!courseworkId) return
    getReport(courseworkId)
      .then((data) => setReport(data))
      .catch(() => setReportError('Failed to load report.'))
      .finally(() => setLoadingReport(false))
  }, [courseworkId])

  // Load submissions (with any individual reports) when switching to Individual mode
  useEffect(() => {
    if (!courseworkId || reportMode !== 'individual') return
    getSubmissions(courseworkId).then(setSubmissions).catch(() => {})
  }, [courseworkId, reportMode])

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

  // Creates the coursework record on first click (unlocking Save Context and
  // the AI Report tab) and re-syncs the submission count on later clicks.
  // Lives outside the Context tab since it isn't a Context-specific action —
  // it's the gate the rest of this page depends on.
  async function handleSyncSubmissions() {
    setSyncingSubmissions(true)
    setActionError(null)
    try {
      const result = await importCoursework(assignment.google_coursework_id, assignment.course_id, combinedContext(), assignment.course_name)
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
    } catch (err) {
      // Error shown inline per submission
    } finally {
      setGeneratingIndividual(null)
    }
  }

  // Generates individual reports for every student that doesn't have one yet,
  // one at a time so Groq isn't hammered with 20 parallel requests.
  // Updates each card live as its report finishes.
  async function handleGenerateAll() {
    const toGenerate = submissions.filter((s) => !s.individual_report)
    if (toGenerate.length === 0) return
    setGeneratingAll(true)
    setGenerateProgress({ done: 0, total: toGenerate.length })
    for (const sub of toGenerate) {
      try {
        const result = await generateIndividualReport(record.coursework_id, sub.submission_id)
        setSubmissions((prev) =>
          prev.map((s) =>
            s.submission_id === sub.submission_id
              ? { ...s, individual_report: result.individual_report }
              : s
          )
        )
      } catch { /* skip this student and continue */ }
      setGenerateProgress((prev) => ({ ...prev, done: prev.done + 1 }))
    }
    setGeneratingAll(false)
  }

  return (
    <div className="screen">
      <main className="screen-main detail-main">
        <div>
          <button className="back-btn" onClick={onBack}>← Coursework</button>
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
              onClick={handleSyncSubmissions}
              disabled={syncingSubmissions}
              aria-label={syncingSubmissions ? 'Syncing submissions…' : 'Sync submissions'}
              data-tooltip={syncingSubmissions ? 'Syncing…' : 'Sync submissions'}
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

            {record && (
              <div className="context-actions">
                <button className="primary-btn" onClick={handleSaveContext} disabled={saving}>
                  {saving ? 'Saving…' : 'Save Context'}
                </button>
                {saveSuccess && <p className="save-success">Saved</p>}
                {saveError && <p className="report-error">{saveError}</p>}
              </div>
            )}
          </section>
        )}

        {/* AI report — its own tab, only reachable once the assignment has been synced */}
        {record && activeTab === 'report' && (
          <section className="detail-section">
            {/* Classwide vs Individual mode toggle */}
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
                className={`report-mode-btn${reportMode === 'individual' ? ' report-mode-btn--active' : ''}`}
                onClick={() => setReportMode('individual')}
              >
                Individual
              </button>
            </div>

            {/* ── CLASSWIDE ── */}
            {reportMode === 'classwide' && (
              <>
                {loadingReport && <p className="report-status">Loading…</p>}

                {!loadingReport && !report && !reportError && (
                  <div className="report-empty">
                    <p className="report-empty-text">No report built yet.</p>
                    <button className="generate-btn" onClick={handleGenerate} disabled={generating}>
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
                        <button className="secondary-btn" onClick={handleGenerate} disabled={generating}>
                          {generating ? 'Refreshing…' : 'Refresh Report'}
                        </button>
                        <button className="secondary-btn" onClick={handleEmailReport} disabled={emailing}>
                          {emailing ? 'Sending…' : 'Email Report'}
                        </button>
                      </div>
                    </div>
                    {emailSuccess && <p className="save-success">Sent to your email</p>}
                    {emailError && <p className="report-error">{emailError}</p>}
                    <ReportBody content={report.content} />
                  </div>
                )}

                {reportError && !generating && <p className="report-error">{reportError}</p>}
              </>
            )}

            {/* ── INDIVIDUAL ── */}
            {reportMode === 'individual' && (
              <div className="individual-list">
                {submissions.length === 0 && (
                  <p className="report-status">No submissions synced yet.</p>
                )}

                {submissions.length > 0 && (() => {
                  // Count students whose report shows anything less than full understanding
                  const flaggedCount = submissions.filter((s) => {
                    const lvl = getFlagLevel(s.individual_report)
                    return lvl && lvl !== 'on-track'
                  }).length
                  const allGenerated = submissions.every((s) => s.individual_report)

                  return (
                    <>
                      {/* Generate All bar — shows live progress while running */}
                      <div className="individual-bar">
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={handleGenerateAll}
                          disabled={generatingAll || allGenerated}
                        >
                          {generatingAll
                            ? `Generating… ${generateProgress.done} / ${generateProgress.total}`
                            : allGenerated
                            ? 'All Reports Generated'
                            : `Generate All (${submissions.filter((s) => !s.individual_report).length} remaining)`}
                        </button>
                        {flaggedCount > 0 && (
                          <span className="flag-summary-badge">
                            {flaggedCount} student{flaggedCount !== 1 ? 's' : ''} flagged
                          </span>
                        )}
                      </div>

                      {submissions.map((sub, i) => {
                        const flagLevel = getFlagLevel(sub.individual_report)
                        return (
                          <div
                            key={sub.submission_id}
                            className={`individual-card${flagLevel && flagLevel !== 'on-track' ? ' individual-card--flagged' : ''}`}
                          >
                            <div className="individual-card-header">
                              <span className="individual-label">{sub.student_name || `Student ${i + 1}`}</span>
                              {flagLevel && (
                                <span className={`flag-badge flag-badge--${flagLevel}`}>
                                  {flagLevel === 'misconception' && 'Misconception'}
                                  {flagLevel === 'partial' && 'Partial understanding'}
                                  {flagLevel === 'no-engagement' && 'No response'}
                                  {flagLevel === 'on-track' && 'On track'}
                                </span>
                              )}
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => handleGenerateIndividual(sub.submission_id)}
                                disabled={generatingIndividual === sub.submission_id || generatingAll}
                              >
                                {generatingIndividual === sub.submission_id
                                  ? 'Generating…'
                                  : sub.individual_report
                                  ? 'Regenerate'
                                  : 'Generate'}
                              </button>
                            </div>
                            <p className="individual-preview">
                              {sub.content.length > 120
                                ? sub.content.slice(0, 120) + '…'
                                : sub.content}
                            </p>
                            {sub.individual_report && (
                              <div className="individual-report-body">
                                <ReportBody content={sub.individual_report} />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </>
                  )
                })()}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  )
}


// Returns the severity level for a student's individual report.
// Supports both the old prompt format (explicit labels) and the new format
// (section-based signals) so existing reports don't break after the prompt update.
function getFlagLevel(individualReport) {
  if (!individualReport) return null

  // Old prompt format
  if (individualReport.includes('No engagement')) return 'no-engagement'
  if (individualReport.includes('Misconception present')) return 'misconception'
  if (individualReport.includes('Partial understanding')) return 'partial'
  if (individualReport.includes('Demonstrates understanding')) return 'on-track'

  // New prompt format — submission quality issues
  if (
    individualReport.includes('Submission was blank') ||
    individualReport.includes('Submission too short') ||
    individualReport.includes('Submission did not address')
  ) return 'no-engagement'

  // New prompt format — misconceptions section
  if (individualReport.includes('No misconceptions detected')) return 'on-track'
  if (individualReport.includes('Misconceptions Detected')) return 'misconception'

  return 'on-track'
}


export default AssignmentDetailPage

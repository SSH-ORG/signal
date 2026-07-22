import { useEffect, useState } from 'react'
import { getReport, generateReport, emailReport, importCoursework, updateCourseworkContext, getGCRubric } from '../lib/api'
import Icon from '../components/Icon'
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

  const courseworkId = record?.coursework_id

  // Load the existing report (if any) once the assignment has been imported
  useEffect(() => {
    if (!courseworkId) return
    getReport(courseworkId)
      .then((data) => setReport(data))
      .catch(() => setReportError('Failed to load report.'))
      .finally(() => setLoadingReport(false))
  }, [courseworkId])

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
                    placeholder="No description found in Google Classroom, you can add one here."
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
                    placeholder="No rubric yet. Sync Rubric from Google Classroom, or type one here."
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
            {loadingReport && <p className="report-status">Loading…</p>}

            {!loadingReport && !report && !reportError && (
              <div className="report-empty">
                <p className="report-empty-text">
                  No report built yet. Click below to build one.
                </p>
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
          </section>
        )}
      </main>
    </div>
  )
}


// Renders the AI markdown report into clean readable sections
// Splits on ## headings and renders bold text within each section
function ReportBody({ content }) {
  const sections = content.split(/(?=##\s)/g).filter(Boolean)

  return (
    <div className="report-body">
      {sections.map((section, i) => {
        const lines = section.split('\n').filter(Boolean)
        const heading = lines[0].replace(/^#+\s*/, '')
        const body = lines.slice(1).join('\n')

        return (
          <div key={i} className="report-section">
            <h3 className="section-heading">{heading}</h3>
            <div className="section-body">
              {body.split('\n').filter(Boolean).map((line, j) => (
                <p key={j} dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}


// Converts **bold** markdown syntax to HTML <strong> tags
// Only used on trusted AI output — not user input
function formatLine(line) {
  return line
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\*+\s/, '')
    .replace(/^-+\s/, '')
}


export default AssignmentDetailPage

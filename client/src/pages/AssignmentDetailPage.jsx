import { useEffect, useState } from 'react'
import Logo from '../components/Logo'
import { getReport, generateReport, importCoursework, updateCourseworkContext } from '../lib/api'
import './Screens.css'
import './AssignmentDetailPage.css'

// Third screen — shown when a teacher clicks into a specific assignment.
// Lets the teacher review/edit the context (pre-filled from the Classroom description),
// import or sync submissions, and generate/view the AI confusion report.
function AssignmentDetailPage({ assignment, importedRecord, onBack, onDataChange }) {
  // Local copy of the imported record so this screen can react immediately to
  // import/sync/context-save actions without waiting on a parent re-fetch
  const [record, setRecord] = useState(importedRecord)
  const [contextText, setContextText] = useState(importedRecord?.context ?? assignment.description ?? '')
  const [importing, setImporting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)

  const [report, setReport] = useState(null)
  const [loadingReport, setLoadingReport] = useState(!!importedRecord)
  const [generating, setGenerating] = useState(false)
  const [reportError, setReportError] = useState(null)

  const courseworkId = record?.coursework_id

  // Load the existing report (if any) once the assignment has been imported
  useEffect(() => {
    if (!courseworkId) return
    getReport(courseworkId)
      .then((data) => setReport(data))
      .catch(() => setReportError('Failed to load report.'))
      .finally(() => setLoadingReport(false))
  }, [courseworkId])

  async function handleImportOrSync() {
    setImporting(true)
    setActionError(null)
    try {
      const result = await importCoursework(assignment.google_coursework_id, assignment.course_id, contextText)
      if (!record) setLoadingReport(true) // first import — the effect above is about to fetch the (nonexistent) report
      setRecord((prev) => ({
        coursework_id: result.coursework_id,
        google_coursework_id: assignment.google_coursework_id,
        title: result.title,
        context: prev ? prev.context : contextText,
        submission_count: result.total_submissions,
      }))
      onDataChange()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setImporting(false)
    }
  }

  async function handleSaveContext() {
    if (!record) return
    setSaving(true)
    setActionError(null)
    try {
      const updated = await updateCourseworkContext(record.coursework_id, contextText)
      setRecord((prev) => ({ ...prev, context: updated.context }))
      onDataChange()
    } catch (err) {
      setActionError(err.message)
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
    } catch (err) {
      setReportError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <Logo size="medium" />
      </header>

      <main className="screen-main">
        <div>
          <button className="back-btn" onClick={onBack}>← {assignment.course_name}</button>
        </div>

        <div>
          <h1 className="screen-title">{assignment.title}</h1>
          <p className="screen-subtitle">
            {record
              ? `${record.submission_count} ${record.submission_count === 1 ? 'submission' : 'submissions'}`
              : 'Not imported yet'}
          </p>
        </div>

        {/* Context / rubric / learning goals — pre-filled from the Classroom description */}
        <section className="detail-section">
          <h2 className="detail-section-title">Context</h2>
          <p className="detail-section-hint">
            Pre-filled from the assignment description in Google Classroom. Add or edit a rubric,
            learning goal, or answer key here — this is what the AI uses to generate the report.
          </p>
          <textarea
            className="context-textarea"
            value={contextText}
            onChange={(e) => setContextText(e.target.value)}
            placeholder="No description found. Add context for the AI here (optional)."
            rows={6}
          />

          <div className="detail-actions">
            {!record && (
              <button className="primary-btn" onClick={handleImportOrSync} disabled={importing}>
                {importing ? 'Importing…' : 'Import Assignment'}
              </button>
            )}
            {record && (
              <>
                <button className="primary-btn" onClick={handleSaveContext} disabled={saving}>
                  {saving ? 'Saving…' : 'Save Context'}
                </button>
                <button className="secondary-btn" onClick={handleImportOrSync} disabled={importing}>
                  {importing ? 'Syncing…' : 'Sync Submissions'}
                </button>
              </>
            )}
          </div>

          {actionError && <p className="report-error">{actionError}</p>}
        </section>

        {/* AI report — only once the assignment has been imported */}
        {record && (
          <section className="detail-section">
            <h2 className="detail-section-title">AI Report</h2>

            {loadingReport && <p className="report-status">Loading…</p>}

            {!loadingReport && !report && !reportError && (
              <div className="report-empty">
                <p className="report-empty-text">
                  No report generated yet. Click below to analyze all submissions with AI.
                </p>
                <button className="generate-btn" onClick={handleGenerate} disabled={generating}>
                  {generating ? 'Generating report…' : 'Generate AI Report'}
                </button>
              </div>
            )}

            {!loadingReport && report && (
              <div className="report-content">
                <div className="report-timestamp">
                  Generated on {new Date(report.created_at).toLocaleDateString('en-US', {
                    month: 'long', day: 'numeric', year: 'numeric',
                  })}
                </div>
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

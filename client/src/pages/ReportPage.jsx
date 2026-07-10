import { useEffect, useState } from 'react'
import Logo from '../components/Logo'
import { getReport, generateReport } from '../lib/api'
import './ReportPage.css'

// ReportPage — shown when a teacher clicks into an imported assignment
// Displays the AI-generated confusion report, or lets the teacher generate one
function ReportPage({ coursework, onBack }) {
  const [report, setReport] = useState(null)       // The report object from the backend
  const [loading, setLoading] = useState(true)      // Loading existing report on mount
  const [generating, setGenerating] = useState(false) // Waiting for Gemini to respond
  const [error, setError] = useState(null)

  // Check if a report already exists for this assignment when the page loads
  useEffect(() => {
    getReport(coursework.coursework_id)
      .then((data) => setReport(data))
      .catch(() => setError('Failed to load report.'))
      .finally(() => setLoading(false))
  }, [coursework.coursework_id])

  // Send submissions to Gemini and store the result
  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const data = await generateReport(coursework.coursework_id)
      setReport(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="report-page">
      {/* Header with back button */}
      <header className="report-header">
        <Logo size="medium" />
        <button className="back-btn" onClick={onBack}>← Back to Dashboard</button>
      </header>

      <main className="report-main">
        {/* Assignment info */}
        <div className="report-meta">
          <h1 className="report-title">{coursework.title}</h1>
          <p className="report-subtitle">
            {coursework.submission_count} {coursework.submission_count === 1 ? 'submission' : 'submissions'}
          </p>
        </div>

        {loading && <p className="report-status">Loading…</p>}

        {!loading && !report && !error && (
          // No report yet — show the generate button
          <div className="report-empty">
            <p className="report-empty-text">
              No report generated yet. Click below to analyze all submissions with AI.
            </p>
            <button
              className="generate-btn"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? 'Generating report…' : 'Generate AI Report'}
            </button>
            {error && <p className="report-error">{error}</p>}
          </div>
        )}

        {!loading && report && (
          // Report exists — render it
          <div className="report-content">
            <div className="report-timestamp">
              Generated on {new Date(report.created_at).toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric',
              })}
            </div>
            {/* Render the report text — Gemini returns markdown so we format it into sections */}
            <ReportBody content={report.content} />
          </div>
        )}

        {error && !generating && (
          <p className="report-error">{error}</p>
        )}
      </main>
    </div>
  )
}


// Renders the Gemini markdown report into clean readable sections
// Splits on ## headings and renders bold text within each section
function ReportBody({ content }) {
  // Split the report into sections by ## headings
  const sections = content.split(/(?=##\s)/g).filter(Boolean)

  return (
    <div className="report-body">
      {sections.map((section, i) => {
        const lines = section.split('\n').filter(Boolean)
        const heading = lines[0].replace(/^#+\s*/, '') // Strip the ## prefix
        const body = lines.slice(1).join('\n')

        return (
          <div key={i} className="report-section">
            <h2 className="section-heading">{heading}</h2>
            <div className="section-body">
              {/* Render body lines, converting **text** to bold */}
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
// Only used on trusted Gemini output — not user input
function formatLine(line) {
  return line
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')  // **bold**
    .replace(/^\*+\s/, '')                              // Remove leading bullet *
    .replace(/^-+\s/, '')                              // Remove leading bullet -
}


export default ReportPage

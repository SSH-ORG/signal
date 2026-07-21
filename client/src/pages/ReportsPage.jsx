import { useEffect, useState } from 'react'
import { getAllReports } from '../lib/api'
import './Screens.css'
import './ReportsPage.css'

// Global Reports page — reached via the sidebar Reports item
// Lists all assignments that have a generated AI report across all courses
// Clicking a report opens that assignment's detail page
function ReportsPage({ onViewAssignment }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    getAllReports()
      .then(setReports)
      .catch(() => setError('Failed to load reports.'))
      .finally(() => setLoading(false))
  }, [])

  // Group reports by course name — course_name is stored in DB at import time
  // so it's available even for archived courses
  const grouped = reports.reduce((acc, report) => {
    const courseName = report.course_name || 'Archived Class'
    if (!acc[courseName]) acc[courseName] = []
    acc[courseName].push(report)
    return acc
  }, {})

  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <h1 className="screen-title">Reports</h1>
          <p className="screen-subtitle">All AI-generated confusion reports across your classes</p>
        </div>

        {loading && <p className="screen-status">Loading reports…</p>}
        {error && <p className="screen-status screen-status--error">{error}</p>}

        {!loading && !error && reports.length === 0 && (
          <p className="screen-status">
            No reports generated yet. Import an assignment and click Generate AI Report to get started.
          </p>
        )}

        {!loading && !error && Object.entries(grouped).map(([courseName, courseReports]) => (
          <div key={courseName} className="reports-group">
            <h2 className="reports-group-title">{courseName}</h2>
            <ul className="item-list">
              {courseReports.map((report) => (
                <li key={report.report_id}>
                  <button
                    className="item-card"
                    onClick={() => onViewAssignment(report.coursework_id)}
                  >
                    <div className="item-info">
                      <span className="item-name">{report.title}</span>
                      <span className="item-meta">
                        Generated {new Date(report.created_at).toLocaleDateString('en-US', {
                          month: 'short', day: 'numeric', year: 'numeric',
                        })}
                      </span>
                    </div>
                    <span className="chevron">›</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </main>
    </div>
  )
}

export default ReportsPage

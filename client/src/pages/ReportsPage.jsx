import './Screens.css'

// Reached via the "Reports" icon on a course card. Content is intentionally
// empty for now — will eventually list that course's generated AI reports.
function ReportsPage({ courseName, onBack }) {
  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <button className="back-btn" onClick={onBack}>← Classes</button>
        </div>
        <div>
          <h1 className="screen-title">{courseName} Reports</h1>
        </div>
      </main>
    </div>
  )
}

export default ReportsPage

import './ReportBody.css'

// Shared AI report renderer — used on AssignmentDetailPage (classwide + individual)
// and ReportsPage (inline expanded view). Splits on ## headings and renders bold text.
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

// Converts **bold** markdown to <strong> and strips leading bullet characters
// Only called on trusted AI output — never on user input
function formatLine(line) {
  return line
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\*+\s/, '')
    .replace(/^-+\s/, '')
}

export default ReportBody

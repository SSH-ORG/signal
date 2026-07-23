import { useState } from 'react'
import './ReportBody.css'

// Shared AI report renderer — used on AssignmentDetailPage (classwide + individual)
// and ReportsPage (inline expanded view).
// mode="classwide" renders the Class Overview box + the 4 section cards
// (Flagged Students / Common Misconception / Solid Themes / Next Steps) with an
// accordion detail panel underneath. Any other mode (individual student reports)
// falls back to the original stacked-sections layout.
function ReportBody({ content, mode, totalSubmissions }) {
  const sections = content.split(/(?=##\s)/g).filter(Boolean).map(raw => {
    const lines = raw.split('\n').filter(Boolean)
    return { heading: lines[0].replace(/^#+\s*/, '').trim(), body: lines.slice(1).join('\n') }
  })

  if (mode === 'classwide') {
    return <ClasswideReportBody sections={sections} totalSubmissions={totalSubmissions} />
  }

  return (
    <div className="report-body">
      {sections.map((section, i) => (
        <ReportSection key={i} heading={section.heading} body={section.body} />
      ))}
    </div>
  )
}

function findBody(sections, heading) {
  return sections.find(s => s.heading.includes(heading))?.body || ''
}

// Extracts "- something" bullet lines as plain strings (bold markup left in place)
function parseBullets(body) {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s/.test(line))
    .map(line => line.replace(/^[-*]\s/, ''))
}

// Parses "**Label:** description" blocks followed by their bullet students,
// e.g. Common Misconceptions / Solid Themes groups
function parseGroups(body, labelWord) {
  const labelRegex = new RegExp(`^\\*\\*${labelWord}:\\*\\*\\s*`, 'i')
  const groups = []
  let current = null

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (labelRegex.test(line)) {
      if (current) groups.push(current)
      current = { label: line.replace(labelRegex, ''), students: [] }
    } else if (/^[-*]\s/.test(line) && current) {
      current.students.push(line.replace(/^[-*]\s/, ''))
    }
  }
  if (current) groups.push(current)
  return groups
}

function stripBold(text) {
  return (text || '').replace(/\*\*(.+?)\*\*/g, '$1')
}

function ClasswideReportBody({ sections, totalSubmissions }) {
  const overviewBody = findBody(sections, 'Class Overview')
  const overviewDetailsBody = findBody(sections, 'Overview Details')
  const flaggedBody = findBody(sections, 'Flagged Students')
  const misconceptionsBody = findBody(sections, 'Common Misconceptions')
  const themesBody = findBody(sections, 'Solid Themes')
  const nextStepsBody = findBody(sections, 'Next Steps')

  const [showOverviewModal, setShowOverviewModal] = useState(false)
  const [expandedCard, setExpandedCard] = useState(null)

  // AI didn't follow the expected format at all — fall back to raw stacked sections
  if (!overviewBody && !flaggedBody && !misconceptionsBody && !themesBody && !nextStepsBody) {
    return (
      <div className="report-body">
        {sections.map((section, i) => (
          <ReportSection key={i} heading={section.heading} body={section.body} />
        ))}
      </div>
    )
  }

  const flaggedNames = parseBullets(flaggedBody)
  const misconceptionGroups = parseGroups(misconceptionsBody, 'Misconception')
  const themeGroups = parseGroups(themesBody, 'Theme')
  const nextSteps = parseBullets(nextStepsBody)

  const flaggedCount = flaggedNames.length
  const solidCount = new Set(themeGroups.flatMap(g => g.students)).size
  const total = totalSubmissions || flaggedCount + solidCount || 1
  const flaggedPct = Math.round((flaggedCount / total) * 100)
  const solidPct = Math.round((solidCount / total) * 100)

  const cards = [
    { id: 'flagged', label: 'Flagged Students', stat: <span className="card-number">{flaggedCount}</span> },
    {
      id: 'misconceptions',
      label: 'Common Misconception',
      stat: <CardSnapshot text={misconceptionGroups[0]?.label} moreCount={misconceptionGroups.length - 1} />,
    },
    {
      id: 'themes',
      label: 'Solid Themes',
      stat: <CardSnapshot text={themeGroups[0]?.label} moreCount={themeGroups.length - 1} />,
    },
    {
      id: 'next-steps',
      label: 'Next Steps',
      stat: <CardSnapshot text={nextSteps[0]} moreCount={nextSteps.length - 1} />,
    },
  ]

  function toggleCard(id) {
    setExpandedCard(current => (current === id ? null : id))
  }

  return (
    <div className="report-body report-body-classwide">
      <div className="overview-box">
        <h3 className="overview-heading">Class Overview</h3>
        <div className="overview-text">
          {overviewBody.split('\n').filter(Boolean).map((line, i) => (
            <p key={i} dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
          ))}
        </div>
        <button type="button" className="overview-view-more" onClick={() => setShowOverviewModal(true)}>
          View more
        </button>
      </div>

      <div className="report-card-row">
        {cards.map(card => (
          <div key={card.id} className="report-card">
            <h4 className="report-card-title">{card.label}</h4>
            <div className="report-card-stat">{card.stat}</div>
            <button
              type="button"
              className="report-card-view-more"
              onClick={() => toggleCard(card.id)}
            >
              {expandedCard === card.id ? 'Close' : 'View more'}
            </button>
          </div>
        ))}
      </div>

      {expandedCard === 'flagged' && <ReportSection heading="Flagged Students" body={flaggedBody} />}
      {expandedCard === 'misconceptions' && (
        <GroupedSection heading="Common Misconceptions" groups={misconceptionGroups} />
      )}
      {expandedCard === 'themes' && <GroupedSection heading="Solid Themes" groups={themeGroups} />}
      {expandedCard === 'next-steps' && <ReportSection heading="Next Steps" body={nextStepsBody} />}

      {showOverviewModal && (
        <OverviewModal
          onClose={() => setShowOverviewModal(false)}
          detailsBody={overviewDetailsBody}
          totalSubmissions={total}
          flaggedCount={flaggedCount}
          flaggedPct={flaggedPct}
          solidCount={solidCount}
          solidPct={solidPct}
        />
      )}
    </div>
  )
}

function CardSnapshot({ text, moreCount }) {
  if (!text) return <span className="card-empty">None</span>
  return (
    <span className="card-snapshot">
      {stripBold(text)}
      {moreCount > 0 && <span className="card-more"> +{moreCount} more</span>}
    </span>
  )
}

function GroupedSection({ heading, groups }) {
  return (
    <div className="report-section">
      <h3 className="section-heading">{heading}</h3>
      <div className="section-body">
        {groups.length === 0 && <p>None detected.</p>}
        {groups.map((group, i) => (
          <div key={i} className="report-group">
            <p className="report-group-label"><strong>{stripBold(group.label)}</strong></p>
            <ul className="report-group-list">
              {group.students.map((s, j) => <li key={j}>{stripBold(s)}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

function OverviewModal({ onClose, detailsBody, totalSubmissions, flaggedCount, flaggedPct, solidCount, solidPct }) {
  return (
    <div className="overview-modal-backdrop" onClick={onClose}>
      <div className="overview-modal" onClick={e => e.stopPropagation()}>
        <div className="overview-modal-header">
          <h3>Class Overview — Details</h3>
          <button type="button" className="overview-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="overview-modal-body">
          {detailsBody.split('\n').filter(Boolean).map((line, i) => (
            <p key={i} dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
          ))}
          <div className="overview-stats">
            <div className="overview-stat">
              <span className="overview-stat-number">{totalSubmissions}</span>
              <span className="overview-stat-label">Submissions reviewed</span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-number">{flaggedPct}%</span>
              <span className="overview-stat-label">Flagged ({flaggedCount})</span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-number">{solidPct}%</span>
              <span className="overview-stat-label">Solid understanding ({solidCount})</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ReportSection({ heading, body }) {
  return (
    <div className="report-section">
      <h3 className="section-heading">{heading}</h3>
      <div className="section-body">
        {body.split('\n').filter(Boolean).map((line, j) => (
          <p key={j} dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
        ))}
      </div>
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

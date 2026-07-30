import { useEffect, useState } from 'react'
import { splitSections, findBody, parseBullets, parseGroups, stripBold } from '../lib/reportParsing'
import Icon from './Icon'
import './ReportBody.css'

// Shared AI report renderer — used on AssignmentDetailPage (classwide + individual)
// and ReportsPage (inline expanded view).
// mode="classwide" renders the Class Overview box + the 4 section cards
// (Flagged Students / Common Misconception / Solid Themes / Next Steps), each
// color-coded and opening its full detail in a modal. Any other mode
// (individual student reports) falls back to the original stacked-sections layout.
function ReportBody({ content, mode, totalSubmissions }) {
  const sections = splitSections(content)

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

// One color + icon per section so a teacher can tell them apart at a glance,
// consistent between the summary card and its modal
const SECTION_META = {
  overview: { label: 'Class Summary', color: 'var(--accent)', icon: 'bubble_chart' },
  flagged: { label: 'Flagged Students', color: '#d93025', icon: 'priority_high' },
  misconceptions: { label: 'Common Misconceptions', color: '#e67e22', icon: 'psychology_alt' },
  themes: { label: 'Solid Themes', color: '#27ae60', icon: 'check_circle' },
  'next-steps': { label: 'Next Steps', color: '#3b82f6', icon: 'checklist' },
}

function ClasswideReportBody({ sections, totalSubmissions }) {
  const overviewBody = findBody(sections, 'Class Overview')
  const overviewDetailsBody = findBody(sections, 'Overview Details')
  const flaggedBody = findBody(sections, 'Flagged Students')
  const misconceptionsBody = findBody(sections, 'Common Misconceptions')
  const themesBody = findBody(sections, 'Solid Themes')
  const nextStepsBody = findBody(sections, 'Next Steps')

  // Which section's modal is open, or null — a single switch drives all five,
  // instead of separate open/close state per section
  const [openModal, setOpenModal] = useState(null)

  useEffect(() => {
    if (!openModal) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpenModal(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openModal])

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
    { id: 'flagged', stat: <span className="card-number" style={{ color: SECTION_META.flagged.color }}>{flaggedCount}</span> },
    {
      id: 'misconceptions',
      stat: <CardSnapshot text={misconceptionGroups[0]?.label} moreCount={misconceptionGroups.length - 1} />,
    },
    {
      id: 'themes',
      stat: <CardSnapshot text={themeGroups[0]?.label} moreCount={themeGroups.length - 1} />,
    },
    {
      id: 'next-steps',
      stat: <CardSnapshot text={nextSteps[0]} moreCount={nextSteps.length - 1} />,
    },
  ]

  return (
    <div className="report-body report-body-classwide">
      <button
        type="button"
        className="overview-box"
        style={{ '--section-color': SECTION_META.overview.color }}
        onClick={() => setOpenModal('overview')}
      >
        <div className="section-banner">
          <Icon name={SECTION_META.overview.icon} className="section-banner-icon" />
          <h3 className="section-banner-title">Class Summary</h3>
        </div>
        <div className="overview-body">
          <div className="overview-text">
            {overviewBody.split('\n').filter(Boolean).map((line, i) => (
              <p key={i} dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
            ))}
          </div>
          <Icon name="chevron_right" className="section-card-chevron" />
        </div>
      </button>

      <div className="report-card-row">
        {cards.map(card => {
          const meta = SECTION_META[card.id]
          return (
            <button
              key={card.id}
              type="button"
              className="report-card"
              style={{ '--section-color': meta.color }}
              onClick={() => setOpenModal(card.id)}
            >
              <div className="section-banner">
                <Icon name={meta.icon} className="section-banner-icon" />
                <h4 className="section-banner-title">{meta.label}</h4>
              </div>
              <div className={`report-card-body${card.id === 'flagged' ? ' report-card-body--stat' : ''}`}>
                <div className="report-card-stat">{card.stat}</div>
                <Icon name="chevron_right" className="section-card-chevron" />
              </div>
            </button>
          )
        })}
      </div>

      {openModal === 'overview' && (
        <SectionModal meta={SECTION_META.overview} onClose={() => setOpenModal(null)}>
          {overviewDetailsBody.split('\n').filter(Boolean).map((line, i) => (
            <p key={i} className="modal-paragraph" dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
          ))}
          <div className="overview-stats">
            <div className="overview-stat">
              <span className="overview-stat-number">{total}</span>
              <span className="overview-stat-label">Submissions reviewed</span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-number" style={{ color: SECTION_META.flagged.color }}>{flaggedPct}%</span>
              <span className="overview-stat-label">Flagged ({flaggedCount})</span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-number" style={{ color: SECTION_META.themes.color }}>{solidPct}%</span>
              <span className="overview-stat-label">Solid understanding ({solidCount})</span>
            </div>
          </div>
        </SectionModal>
      )}

      {openModal === 'flagged' && (
        <SectionModal meta={SECTION_META.flagged} onClose={() => setOpenModal(null)}>
          <NameChips names={flaggedNames} color={SECTION_META.flagged.color} emptyText="No students flagged." />
        </SectionModal>
      )}

      {openModal === 'misconceptions' && (
        <SectionModal meta={SECTION_META.misconceptions} onClose={() => setOpenModal(null)}>
          <GroupedChips groups={misconceptionGroups} color={SECTION_META.misconceptions.color} emptyText="No common misconceptions detected." />
        </SectionModal>
      )}

      {openModal === 'themes' && (
        <SectionModal meta={SECTION_META.themes} onClose={() => setOpenModal(null)}>
          <GroupedChips groups={themeGroups} color={SECTION_META.themes.color} emptyText="No solid themes detected." />
        </SectionModal>
      )}

      {openModal === 'next-steps' && (
        <SectionModal meta={SECTION_META['next-steps']} onClose={() => setOpenModal(null)}>
          <NumberedSteps steps={nextSteps} color={SECTION_META['next-steps'].color} />
        </SectionModal>
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

// Student names as small pill chips instead of a bullet list — easier to scan,
// especially when a group has many names
function NameChips({ names, color, emptyText }) {
  if (names.length === 0) return <p className="modal-empty-note">{emptyText}</p>
  return (
    <div className="chip-row">
      {names.map((name, i) => (
        <span key={i} className="name-chip" style={{ '--chip-color': color }}>
          {stripBold(name)}
        </span>
      ))}
    </div>
  )
}

// Common Misconceptions / Solid Themes — each group's label as a small heading,
// with its students as chips underneath
function GroupedChips({ groups, color, emptyText }) {
  if (groups.length === 0) return <p className="modal-empty-note">{emptyText}</p>
  return (
    <div className="group-list">
      {groups.map((group, i) => (
        <div key={i} className="report-group">
          <p className="report-group-label">{stripBold(group.label)}</p>
          <div className="chip-row">
            {group.students.map((s, j) => (
              <span key={j} className="name-chip" style={{ '--chip-color': color }}>
                {stripBold(s)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Next Steps as a numbered list with a colored number badge per item, instead
// of plain stacked paragraphs — reads more like an actionable checklist
function NumberedSteps({ steps, color }) {
  if (steps.length === 0) return <p className="modal-empty-note">No next steps provided.</p>
  return (
    <ol className="steps-list">
      {steps.map((step, i) => (
        <li key={i} className="steps-item">
          <span className="steps-number" style={{ background: color }}>{i + 1}</span>
          <span className="steps-text" dangerouslySetInnerHTML={{ __html: formatLine(step) }} />
        </li>
      ))}
    </ol>
  )
}

// Curated view of one student's individual report — used in the Flagged tab's
// popup instead of dumping every section as generic stacked paragraphs. Skips
// the raw submission answer entirely (a Google Doc submission could be long)
// in favor of the AI's own Submission Summary, and keeps Misconceptions/Next
// Steps concise rather than repeating information across sections.
export function IndividualReportSummary({ content }) {
  const sections = splitSections(content)
  const summaryBody = findBody(sections, 'Submission Summary')
  const gotRightBody = findBody(sections, 'What They Got Right')
  const misconceptionsBody = findBody(sections, 'Misconceptions Detected')
  const qualityBody = findBody(sections, 'Submission Quality')
  const gradeBody = findBody(sections, 'Grade')
  const nextStepsBody = findBody(sections, 'Recommended Next Steps')

  const gotRight = parseBullets(gotRightBody)
  const misconceptions = parseBullets(misconceptionsBody)
  const nextSteps = parseBullets(nextStepsBody)

  // "Submission quality is acceptable" is the normal case — only worth a
  // callout when there's an actual issue (blank, too short, off-topic, etc.)
  const qualityIssue = qualityBody && !qualityBody.toLowerCase().includes('acceptable')
    ? stripBold(qualityBody.trim())
    : null

  return (
    <div className="individual-summary">
      {summaryBody && (
        <div className="individual-summary-box">
          <h4 className="individual-summary-box-title">Submission Summary</h4>
          <p className="individual-summary-text">{stripBold(summaryBody.trim())}</p>
        </div>
      )}

      {qualityIssue && (
        <p className="individual-quality-flag">
          <Icon name="error" className="individual-quality-icon" />
          {qualityIssue}
        </p>
      )}

      {gradeBody && (
        <div className="individual-grade-box">
          {gradeBody.split('\n').filter(Boolean).map((line, i) => (
            <p key={i} dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
          ))}
        </div>
      )}

      <div className="individual-summary-columns">
        <div className="individual-summary-box" style={{ '--box-color': SECTION_META.themes.color }}>
          <h4 className="individual-summary-box-title" style={{ color: SECTION_META.themes.color }}>
            <Icon name="check_circle" style={{ color: SECTION_META.themes.color }} /> What they got right
          </h4>
          <IconBulletList
            items={gotRight}
            icon="check"
            color={SECTION_META.themes.color}
            emptyText="No correct understanding demonstrated."
          />
        </div>
        <div className="individual-summary-box" style={{ '--box-color': SECTION_META.misconceptions.color }}>
          <h4 className="individual-summary-box-title" style={{ color: SECTION_META.misconceptions.color }}>
            <Icon name="psychology_alt" style={{ color: SECTION_META.misconceptions.color }} /> Misconceptions
          </h4>
          <IconBulletList
            items={misconceptions}
            icon="close"
            color={SECTION_META.misconceptions.color}
            emptyText="No misconceptions detected."
          />
        </div>
      </div>

      <div className="individual-summary-box" style={{ '--box-color': SECTION_META['next-steps'].color }}>
        <h4 className="individual-summary-box-title" style={{ color: SECTION_META['next-steps'].color }}>
          <Icon name="checklist" style={{ color: SECTION_META['next-steps'].color }} /> Recommended next steps
        </h4>
        <NumberedSteps steps={nextSteps} color={SECTION_META['next-steps'].color} />
      </div>
    </div>
  )
}

function IconBulletList({ items, icon, color, emptyText }) {
  if (items.length === 0) return <p className="modal-empty-note">{emptyText}</p>
  return (
    <ul className="icon-bullet-list">
      {items.map((item, i) => (
        <li key={i} className="icon-bullet-item">
          <Icon name={icon} className="icon-bullet-icon" style={{ color }} />
          <span dangerouslySetInnerHTML={{ __html: formatLine(item) }} />
        </li>
      ))}
    </ul>
  )
}

function SectionModal({ meta, onClose, children }) {
  return (
    <div className="report-modal-backdrop" onClick={onClose}>
      <div className="report-modal" style={{ '--section-color': meta.color }} onClick={e => e.stopPropagation()}>
        <div className="report-modal-header">
          <div className="report-modal-title">
            <Icon name={meta.icon} className="report-modal-icon" />
            <h3>{meta.label}</h3>
          </div>
          <button type="button" className="report-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="report-modal-body">
          {children}
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

import { useEffect, useState } from 'react'
import { splitSections, findBody, parseBullets, parseGroups, stripBold } from '../lib/reportParsing'
import Icon from './Icon'
import './ReportBody.css'

// Shared AI report renderer — used on AssignmentDetailPage (classwide + student)
// and ReportsPage (inline expanded view).
// mode="classwide" renders the Class Summary box + the 4 section cards
// (Flagged Students / Common Misconception / Solid Themes / Next Steps), each
// color-coded and opening its full detail in a modal. Any other mode
// (student reports) falls back to the original stacked-sections layout.
function ReportBody({ content, mode, analyzedSubmissionCount, totalSubmissionCount, excludedContextNote }) {
  const sections = splitSections(content)

  if (mode === 'classwide') {
    return (
      <ClasswideReportBody
        sections={sections}
        analyzedSubmissionCount={analyzedSubmissionCount}
        totalSubmissionCount={totalSubmissionCount}
        excludedContextNote={excludedContextNote}
      />
    )
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

// Exact marker glyph colours — kept identical to the email templates
// (report.py's COLOR dict) so a misconception/theme/next-step reads as the
// same finding whether it's opened in the app or in an inbox
const MARKER_COLOR = { x: '#b45309', check: '#1e8449', arrow: '#2563eb' }

// Single source of truth for verdict wording/colour, mirroring VERDICT_STYLES
// in report.py — the app and every email should always agree on this label
const VERDICT_STYLES = {
  strong: { label: 'Solid Understanding', color: '#27ae60' },
  mixed: { label: 'Mixed Understanding', color: '#e67e22' },
  weak: { label: 'Needs Review', color: '#d93025' },
}

function verdictKey(flaggedCount, solidCount) {
  if (flaggedCount === 0) return 'strong'
  if (flaggedCount > solidCount) return 'weak'
  return 'mixed'
}

function ClasswideReportBody({ sections, analyzedSubmissionCount, totalSubmissionCount, excludedContextNote }) {
  const overviewBody = findBody(sections, 'Class Summary')
  const overviewDetailsBody = findBody(sections, 'Summary Details')
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
  const solidCount = new Set(themeGroups.flatMap((g) => g.students)).size

  // At-a-glance verdict for the Class Summary card — a badge instead of a
  // precise percentage, since the point is "does this need attention," not
  // an exact number. Ratio-based (flagged vs. solid) rather than needing a
  // total submission count, since not every submission is necessarily named
  // in either list.
  const confusionTier = VERDICT_STYLES[verdictKey(flaggedCount, solidCount)]

  const cards = [
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

  const hasSubsetDisclaimer = totalSubmissionCount > 0 && analyzedSubmissionCount < totalSubmissionCount

  return (
    <div className="report-body report-body-classwide">
      {hasSubsetDisclaimer && (
        <p className="subset-disclaimer">
          This report reads the first {analyzedSubmissionCount} of {totalSubmissionCount} submissions turned in.{' '}
          The other {totalSubmissionCount - analyzedSubmissionCount} aren&rsquo;t included here, but you can still build a
          report for any of those students individually.
        </p>
      )}
      {excludedContextNote && (
        <p className="subset-disclaimer">{excludedContextNote}</p>
      )}
      <div className="classwide-top-grid">
        <button
          type="button"
          className="overview-box"
          style={{ '--section-color': SECTION_META.overview.color }}
          onClick={() => setOpenModal('overview')}
        >
          <div className="section-banner">
            <h3 className="section-banner-title">Class Summary</h3>
          </div>
          <span className="confusion-badge" style={{ '--badge-color': confusionTier.color }}>
            {confusionTier.label}
          </span>
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
          {/* Flagged Students is deliberately static, not a button — matches the
              emailed report exactly (count only, no names, no click-through).
              A flagged student's name always appears again under whichever
              misconception earned them the flag, so listing names here too
              would just show the same finding twice. */}
          <div className="report-card report-card--static" style={{ '--section-color': SECTION_META.flagged.color }}>
            <div className="section-banner">
              <Icon name={SECTION_META.flagged.icon} className="section-banner-icon" />
              <h4 className="section-banner-title">{SECTION_META.flagged.label}</h4>
            </div>
            <div className="report-card-body report-card-body--stat">
              <div className="report-card-stat">
                <span className="card-number" style={{ color: SECTION_META.flagged.color }}>{flaggedCount}</span>
              </div>
              <p className="card-hint">See names on the Students tab.</p>
            </div>
          </div>

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
                <div className="report-card-body">
                  <div className="report-card-stat">{card.stat}</div>
                  <Icon name="chevron_right" className="section-card-chevron" />
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {openModal === 'overview' && (
        <SectionModal meta={SECTION_META.overview} onClose={() => setOpenModal(null)}>
          {overviewDetailsBody.split('\n').filter(Boolean).map((line, i) => (
            <p key={i} className="modal-paragraph" dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
          ))}
        </SectionModal>
      )}

      {openModal === 'misconceptions' && (
        <SectionModal meta={SECTION_META.misconceptions} onClose={() => setOpenModal(null)}>
          <GroupedChips
            groups={misconceptionGroups} color={SECTION_META.misconceptions.color}
            emptyText="No common misconceptions found." glyph="✕" glyphColor={MARKER_COLOR.x}
          />
        </SectionModal>
      )}

      {openModal === 'themes' && (
        <SectionModal meta={SECTION_META.themes} onClose={() => setOpenModal(null)}>
          <GroupedChips
            groups={themeGroups} color={SECTION_META.themes.color}
            emptyText="No solid themes found." glyph="✓" glyphColor={MARKER_COLOR.check}
          />
        </SectionModal>
      )}

      {openModal === 'next-steps' && (
        <SectionModal meta={SECTION_META['next-steps']} onClose={() => setOpenModal(null)}>
          <NumberedSteps steps={nextSteps} color={MARKER_COLOR.arrow} arrowIcon />
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

// Common Misconceptions / Solid Themes — each group's label as a small heading,
// with its students as chips underneath. glyph/glyphColor match the same
// marker shown in front of this same finding in the emailed report.
function GroupedChips({ groups, color, emptyText, glyph, glyphColor }) {
  if (groups.length === 0) return <p className="modal-empty-note">{emptyText}</p>
  return (
    <div className="group-list">
      {groups.map((group, i) => (
        <div key={i} className="report-group">
          <p className="report-group-label">
            {glyph && <span className="report-group-glyph" style={{ color: glyphColor }}>{glyph}</span>}
            {stripBold(group.label)}
          </p>
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
// arrowIcon swaps the numbered badge for an arrow — used for the student
// report's Next Step, which is always exactly one item, so numbering it "1"
// falsely implies there's a sequence rather than a single action to take
function NumberedSteps({ steps, color, arrowIcon }) {
  if (steps.length === 0) return <p className="modal-empty-note">No next steps provided.</p>
  return (
    <ol className="steps-list">
      {steps.map((step, i) => (
        <li key={i} className="steps-item">
          <span className="steps-number" style={{ background: color }}>
            {arrowIcon ? <Icon name="arrow_forward" className="steps-number-icon" /> : i + 1}
          </span>
          <span className="steps-text" dangerouslySetInnerHTML={{ __html: formatLine(step) }} />
        </li>
      ))}
    </ol>
  )
}

function DraftTextarea({ label, value, onChange, rows = 3, disabled = false }) {
  return (
    <textarea
      className="next-step-edit-textarea"
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      disabled={disabled}
    />
  )
}

// Curated view of one student's report — used in the Student tab's
// popup instead of dumping every section as generic stacked paragraphs. Skips
// the raw submission answer entirely (a Google Doc submission could be long)
// in favor of the AI's own Submission Summary, and keeps Misconceptions/Next
// Steps concise rather than repeating information across sections.
//
// When editingStudentEmail is true, every section swaps its static view for a
// textarea bound to emailDraft (a second-person AI rewrite, drafted fresh right
// before this view opens — see draft_student_email) so a teacher can tailor any
// section's wording before it's sent, without any of this touching the report
// as stored.
export function StudentReportSummary({
  content,
  submissionContent,
  studentName,
  editingStudentEmail,
  emailDraft,
  onEmailDraftChange,
  onSendToStudent,
  onCancelEdit,
  sendingToStudent,
}) {
  const sections = splitSections(content)
  const summaryBody = findBody(sections, 'Submission Summary')
  const understandsBody = findBody(sections, 'Understands')
  const misconceptionsBody = findBody(sections, 'Misconceptions')
  const qualityBody = findBody(sections, 'Submission Quality')
  const nextStepsBody = findBody(sections, 'Next Step')

  const understands = parseBullets(understandsBody)
  const misconceptions = parseBullets(misconceptionsBody)
  // The AI is instructed to write exactly one bullet here — if it wrote a
  // plain sentence instead (no leading "- "), fall back to treating the
  // whole trimmed body as that one step, rather than showing "no next steps"
  // when a step was actually given, just not in the expected bullet format
  const parsedNextSteps = parseBullets(nextStepsBody)
  const nextSteps = parsedNextSteps.length > 0
    ? parsedNextSteps
    : (nextStepsBody && nextStepsBody.trim() ? [nextStepsBody.trim()] : [])

  // "Submission quality is acceptable" is the normal case — only worth a
  // callout when there's an actual issue (blank, too short, off-topic, etc.)
  const qualityIssue = qualityBody && !qualityBody.toLowerCase().includes('acceptable')
    ? stripBold(qualityBody.trim())
    : null

  // Collapsed by default — a Google Doc submission can be a full essay, so
  // showing it inline unconditionally could make the modal unreadably long
  const [showSubmission, setShowSubmission] = useState(false)

  function updateDraft(field) {
    return (value) => onEmailDraftChange(field, value)
  }

  return (
    <div className="student-summary">
      {(summaryBody || editingStudentEmail) && (
        <div className="student-summary-box">
          <h4 className="student-summary-box-title">Submission Summary</h4>
          {editingStudentEmail ? (
            <DraftTextarea
              label="Submission Summary wording for this student"
              value={emailDraft?.submissionSummary}
              onChange={updateDraft('submissionSummary')}
              disabled={sendingToStudent}
            />
          ) : (
            <p className="student-summary-text">{stripBold(summaryBody.trim())}</p>
          )}
          {/* Not shown while editing — the student-facing email never
              includes Submission Quality, so it isn't part of what's edited */}
          {!editingStudentEmail && qualityIssue && (
            <p className="student-quality-flag">
              <Icon name="error" className="student-quality-icon" />
              {qualityIssue}
            </p>
          )}
        </div>
      )}

      {submissionContent && (
        <div className="student-submission-toggle">
          <button
            type="button"
            className="student-submission-toggle-btn"
            onClick={() => setShowSubmission((v) => !v)}
          >
            <Icon name={showSubmission ? 'expand_less' : 'expand_more'} />
            See submission
          </button>
          {showSubmission && <p className="student-submission-text">{submissionContent}</p>}
        </div>
      )}

      <div className="student-summary-columns">
        <div className="student-summary-box" style={{ '--box-color': SECTION_META.themes.color }}>
          <h4 className="student-summary-box-title" style={{ color: SECTION_META.themes.color }}>
            <Icon name="check_circle" style={{ color: SECTION_META.themes.color }} /> {editingStudentEmail ? 'Spot On' : 'Understands'}
          </h4>
          {editingStudentEmail ? (
            <DraftTextarea
              label="Understands wording for this student"
              value={emailDraft?.understands}
              onChange={updateDraft('understands')}
              disabled={sendingToStudent}
            />
          ) : (
            <IconBulletList
              items={understands}
              icon="check"
              color={MARKER_COLOR.check}
              emptyText="No understanding shown."
            />
          )}
        </div>
        <div className="student-summary-box" style={{ '--box-color': SECTION_META.misconceptions.color }}>
          <h4 className="student-summary-box-title" style={{ color: SECTION_META.misconceptions.color }}>
            <Icon name="psychology_alt" style={{ color: SECTION_META.misconceptions.color }} /> {editingStudentEmail ? 'Almost There' : 'Misconceptions'}
          </h4>
          {editingStudentEmail ? (
            <DraftTextarea
              label="Misconceptions wording for this student"
              value={emailDraft?.misconceptions}
              onChange={updateDraft('misconceptions')}
              disabled={sendingToStudent}
            />
          ) : (
            <IconBulletList
              items={misconceptions}
              icon="close"
              color={MARKER_COLOR.x}
              emptyText="No misconceptions found."
            />
          )}
        </div>
      </div>

      <div className="student-summary-box" style={{ '--box-color': SECTION_META['next-steps'].color }}>
        <h4 className="student-summary-box-title" style={{ color: SECTION_META['next-steps'].color }}>
          <Icon name="checklist" style={{ color: SECTION_META['next-steps'].color }} /> {editingStudentEmail ? 'Try This' : 'Next Step'}
        </h4>
        {editingStudentEmail ? (
          <div className="next-step-edit">
            <p className="next-step-edit-hint">
              This message will be emailed to {studentName} as written above and below. Edit any
              section before sending.
            </p>
            <DraftTextarea
              label="Next Step wording for this student"
              value={emailDraft?.nextStep}
              onChange={updateDraft('nextStep')}
              disabled={sendingToStudent}
            />
            <div className="next-step-edit-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={onSendToStudent}
                disabled={sendingToStudent || !emailDraft?.nextStep?.trim()}
              >
                {sendingToStudent ? 'Sending ..' : 'Send to Student'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={onCancelEdit}
                disabled={sendingToStudent}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <NumberedSteps steps={nextSteps} color={MARKER_COLOR.arrow} arrowIcon />
        )}
      </div>
    </div>
  )
}

// Curated view for a student with no submission — a single "Start Here"
// nudge instead of a full diagnostic report, since there's no submission to
// analyze. Mirrors StudentReportSummary's edit/send pattern but for one
// plain-text field rather than 5 parsed sections.
export function NudgeSummary({
  content,
  studentName,
  editingNudge,
  nudgeDraft,
  onNudgeDraftChange,
  onSendNudge,
  onCancelEdit,
  sendingNudge,
}) {
  const displayText = stripBold((content || '').replace(/^[-*]\s+/, '').trim())

  return (
    <div className="student-summary">
      <div className="student-summary-box" style={{ '--box-color': SECTION_META['next-steps'].color }}>
        <h4 className="student-summary-box-title" style={{ color: SECTION_META['next-steps'].color }}>
          <Icon name="checklist" style={{ color: SECTION_META['next-steps'].color }} /> Start Here
        </h4>
        {editingNudge ? (
          <div className="next-step-edit">
            <p className="next-step-edit-hint">
              This message will be emailed to {studentName} as written below. Edit before sending.
            </p>
            <DraftTextarea
              label="Start Here wording for this student"
              value={nudgeDraft}
              onChange={onNudgeDraftChange}
              disabled={sendingNudge}
            />
            <div className="next-step-edit-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={onSendNudge}
                disabled={sendingNudge || !nudgeDraft?.trim()}
              >
                {sendingNudge ? 'Sending ..' : 'Send to Student'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={onCancelEdit}
                disabled={sendingNudge}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="student-summary-text">{displayText}</p>
        )}
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

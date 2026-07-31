// Shared parsing helpers for the AI report's markdown format — used by
// ReportBody (rendering) and AssignmentDetailPage (deriving flagged students)

export function splitSections(content) {
  return content.split(/(?=##\s)/g).filter(Boolean).map(raw => {
    const lines = raw.split('\n').filter(Boolean)
    return { heading: lines[0].replace(/^#+\s*/, '').trim(), body: lines.slice(1).join('\n') }
  })
}

export function findBody(sections, heading) {
  return sections.find(s => s.heading.includes(heading))?.body || ''
}

// Extracts "- something" bullet lines as plain strings (bold markup left in place)
export function parseBullets(body) {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s/.test(line))
    .map(line => line.replace(/^[-*]\s/, ''))
}

// Parses "**Label:** description" blocks followed by their bullet students,
// e.g. Common Misconceptions / Solid Themes groups
export function parseGroups(body, labelWord) {
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

export function stripBold(text) {
  return (text || '').replace(/\*\*(.+?)\*\*/g, '$1')
}

// Pulls flagged students out of a classwide report, paired with which
// misconception group (if any) they fall under — used by AssignmentDetailPage
// to build the Student tab without waiting on any student report to exist first
export function parseFlaggedStudents(classwideContent) {
  if (!classwideContent) return []
  const sections = splitSections(classwideContent)
  const names = parseBullets(findBody(sections, 'Flagged Students'))
  const groups = parseGroups(findBody(sections, 'Common Misconceptions'), 'Misconception')

  return names.map(name => {
    const group = groups.find(g =>
      g.students.some(s => s.trim().toLowerCase() === name.trim().toLowerCase())
    )
    return { name, misconception: group ? stripBold(group.label) : null }
  })
}

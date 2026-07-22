import './Screens.css'
import './HelpPage.css'

// Help page — explains the Signal workflow to first-time teachers
// Reached via the sidebar Help item
function HelpPage() {
  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <h1 className="screen-title">How-to</h1>
          <p className="screen-subtitle">A guide to your first AI report</p>
        </div>

        <div className="help-steps">

          <div className="help-step">
            <div className="help-step-number">1</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Choose a class</h2>
              <p className="help-step-text">
                On the Home screen, choose a class to see its assignments. Signal pulls these from
                your Google Classroom.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">2</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Sync an assignment</h2>
              <p className="help-step-text">
                After choosing an assignment, click the sync icon next to the submission count.
                The first click syncs the assignment itself into Signal; clicking it again pulls
                in any new submissions since the last sync.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">3</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Add context (recommended)</h2>
              <p className="help-step-text">
                In the Context tab, use the <strong>Mental Model</strong> box to describe what student
                understanding looks like — that's what the AI compares submissions against. The
                <strong> Reference Materials</strong> column has your assignment description and rubric
                from Google Classroom (click <strong>Sync Rubric</strong> to add it in), each with its
                own toggle to include or exclude it from the report.
              </p>
              <p className="help-step-text">
                Without a mental model or rubric, the AI will still analyze submissions but won't
                know what the expected answer is, so the report will be less targeted.
              </p>
              <p className="help-step-text">
                <strong>Reminder:</strong> use the <strong>Save Context</strong> button to save your
                changes before building a report.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">4</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Build an AI Report</h2>
              <p className="help-step-text">
                Once all submissions are in, click <strong>Build</strong>. The AI reads every
                submission, compares them against your context/rubric/assignment description, and
                produces a class-wide confusion report.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">5</div>
            <div className="help-step-body">
              <h2 className="help-step-title">View, email, or delete past reports</h2>
              <p className="help-step-text">
                All reports are saved. Access them from the <strong>Reports</strong> page in the
                sidebar — grouped by class, with filters for class and time range. From there, or
                from the assignment's own AI Report tab, you can email a report to yourself or
                delete it so it can be built again later.
              </p>
            </div>
          </div>

        </div>

        <div className="help-tip">
          <p><strong>Tip:</strong> You can refresh a report after syncing new submissions or editing the context. The latest report always replaces the previous one.</p>
        </div>

      </main>
    </div>
  )
}

export default HelpPage

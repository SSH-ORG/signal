import './Screens.css'
import './HelpPage.css'

// Help page — explains the Signal workflow to first-time teachers
// Reached via the sidebar Help item
function HelpPage() {
  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <h1 className="screen-title">how-to</h1>
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
                After choosing an assignment, its data is synced to our app and you land on its
                detail page. Need to refresh submissions? Click the sync icon next to the
                submission count.
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
                from Google Classroom, each with its own toggle to include or exclude it from the
                report and its own sync button — <strong>Sync Description</strong> or
                <strong> Sync Rubric</strong> — to pull in the latest version from Google Classroom.
              </p>
              <p className="help-step-text">
                Without context (mental model/rubric/assignment description), the AI will not
                build a report.
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
                Once all submissions are in, go to the <strong>AI Report</strong> tab and click
                <strong> Build</strong>. The AI reads every submission, compares them against your
                context (mental model/rubric/assignment description), and produces a class-wide
                confusion report.
                You can also build a report for one specific student separately, or switch to the
                <strong> Student</strong> view to see flagged students' reports once the classwide
                report has been built.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">5</div>
            <div className="help-step-body">
              <h2 className="help-step-title">View or delete past reports</h2>
              <p className="help-step-text">
                All reports can be found from the <strong>Reports</strong> page in the sidebar —
                choose a class, then an assignment to land into that assignment's AI Report tab.
                From the Reports list itself you can delete a report — it can be built again
                later; emailing a report to yourself is one click away on the AI Report tab.
              </p>
            </div>
          </div>

        </div>

        <div className="help-tip">
          <p><strong>Tip:</strong> You can refresh a report after syncing new submissions or editing the context. The latest report always replaces the previous one.</p>
        </div>

        <div className="help-tip">
          <p>
            <strong>Tip:</strong> In <strong>Account</strong>, turn on Email Notifications to get an
            email once an assignment reaches its due date or has enough submissions to build a
            report — choose whether that arrives each day or each week.
          </p>
        </div>

      </main>
    </div>
  )
}

export default HelpPage

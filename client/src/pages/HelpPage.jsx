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
                confusion report. A class-wide report needs at least 5 sufficient submissions to
                meaningfully compare across students — below that, build a report for one specific
                student instead, which you can also do for any student at any time. Switch to the
                <strong> Student</strong> view to see flagged students' reports once the classwide
                report has been built.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">5</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Send feedback to a student</h2>
              <p className="help-step-text">
                From a student's report, click <strong>Email Report → Email to student</strong>.
                The AI drafts a version of the report written directly to that student — their
                submission summary, what they understood, misconceptions, submission quality, and
                next step, all addressed to them rather than written as internal analysis for you.
                Review and edit any section before sending; this never changes the report as it's
                stored, only the content sent to that student.
              </p>
              <span className="help-step-badge">
                For students with empty or no submission, you can build a short, encouraging
                first step to help them start.
              </span>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">6</div>
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
            <strong>Tip:</strong> In <strong>Account</strong>, turn on Email Notifications to get a
            reminder email once an assignment reaches its due date or has enough submissions to
            build a report — choose whether that arrives each day or each week.
          </p>
        </div>

        <div className="help-tip">
          <p>
            <strong>Tip:</strong> <strong>Auto-Send</strong> (Beta), also in
            <strong> Account</strong>, is separate from Email Notifications above. Instead of just
            reminding you, it automatically builds and emails a class-wide report as soon as an
            assignment is due and has enough submissions.
          </p>
        </div>

        <div className="help-tip">
          <p>
            <strong>Tip:</strong> Signal only syncs assignments and short-answer questions from
            Google Classroom — multiple-choice questions aren't supported. For assignments, only
            Google Doc attachments are read; Slides, Sheets, PDFs, and links aren't.
          </p>
        </div>

      </main>
    </div>
  )
}

export default HelpPage

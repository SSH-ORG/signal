import './Screens.css'
import './HelpPage.css'

// Help page — explains the Signal workflow to first-time teachers
// Reached via the sidebar Help item
function HelpPage() {
  return (
    <div className="screen">
      <main className="screen-main">
        <div>
          <h1 className="screen-title">How Signal Works</h1>
          <p className="screen-subtitle">A quick guide to getting your first AI report</p>
        </div>

        <div className="help-steps">

          <div className="help-step">
            <div className="help-step-number">1</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Pick a class and assignment</h2>
              <p className="help-step-text">
                On the Home screen, select a class to see its assignments. Signal pulls these
                directly from your Google Classroom — no manual entry needed.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">2</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Add context (optional but recommended)</h2>
              <p className="help-step-text">
                On the assignment detail page you'll see a Context box. This is what the AI uses
                to understand what a correct answer looks like. You can type in a rubric,
                learning goals, or an answer key — or click <strong>Load Rubric from Google Classroom</strong> to
                pull in the rubric you already created there.
              </p>
              <p className="help-step-text">
                Without context, the AI will still analyze submissions but won't know what
                the expected answer is, so the report will be less targeted.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">3</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Import the assignment</h2>
              <p className="help-step-text">
                Click <strong>Import Assignment</strong> to pull all student submissions into Signal.
                If you've already imported it before, click <strong>Sync Submissions</strong> to pick
                up any new responses since the last import.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">4</div>
            <div className="help-step-body">
              <h2 className="help-step-title">Generate the AI report</h2>
              <p className="help-step-text">
                Once submissions are imported, click <strong>Generate AI Report</strong>. The AI reads
                every submission, checks them against your context or rubric, and produces a
                class-wide confusion report with:
              </p>
              <ul className="help-list">
                <li>What students got right</li>
                <li>Specific mistakes and how widespread they are</li>
                <li>Concrete steps to address the confusion in your next class</li>
              </ul>
              <p className="help-step-text">
                If a rubric was loaded, you also get a per-criterion breakdown.
              </p>
            </div>
          </div>

          <div className="help-step">
            <div className="help-step-number">5</div>
            <div className="help-step-body">
              <h2 className="help-step-title">View past reports</h2>
              <p className="help-step-text">
                All generated reports are saved. Access them any time from the <strong>Reports</strong> page
                in the sidebar — organized by class so you can track confusion patterns over time.
              </p>
            </div>
          </div>

        </div>

        <div className="help-tip">
          <p><strong>Tip:</strong> You can regenerate a report after syncing new submissions or editing the context. The latest report always replaces the previous one.</p>
        </div>

      </main>
    </div>
  )
}

export default HelpPage

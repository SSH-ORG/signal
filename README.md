![Signal logo](docs/signal-logo.gif)

# signal

**signal** is a Google Classroom helper tool, we read each submission students turn in, and turn them into a clear, class-wide and per-student report with confusion themes and a call-to-action — before confusion sets into the next lesson. 

**Live deployed link:** https://signal-client.onrender.com/

### Team SSH
***
- #### Sanaa-Uzuri [*Scrum Master*]

- #### Syed [*Tech Lead*]

- #### Hannah [*Product Lead*]

### Testing
***
###

Our team provides a demo Google account so test users can log in without having to set up Google Classroom or ask for authorization.
Sign in at the deployed link above using the login credentials in our feedback form: https://forms.gle/w5ZB37N6FFe9ScVp9

If you'd like to use your personal Google account, email Syed: *xayanmay@gmail.com* so we
can add you as a test user on our domain.

### Core Stack
***
#### Frontend
- React.js + Vite
- HTML/CSS

#### Backend
- FastAPI (Python)
- SQLAlchemy + Alembic (PostgreSQL ORM and migrations)
- PostgreSQL

#### Integrations
- Google OAuth 2.0 + Google Classroom API (Authlib)
- Groq API — Llama 3.3 70B for AI feature
- Resend for email feature

### Local Setup
***
###
Requires Node.js 20+, Python 3.11+, and a local PostgreSQL instance.

#### 1. Clone the repo and create the database
```bash
git clone git@github.com:SSH-ORG/signal.git
cd signal
createdb signal_db
```

#### 2. Fill environment variables

Paste `.env.example` to `.env` inside the repo root and fill in the values:
```
DATABASE_URL=postgresql://user:password@localhost:5432/signal_db

GOOGLE_CLIENT_ID=your-google-client-id

GOOGLE_CLIENT_SECRET=your-google-client-secret

SESSION_SECRET=your-secret-key-here

GROQ_API_KEY=your-groq-api-key-here      # free tier at console.groq.com

RESEND_API_KEY=your-resend-api-key-here
```
Google credentials are from a project in the [Google Cloud Console](https://console.cloud.google.com/)
with Classroom API enabled and an OAuth consent screen configured.

Paste `client/.env.example` to `client/.env` only if the backend isn't running on the default
`http://localhost:8000`.

#### 3. Backend *[server]*
```bash
cd server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload
```
The API runs at `http://localhost:8000`. `/health` returns `{"status": "ok"}` once it's up.

#### 4. Frontend *[client]*
```bash
cd client
npm install
npm run dev
```
App runs at `http://localhost:5173`.

### Usage Guide
***
###
Below is a walkthrough of **signal's** user flow.

*<details><summary><strong>Choose a class</strong></summary>*

![Choose a class](./docs/img/choose-a-class.png)

The Home screen lists your Google Classroom courses. Choose one to see its assignments.
</details>

*<details><summary><strong>Sync an assignment</strong></summary>*

![Sync an assignment](./docs/img/sync-an-assignment.png)

Choose an assignment, then click the sync icon next to the submission count to sync the assignment itself, later clicks sync new submissions.
</details>

*<details><summary><strong>Add context</strong></summary>*

![Add context](./docs/img/add-context.png)

Describe how student understanding should look like in the Mental Model box, and optionally
include the assignment description and rubric synced from Classroom.

***Reminder:*** use the *Save Context* button to save your changes before building a report.
</details>

*<details><summary><strong>Build an AI Report</strong></summary>*

![Build an AI Report](./docs/img/build-an-ai-report.png)

Click Build to analyze every submission against that context and produce a class-wide confusion report.
</details>


### Data Model
***
###

```mermaid
erDiagram
    users ||--o{ coursework : owns
    coursework ||--o{ submission : has
    coursework ||--|| report : has

    users {
        int user_id PK
    }
    coursework {
        int coursework_id PK
        int user_id FK
    }
    submission {
        int submission_id PK
        int coursework_id FK
    }
    report {
        int report_id PK
        int coursework_id FK "unique"
    }
```

Each teacher (`users`) owns many synced assignments (`coursework`), each assignment has many student submissions
(`submission`) and at most one AI-generated report (`report` — enforced as a database-level unique constraint, not
just convention). Deleting a row cascades down: removing a user removes their coursework, submissions, and reports.

### API Endpoints
***
###

All under `/auth` and `/api`, session-cookie authenticated:

**Auth**

| Method | Path | Description |
|---|---|---|
| GET | `/auth/google` | Start Google sign-in |
| GET | `/auth/google/callback` | OAuth callback |
| GET | `/auth/me` | Current logged-in user |
| PATCH | `/auth/profile` | Edit name/email, digest cadence (daily/weekly), and Auto-Send (beta) settings |
| DELETE | `/auth/account` | Delete account and all its data/permissions |
| POST | `/auth/logout` | Log out |

**Google Classroom Integration**

| Method | Path | Description |
|---|---|---|
| GET | `/api/google/courses` | Live list of active Google Classroom courses |
| GET | `/api/google/courses/{course_id}/coursework` | Live list of one course's assignments |
| GET | `/api/google/coursework/{id}/rubric` | Fetch a rubric from Classroom |
| GET | `/api/google/coursework/{id}/description` | Fetch an assignment's current description from Classroom |
| POST | `/api/google/coursework/{id}/sync` | Sync an assignment and its submissions into Signal |

**Coursework**

| Method | Path | Description |
|---|---|---|
| GET | `/api/coursework` | List synced assignments |
| PATCH | `/api/coursework/{id}` | Edit an assignment's context |

**Reports**

| Method | Path | Description |
|---|---|---|
| GET | `/api/coursework/{id}/report` | Get the existing class-wide AI report for an assignment |
| POST | `/api/coursework/{id}/report` | Build/rebuild the class-wide AI report |
| DELETE | `/api/coursework/{id}/report` | Delete the report |
| POST | `/api/coursework/{id}/report/email` | Email the class-wide report to yourself |
| GET | `/api/coursework/{id}/report/submissions` | List submissions + per-student reports for an assignment |
| POST | `/api/coursework/{id}/report/submissions/{submission_id}` | Build one student's report |
| POST | `/api/coursework/{id}/report/submissions/{submission_id}/email` | Email one student's report to yourself |
| POST | `/api/coursework/{id}/report/submissions/{submission_id}/draft-student-email` | Draft a second-person rewrite of a student's report for review |
| POST | `/api/coursework/{id}/report/submissions/{submission_id}/send-to-student` | Send a student's report directly to their own email |
| GET | `/api/reports` | All reports across every class |

### Project Status
***
###

MVP complete.

#### User flow

```mermaid
flowchart TD
    A[Sign in with<br/>Google] --> B[Sync Google<br/>Classroom]
    B --> C[Choose a class]
    C --> D[Choose an<br/>assignment]
    D --> E[Build a report]
    E --> F[Class-wide report]
    E --> G[Per-student report]
    F --> H[Email report<br/>to yourself]
    G --> J[Email report<br/>to yourself]
    G --> I[AI drafts in<br/>second person,<br/>teacher edits<br/>before sending<br/>to student]
```

- Reports can be built **class-wide** or per **student**. A per-student report is written for internal review for the teacher. 
- A `student report > student email`, is drafted by AI in second person and has a action plan, aligned to each student's confusion theme. The AI drafted student email can be edited by the teacher before it is sent.
- Account settings has optional daily/weekly email
notifications, and an opt-in Auto-Send (beta) that builds and emails a class-wide report automatically once an
assignment is due and has enough submissions. No manual action needed.

#### In progress:
- AI report accuracy/quality (ongoing tuning based on teacher feedback)
- Auto-Send is in beta mode and opt-in only, teacher sets their own submission threshold, still gathering feedback before wider rollout.

#### Limitations
- AI feature is still in demo mode (please share feedback: https://forms.gle/w5ZB37N6FFe9ScVp9)
- We're still on the free, testing tier of the Google Classroom API — Google hasn't approved our app yet, so only manually-approved test users can sign in with Google. Please email Syed: *xayanmay@gmail.com* for approval.
- A class-wide report only ever analyzes the first 50 submissions turned in. A larger class report is built from that subset, clearly disclosed both on the report itself and in the class-wide email sent to the teacher.

### License
***
###
MIT License — see [LICENSE](LICENSE). Free to use, modify, and distribute with attribution;
provided as-is with no warranty.

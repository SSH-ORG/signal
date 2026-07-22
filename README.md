![Signal logo](docs/signal-logo.gif)

# signal

**signal** is a Google Classroom helper tool, we read each submission students turn in, and turn them into a clear, class-wide report with confusion themes and a call-to-action — before confusion sets into the next lesson. 

**Live deployed link:** [paste-link-here]

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

![paste-image-here](./docs/img/paste-image-here.png)

The Home screen lists your Google Classroom courses. Choose one to see its assignments.
</details>

*<details><summary><strong>Sync an assignment</strong></summary>*

![paste-image-here](./docs/img/paste-image-here.png)

Choose an assignment, then click the sync icon next to the submission count to pull its
submissions into Signal — the first click syncs the assignment itself, later clicks sync new submissions.
</details>

*<details><summary><strong>Add context</strong></summary>*

![paste-image-here](./docs/img/paste-image-here.png)

Describe how student understanding should look like in the Mental Model box, and optionally
include the assignment description and rubric synced from Classroom.
</details>

*<details><summary><strong>Build an AI Report</strong></summary>*

![paste-image-here](./docs/img/paste-image-here.png)

Click Build to analyze every submission against that context and produce a class-wideconfusion report.
</details>


### API Endpoints
***
###

All under `/auth` and `/api`, session-cookie authenticated:

| Method | Path | Description |
|---|---|---|
| GET | `/auth/google` | Start Google sign-in |
| GET | `/auth/google/callback` | OAuth callback |
| GET | `/auth/me` | Current logged-in user |
| PATCH | `/auth/profile` | Edit name/email/notification preference |
| DELETE | `/auth/account` | Delete account and all its data/permissions |
| POST | `/auth/logout` | Log out |
| GET | `/api/google/coursework` | Live list of assignments |
| GET | `/api/google/coursework/{id}/rubric` | Fetch a rubric from Classroom |
| POST | `/api/google/coursework/{id}/import` | Sync an assignment's submissions |
| GET | `/api/coursework` | List synced assignments |
| GET | `/api/coursework/{id}` | Single assignment + submissions + report |
| PATCH | `/api/coursework/{id}` | Edit an assignment's context |
| GET | `/api/coursework/{id}/report` | Build the AI report |
| POST | `/api/coursework/{id}/report` | Build/rebuild the AI report |
| POST | `/api/coursework/{id}/report/email` | Email the report |
| DELETE | `/api/coursework/{id}/report` | Delete the report |
| GET | `/api/reports` | All reports across every class |

### Project Status
***
###
MVP complete. User flow: sign in > sync Google Classroom > choose a class > choose a assignment > build a report.

#### Still in progress:
- Email feature integration
- AI feature accuracy

#### Limitations
- AI feature is still in demo mode (please share feedback on our form: [paste-link-here])
- Google has not approved our app so we are using a demo version, only approved test users (manually added) can sign in with Google. Please email Syed: *xayanmay@gmail.com* for approval.

### License
***
###
MIT License — see [LICENSE](LICENSE). Free to use, modify, and distribute with attribution;
provided as-is with no warranty.

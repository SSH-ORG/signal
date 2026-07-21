import base64
from email.mime.text import MIMEText

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.controllers.google import _auth_headers, _refresh_access_token

GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

# Same frontend URL auth.py redirects back to after login
FRONTEND_URL = "http://localhost:5173"


def _build_raw_message(to: str, subject: str, html_body: str) -> str:
    # Gmail's send API wants a full RFC 2822 message, base64url-encoded
    message = MIMEText(html_body, "html")
    message["to"] = to
    message["subject"] = subject
    return base64.urlsafe_b64encode(message.as_bytes()).decode()


def build_report_email_html(title: str, content: str) -> str:
    content_html = content.replace("\n", "<br>")
    return f"""\
<div style="font-family: sans-serif; color: #222; line-height: 1.5;">
  <h2 style="margin-bottom: 4px;">{title}</h2>
  <div>{content_html}</div>
  <p style="margin-top: 24px; font-size: 0.85em; color: #666;">
    Sent through <a href="{FRONTEND_URL}" style="color: #aa3bff;">Signal</a>
  </p>
</div>
"""


async def send_email(user: User, db: Session, subject: str, html_body: str) -> None:
    # Sends an email from the teacher's own Gmail account, using the same
    # OAuth token (and refresh-on-401 pattern) as our other Google API calls
    raw = _build_raw_message(user.email, subject, html_body)
    payload = {"raw": raw}

    async with httpx.AsyncClient() as client:
        resp = await client.post(GMAIL_SEND_URL, headers=_auth_headers(user), json=payload)

        if resp.status_code == 401:
            await _refresh_access_token(user, db)
            resp = await client.post(GMAIL_SEND_URL, headers=_auth_headers(user), json=payload)

    if resp.status_code == 403:
        raise HTTPException(
            status_code=403,
            detail="Signal needs permission to send email. Please log out and log back in to grant access.",
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail="Failed to send email.")

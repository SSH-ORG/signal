from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.submission import Submission
from app.jobs.email import verify_resolve_token

router = APIRouter()

_SUCCESS_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Resolved — Signal</title></head>
<body style="margin:0;padding:0;background:#f0f0f0;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:400px;margin:80px auto;background:#fff;border-radius:12px;
              padding:40px;text-align:center;border:1px solid #e8e8e8;">
    <p style="font-size:40px;margin:0 0 16px;">✅</p>
    <h2 style="font-size:18px;font-weight:700;color:#27ae60;margin:0 0 10px;">{name} marked as resolved</h2>
    <p style="font-size:14px;color:#555;margin:0;">
      This student won't appear in future email digests unless a new issue is detected.
    </p>
  </div>
</body></html>"""

_ERROR_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Error — Signal</title></head>
<body style="margin:0;padding:0;background:#f0f0f0;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:400px;margin:80px auto;background:#fff;border-radius:12px;
              padding:40px;text-align:center;border:1px solid #e8e8e8;">
    <p style="font-size:40px;margin:0 0 16px;">⚠️</p>
    <h2 style="font-size:18px;font-weight:700;color:#d93025;margin:0 0 10px;">{title}</h2>
    <p style="font-size:14px;color:#555;margin:0;">{detail}</p>
  </div>
</body></html>"""


# GET /api/resolve/{submission_id}/{token}
# No session required — token-based auth only.
# Marks the submission as resolved so it stops appearing in future email digests.
@router.get("/api/resolve/{submission_id}/{token}", response_class=HTMLResponse)
def resolve_submission(
    submission_id: int,
    token: str,
    db: Session = Depends(get_db),
):
    verified_id = verify_resolve_token(token)
    if verified_id != submission_id:
        return HTMLResponse(
            _ERROR_HTML.format(
                title="Link expired or invalid",
                detail="This resolve link has expired. Open Signal to manage student statuses.",
            ),
            status_code=400,
        )

    sub = db.query(Submission).filter(Submission.submission_id == submission_id).first()
    if not sub:
        return HTMLResponse(
            _ERROR_HTML.format(title="Submission not found", detail=""),
            status_code=404,
        )

    sub.resolved = True
    db.commit()

    name = sub.student_name or f"Student {sub.submission_id}"
    return HTMLResponse(_SUCCESS_HTML.format(name=name))

from fastapi import Request, HTTPException, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User


# require_login is a FastAPI dependency — works like middleware in Express
# Add it to any route that needs the teacher to be logged in
# It reads the session cookie, finds the user in the DB, and returns them
# If the user is not logged in, it automatically returns a 401 error
def require_login(request: Request, db: Session = Depends(get_db)) -> User:
    user_id = request.session.get("user_id")

    # No session cookie means the teacher hasn't logged in
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Look up the user in the database
    user = db.query(User).filter(User.user_id == user_id).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Return the user object so the route handler can use it directly
    return user

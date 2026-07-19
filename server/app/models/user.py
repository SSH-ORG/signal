from sqlalchemy import Column, Integer, Text, Boolean
from app.database import Base


# Represents the 'users' table in PostgreSQL
# Each row is a teacher who has logged in via Google OAuth
class User(Base):
    __tablename__ = "users"

    user_id = Column(Integer, primary_key=True, autoincrement=True)  # Auto-generated unique ID
    google_id = Column(Text, unique=True, nullable=False)             # Google's unique ID for this user
    google_access_token = Column(Text)                                # Token used to call Google APIs on their behalf
    google_refresh_token = Column(Text)                               # Used to get a new access token when it expires

    # Profile fields — prefilled from Google on first login, editable afterward.
    # Kept independent of Google's own profile so a teacher's edits here are never
    # overwritten by a later re-login.
    display_name = Column(Text)
    email = Column(Text)
    email_notifications_enabled = Column(Boolean, nullable=False, server_default="false")

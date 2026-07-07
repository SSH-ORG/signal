from sqlalchemy import Column, Integer, Text
from app.database import Base


# Represents the 'users' table in PostgreSQL
# Each row is a teacher who has logged in via Google OAuth
class User(Base):
    __tablename__ = "users"

    user_id = Column(Integer, primary_key=True, autoincrement=True)  # Auto-generated unique ID
    google_id = Column(Text, unique=True, nullable=False)             # Google's unique ID for this user
    google_access_token = Column(Text)                                # Token used to call Google APIs on their behalf
    google_refresh_token = Column(Text)                               # Used to get a new access token when it expires

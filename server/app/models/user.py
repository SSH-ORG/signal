from sqlalchemy import Column, Integer, Text
from app.database import Base


class User(Base):
    __tablename__ = "users"

    user_id = Column(Integer, primary_key=True, autoincrement=True)
    google_id = Column(Text, unique=True, nullable=False)
    google_access_token = Column(Text)
    google_refresh_token = Column(Text)

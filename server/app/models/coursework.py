from sqlalchemy import Column, Integer, Text, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


class Coursework(Base):
    __tablename__ = "coursework"

    coursework_id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(Text, nullable=False)
    context = Column(Text, default="")
    user_id = Column(Integer, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    google_coursework_id = Column(Text)

    submissions = relationship("Submission", back_populates="coursework", cascade="all, delete")
    report = relationship("Report", back_populates="coursework", uselist=False, cascade="all, delete")

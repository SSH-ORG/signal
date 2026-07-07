import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from dotenv import load_dotenv

# Load environment variables from .env file (DATABASE_URL lives here)
load_dotenv()

# Grab the database connection string from the environment
DATABASE_URL = os.getenv("DATABASE_URL")

# Create the SQLAlchemy engine — this is the actual connection to PostgreSQL
engine = create_engine(DATABASE_URL)

# SessionLocal is a factory for creating new database sessions
# autocommit=False means we control when changes are saved
# autoflush=False means SQLAlchemy won't auto-sync before every query
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# Base class that all our models (User, Coursework, etc.) will inherit from
# SQLAlchemy uses this to know which classes map to database tables
class Base(DeclarativeBase):
    pass


# Dependency used by FastAPI route handlers to get a DB session
# Automatically closes the session when the request is done (via finally)
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

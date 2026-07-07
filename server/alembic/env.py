
import os
import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from dotenv import load_dotenv
from alembic import context

# Load .env so DATABASE_URL is available
load_dotenv()

# Add the server/ directory to Python's path so we can import our app modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Import Base so Alembic knows the schema structure
from app.database import Base
# Import all models so they register themselves on Base.metadata
# Without this, autogenerate won't detect any of our tables
import app.models  # noqa: F401

# Alembic config object — reads from alembic.ini
config = context.config

# Set up Python logging using the config in alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Inject the DATABASE_URL from our .env into Alembic's config at runtime
# This way we never hardcode credentials in alembic.ini
config.set_main_option("sqlalchemy.url", os.getenv("DATABASE_URL"))

# Tell Alembic to compare migrations against our actual model definitions
# This enables `alembic revision --autogenerate` to detect schema changes
target_metadata = Base.metadata


# Offline mode: generates SQL migration scripts without connecting to the DB
# Useful for reviewing what SQL will run before applying it
def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


# Online mode: connects to the real DB and applies migrations directly
# This is what runs when you do `alembic upgrade head`
def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        with context.begin_transaction():
            context.run_migrations()


# Alembic decides which mode to use based on how the command was invoked
if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

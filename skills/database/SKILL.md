---
id: database
label: Database And SQL
description: Work with SQL, schema design, migrations, seed data, query fixes, and local database-backed apps.
triggers:
  - database
  - sql
  - sqlite
  - postgres
  - mysql
  - migration
  - schema
  - query
  - seed data
tools:
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
---
# Database And SQL

Inspect existing migrations, models, schema dumps, seed data, and app access patterns before changing persistence code.

Prefer reversible migrations and local fixtures. Never silently drop or rewrite user data. If destructive migration or production credential access would be required, stop and request explicit direction.


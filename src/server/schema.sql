-- schema.sql — applied idempotently on boot by ensureSchema() in db.ts.
-- No migration framework yet: every statement is `if not exists`, so re-running is a no-op.
--
-- `credential` (凭证A) is a user's issued token: every environment and session column named
-- `credential` holds a `users.token`. It stays a denormalised text column with no FK — the
-- namespace key predates the users table, and a session outliving its account is a data
-- question, not a constraint we want the event ingest path to pay for.

-- One account = one token, issued at registration and never rotated. `token` is what the CLI
-- puts in `Authorization: Bearer` and what the web opens /ws/client with.
create table if not exists users (
  username      text primary key,
  password_hash text not null,   -- scrypt, encoded by hashPassword() in store.ts
  token         text not null,
  created_at    timestamptz not null default now(),
  last_login    timestamptz
);

create table if not exists environments (
  id            text primary key,
  credential    text not null,
  machine_name  text,
  dir           text,
  branch        text,
  git_repo_url  text,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  id            text primary key,
  credential    text not null,
  -- '' for REPL (/rc) sessions. Deliberately no FK: an environment can be forgotten
  -- (load window, manual cleanup) while its sessions are still worth keeping.
  env_id        text not null default '',
  ingress_token text not null,
  work_id       text not null default '',
  machine_name  text,
  dir           text,
  branch        text,
  git_repo_url  text,
  created_at    timestamptz not null default now(),
  last_activity timestamptz not null default now()
);

-- Session-list summary (prompt preview / running tool / tool count / model), derived from the
-- event stream in store.foldDigest and flushed on the same batch as last_activity. Added after
-- the table existed, hence the separate statement rather than a column in the create above.
alter table sessions add column if not exists digest jsonb;

create table if not exists events (
  id          bigserial primary key, -- globally monotonic; ordering by it is chronological
  session_id  text not null references sessions(id) on delete cascade,
  type        text,                  -- payload.type, for filtering/stats without touching jsonb
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

-- The fine-grained sibling of `events.type`, for the same reason that column exists: answering
-- "which payload shapes has this deployment actually seen, and have we decided what to do with
-- each?" without reading 40 MB of jsonb (or exporting a whole conversation history to disk just
-- to count shapes). Written by insertEvents via shapeOf(); backfilled for existing rows by
-- scripts/backfill-shape.mjs. The verdict is deliberately NOT stored — it is code, it changes
-- the moment a shape gets adapted, so it is applied at read time (src/wire-shape.ts).
alter table events add column if not exists shape text;
create index if not exists events_shape_idx on events (shape);

create unique index if not exists users_token_idx on users (token);
create index if not exists sessions_credential_idx on sessions (credential, last_activity desc);
create unique index if not exists sessions_ingress_token_idx on sessions (ingress_token);
create index if not exists environments_credential_idx on environments (credential);
create index if not exists events_session_idx on events (session_id, id);
-- Lookup path for the blob route: the web holds `<payload uuid>:<n>` references instead of the
-- base64 image data, and resolving one must not scan a session's whole history.
create index if not exists events_uuid_idx on events (session_id, (payload->>'uuid'));

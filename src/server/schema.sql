-- schema.sql — applied idempotently on boot by ensureSchema() in db.ts.
-- No migration framework yet: every statement is `if not exists`, so re-running is a no-op.
-- `credential` (凭证A) carries no registry table on purpose — it is still a pure namespace key.

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

create index if not exists sessions_credential_idx on sessions (credential, last_activity desc);
create unique index if not exists sessions_ingress_token_idx on sessions (ingress_token);
create index if not exists environments_credential_idx on environments (credential);
create index if not exists events_session_idx on events (session_id, id);

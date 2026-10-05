\set ON_ERROR_STOP on
-- One native transaction applies the runtime policy after schema migrations.
-- Disable statement logging before interpolation of the two role secrets.
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
\getenv server_password SERVER_DB_PASSWORD
\getenv worker_password WORKER_DB_PASSWORD

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vid_server') THEN
    CREATE ROLE vid_server;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vid_worker') THEN
    CREATE ROLE vid_worker;
  END IF;
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, vid_server, vid_worker', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vid_server, vid_worker', current_database());
END
$$;

ALTER ROLE vid_server LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE vid_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('ALTER ROLE %I PASSWORD %L', 'vid_server', :'server_password') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'vid_worker', :'worker_password') \gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC, vid_server, vid_worker;
REVOKE ALL ON SCHEMA auth, product, execution FROM PUBLIC, vid_server, vid_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA auth, product, execution FROM PUBLIC, vid_server, vid_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth, product, execution FROM PUBLIC, vid_server, vid_worker;

-- Defaults belong to the actual object-creating role. Schema-local revocation
-- cannot cancel a global grant, so reset both before granting owned schemas.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON TABLES FROM PUBLIC, vid_server, vid_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON SEQUENCES FROM PUBLIC, vid_server, vid_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA auth, product, execution REVOKE ALL ON TABLES FROM PUBLIC, vid_server, vid_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA auth, product, execution REVOKE ALL ON SEQUENCES FROM PUBLIC, vid_server, vid_worker;

GRANT USAGE ON SCHEMA auth, product TO vid_server;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth, product TO vid_server;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA auth, product TO vid_server;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA auth, product GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vid_server;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA auth, product GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vid_server;

GRANT USAGE ON SCHEMA execution TO vid_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA execution TO vid_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA execution TO vid_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA execution GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vid_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA execution GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vid_worker;

--
-- PostgreSQL database dump
--

\restrict vid

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: execution; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA execution;


--
-- Name: product; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA product;


--
-- Name: run_status; Type: TYPE; Schema: execution; Owner: -
--

CREATE TYPE execution.run_status AS ENUM (
    'queued',
    'running',
    'completed',
    'cancelled',
    'failed'
);


--
-- Name: message_role; Type: TYPE; Schema: product; Owner: -
--

CREATE TYPE product.message_role AS ENUM (
    'user',
    'assistant'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: command_inbox; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.command_inbox (
    command_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    kind text NOT NULL,
    command jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT command_inbox_kind_check CHECK ((kind = ANY (ARRAY['start'::text, 'cancel'::text])))
);


--
-- Name: conversations; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.conversations (
    thread_id uuid NOT NULL,
    history jsonb DEFAULT '[]'::jsonb NOT NULL,
    active_run_id uuid,
    lease_owner text,
    lease_until timestamp with time zone,
    fence integer DEFAULT 0 NOT NULL,
    legacy_workspace_checkpoint jsonb,
    native_sandbox jsonb,
    sandbox_recovery_required boolean DEFAULT false NOT NULL,
    CONSTRAINT conversations_check CHECK ((((active_run_id IS NULL) AND (lease_owner IS NULL) AND (lease_until IS NULL)) OR ((active_run_id IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_until IS NOT NULL)))),
    CONSTRAINT conversations_fence_check CHECK ((fence >= 0)),
    CONSTRAINT native_sandbox_reference CHECK (((native_sandbox IS NULL) OR ((jsonb_typeof(native_sandbox) = 'object'::text) AND (native_sandbox ?& ARRAY['provider'::text, 'id'::text]) AND (jsonb_typeof((native_sandbox -> 'provider'::text)) = 'string'::text) AND (jsonb_typeof((native_sandbox -> 'id'::text)) = 'string'::text) AND (length((native_sandbox ->> 'provider'::text)) > 0) AND (length((native_sandbox ->> 'id'::text)) > 0))))
);


--
-- Name: event_outbox; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.event_outbox (
    event_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    ordinal integer NOT NULL,
    event jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT event_outbox_ordinal_check CHECK ((ordinal > 0))
);


--
-- Name: runs; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.runs (
    run_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    command_id uuid NOT NULL,
    message_id uuid NOT NULL,
    text text NOT NULL,
    assistant_message_id uuid,
    status execution.run_status DEFAULT 'queued'::execution.run_status NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assets; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.assets (
    asset_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    source text NOT NULL,
    name text NOT NULL,
    mime_type text NOT NULL,
    byte_length integer NOT NULL,
    sha256 text NOT NULL,
    object_key text NOT NULL,
    ready_at timestamp with time zone,
    run_id uuid,
    message_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assets_byte_length_check CHECK (((byte_length >= 0) AND (byte_length <= 16777216))),
    CONSTRAINT assets_check CHECK ((((source = 'upload'::text) AND (run_id IS NULL) AND (message_id IS NULL)) OR ((source = 'generated'::text) AND (run_id IS NOT NULL) AND (message_id IS NOT NULL) AND (ready_at IS NOT NULL)))),
    CONSTRAINT assets_check1 CHECK ((((source = 'upload'::text) AND ((object_key = ((('materials/'::text || (thread_id)::text) || '/'::text) || (asset_id)::text)) OR (object_key = ((('assets/uploads/'::text || (thread_id)::text) || '/'::text) || (asset_id)::text)))) OR ((source = 'generated'::text) AND (object_key ~ (((((('^(artifacts|assets/generated)/'::text || (thread_id)::text) || '/'::text) || (run_id)::text) || '/[1-9][0-9]*/'::text) || (asset_id)::text) || '$'::text))))),
    CONSTRAINT assets_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT assets_source_check CHECK ((source = ANY (ARRAY['upload'::text, 'generated'::text])))
);


--
-- Name: command_outbox; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.command_outbox (
    command_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    message_id uuid,
    command jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone
);


--
-- Name: execution_event_replay_cursor; Type: SEQUENCE; Schema: product; Owner: -
--

CREATE SEQUENCE product.execution_event_replay_cursor
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: execution_events; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.execution_events (
    event_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    payload jsonb NOT NULL,
    processed boolean DEFAULT false NOT NULL,
    replay_cursor bigint,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_events_check CHECK (((replay_cursor IS NULL) OR processed)),
    CONSTRAINT execution_events_ordinal_check CHECK ((ordinal > 0))
);


--
-- Name: message_assets; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.message_assets (
    thread_id uuid NOT NULL,
    message_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT message_assets_position_check CHECK ((("position" >= 0) AND ("position" < 32)))
);


--
-- Name: messages; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.messages (
    message_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    role product.message_role NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT messages_sources_check CHECK (((jsonb_typeof(sources) = 'array'::text) AND (jsonb_array_length(sources) <= 15)))
);


--
-- Name: threads; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.threads (
    thread_id uuid NOT NULL,
    legacy_owner_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_id text,
    title text DEFAULT 'New conversation'::text NOT NULL,
    creation_title text DEFAULT 'New conversation'::text NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: account account_provider_identity_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_provider_identity_key UNIQUE ("providerId", "accountId");


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: command_inbox command_inbox_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.command_inbox
    ADD CONSTRAINT command_inbox_pkey PRIMARY KEY (command_id);


--
-- Name: command_inbox command_inbox_run_identity; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.command_inbox
    ADD CONSTRAINT command_inbox_run_identity UNIQUE (thread_id, run_id, command_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (thread_id);


--
-- Name: event_outbox event_outbox_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.event_outbox
    ADD CONSTRAINT event_outbox_pkey PRIMARY KEY (event_id);


--
-- Name: event_outbox event_outbox_run_id_ordinal_key; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.event_outbox
    ADD CONSTRAINT event_outbox_run_id_ordinal_key UNIQUE (run_id, ordinal);


--
-- Name: runs runs_command_id_key; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.runs
    ADD CONSTRAINT runs_command_id_key UNIQUE (command_id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (run_id);


--
-- Name: runs runs_thread_identity; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.runs
    ADD CONSTRAINT runs_thread_identity UNIQUE (thread_id, run_id);


--
-- Name: assets assets_object_key_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.assets
    ADD CONSTRAINT assets_object_key_key UNIQUE (object_key);


--
-- Name: assets assets_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (asset_id);


--
-- Name: assets assets_thread_id_asset_id_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.assets
    ADD CONSTRAINT assets_thread_id_asset_id_key UNIQUE (thread_id, asset_id);


--
-- Name: command_outbox command_outbox_message_id_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.command_outbox
    ADD CONSTRAINT command_outbox_message_id_key UNIQUE (message_id);


--
-- Name: command_outbox command_outbox_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.command_outbox
    ADD CONSTRAINT command_outbox_pkey PRIMARY KEY (command_id);


--
-- Name: execution_events execution_events_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.execution_events
    ADD CONSTRAINT execution_events_pkey PRIMARY KEY (event_id);


--
-- Name: execution_events execution_events_replay_cursor_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.execution_events
    ADD CONSTRAINT execution_events_replay_cursor_key UNIQUE (replay_cursor);


--
-- Name: execution_events execution_events_run_id_ordinal_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.execution_events
    ADD CONSTRAINT execution_events_run_id_ordinal_key UNIQUE (run_id, ordinal);


--
-- Name: message_assets message_assets_message_id_position_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.message_assets
    ADD CONSTRAINT message_assets_message_id_position_key UNIQUE (message_id, "position");


--
-- Name: message_assets message_assets_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.message_assets
    ADD CONSTRAINT message_assets_pkey PRIMARY KEY (message_id, asset_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (message_id);


--
-- Name: messages messages_thread_identity; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages
    ADD CONSTRAINT messages_thread_identity UNIQUE (thread_id, message_id);


--
-- Name: threads thread_requires_identity; Type: CHECK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE product.threads
    ADD CONSTRAINT thread_requires_identity CHECK ((owner_id IS NOT NULL)) NOT VALID;


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (thread_id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "account_userId_idx" ON auth.account USING btree ("userId");


--
-- Name: session_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "session_userId_idx" ON auth.session USING btree ("userId");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX verification_identifier_idx ON auth.verification USING btree (identifier);


--
-- Name: command_inbox_run_kind_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX command_inbox_run_kind_idx ON execution.command_inbox USING btree (run_id, kind);


--
-- Name: runs_thread_status_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX runs_thread_status_idx ON execution.runs USING btree (thread_id, status, created_at);


--
-- Name: execution_events_run_message_idx; Type: INDEX; Schema: product; Owner: -
--

CREATE INDEX execution_events_run_message_idx ON product.execution_events USING btree (run_id, ordinal) WHERE (payload ? 'messageID'::text);


--
-- Name: execution_events_run_processed_idx; Type: INDEX; Schema: product; Owner: -
--

CREATE INDEX execution_events_run_processed_idx ON product.execution_events USING btree (run_id, ordinal DESC) WHERE processed;


--
-- Name: execution_events_run_terminal_idx; Type: INDEX; Schema: product; Owner: -
--

CREATE UNIQUE INDEX execution_events_run_terminal_idx ON product.execution_events USING btree (run_id) WHERE ((payload ->> 'kind'::text) = ANY (ARRAY['run-completed'::text, 'run-cancelled'::text, 'run-failed'::text]));


--
-- Name: execution_events_thread_replay_idx; Type: INDEX; Schema: product; Owner: -
--

CREATE INDEX execution_events_thread_replay_idx ON product.execution_events USING btree (thread_id, replay_cursor) WHERE (replay_cursor IS NOT NULL);


--
-- Name: messages_thread_created_at_idx; Type: INDEX; Schema: product; Owner: -
--

CREATE INDEX messages_thread_created_at_idx ON product.messages USING btree (thread_id, created_at);


--
-- Name: threads_owner_created; Type: INDEX; Schema: product; Owner: -
--

CREATE INDEX threads_owner_created ON product.threads USING btree (owner_id, created_at, thread_id);


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_active_run_identity; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.conversations
    ADD CONSTRAINT conversations_active_run_identity FOREIGN KEY (thread_id, active_run_id) REFERENCES execution.runs(thread_id, run_id);


--
-- Name: event_outbox event_outbox_run_identity; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.event_outbox
    ADD CONSTRAINT event_outbox_run_identity FOREIGN KEY (thread_id, run_id) REFERENCES execution.runs(thread_id, run_id);


--
-- Name: runs runs_command_identity; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.runs
    ADD CONSTRAINT runs_command_identity FOREIGN KEY (thread_id, run_id, command_id) REFERENCES execution.command_inbox(thread_id, run_id, command_id);


--
-- Name: runs runs_thread_id_fkey; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.runs
    ADD CONSTRAINT runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES execution.conversations(thread_id);


--
-- Name: assets assets_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.assets
    ADD CONSTRAINT assets_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id);


--
-- Name: assets assets_thread_id_message_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.assets
    ADD CONSTRAINT assets_thread_id_message_id_fkey FOREIGN KEY (thread_id, message_id) REFERENCES product.messages(thread_id, message_id);


--
-- Name: command_outbox command_outbox_message_identity; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.command_outbox
    ADD CONSTRAINT command_outbox_message_identity FOREIGN KEY (thread_id, message_id) REFERENCES product.messages(thread_id, message_id);


--
-- Name: command_outbox command_outbox_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.command_outbox
    ADD CONSTRAINT command_outbox_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id);


--
-- Name: execution_events execution_events_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.execution_events
    ADD CONSTRAINT execution_events_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id);


--
-- Name: message_assets message_assets_thread_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.message_assets
    ADD CONSTRAINT message_assets_thread_id_asset_id_fkey FOREIGN KEY (thread_id, asset_id) REFERENCES product.assets(thread_id, asset_id);


--
-- Name: message_assets message_assets_thread_id_message_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.message_assets
    ADD CONSTRAINT message_assets_thread_id_message_id_fkey FOREIGN KEY (thread_id, message_id) REFERENCES product.messages(thread_id, message_id);


--
-- Name: messages messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id);


--
-- Name: threads threads_owner_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.threads
    ADD CONSTRAINT threads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);


--
-- PostgreSQL database dump complete
--

\unrestrict vid

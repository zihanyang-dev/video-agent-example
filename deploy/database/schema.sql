--
-- PostgreSQL database dump
--

\restrict vid

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

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
-- Name: execution; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA execution;


--
-- Name: product; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA product;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: inputs; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.inputs (
    command_id text NOT NULL,
    thread_id text NOT NULL,
    ordinal bigint NOT NULL,
    message text NOT NULL,
    turn_id text,
    delivered boolean DEFAULT false NOT NULL
);


--
-- Name: inputs_ordinal_seq; Type: SEQUENCE; Schema: execution; Owner: -
--

CREATE SEQUENCE execution.inputs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inputs_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: execution; Owner: -
--

ALTER SEQUENCE execution.inputs_ordinal_seq OWNED BY execution.inputs.ordinal;


--
-- Name: outbox; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.outbox (
    seq bigint NOT NULL,
    event_id text NOT NULL,
    body jsonb NOT NULL,
    delivered boolean DEFAULT false NOT NULL
);


--
-- Name: outbox_seq_seq; Type: SEQUENCE; Schema: execution; Owner: -
--

CREATE SEQUENCE execution.outbox_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbox_seq_seq; Type: SEQUENCE OWNED BY; Schema: execution; Owner: -
--

ALTER SEQUENCE execution.outbox_seq_seq OWNED BY execution.outbox.seq;


--
-- Name: runs; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.runs (
    turn_id text NOT NULL,
    thread_id text NOT NULL,
    owner text NOT NULL,
    state text NOT NULL,
    accepting boolean DEFAULT true NOT NULL,
    cancelled boolean DEFAULT false NOT NULL,
    lease_until timestamp with time zone NOT NULL,
    CONSTRAINT runs_state_check CHECK ((state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text])))
);


--
-- Name: sessions; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.sessions (
    thread_id text NOT NULL,
    entries jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace text,
    active_turn_id text,
    event_sequence bigint DEFAULT 0 NOT NULL
);


--
-- Name: stops; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.stops (
    command_id text NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.events (
    thread_id text NOT NULL,
    cursor bigint NOT NULL,
    body jsonb NOT NULL
);


--
-- Name: execution_receipts; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.execution_receipts (
    event_id text NOT NULL,
    thread_id text NOT NULL,
    sequence bigint NOT NULL
);


--
-- Name: execution_views; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.execution_views (
    thread_id text NOT NULL,
    sequence bigint DEFAULT 0 NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.messages (
    thread_id text NOT NULL,
    message_id text NOT NULL,
    seq bigint NOT NULL,
    body jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages_seq_seq; Type: SEQUENCE; Schema: product; Owner: -
--

CREATE SEQUENCE product.messages_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_seq_seq; Type: SEQUENCE OWNED BY; Schema: product; Owner: -
--

ALTER SEQUENCE product.messages_seq_seq OWNED BY product.messages.seq;


--
-- Name: outbox; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.outbox (
    seq bigint NOT NULL,
    command_id text NOT NULL,
    body jsonb NOT NULL,
    delivered boolean DEFAULT false NOT NULL
);


--
-- Name: outbox_seq_seq; Type: SEQUENCE; Schema: product; Owner: -
--

CREATE SEQUENCE product.outbox_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbox_seq_seq; Type: SEQUENCE OWNED BY; Schema: product; Owner: -
--

ALTER SEQUENCE product.outbox_seq_seq OWNED BY product.outbox.seq;


--
-- Name: threads; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.threads (
    thread_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    active_turn_id text
);


--
-- Name: inputs ordinal; Type: DEFAULT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.inputs ALTER COLUMN ordinal SET DEFAULT nextval('execution.inputs_ordinal_seq'::regclass);


--
-- Name: outbox seq; Type: DEFAULT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.outbox ALTER COLUMN seq SET DEFAULT nextval('execution.outbox_seq_seq'::regclass);


--
-- Name: messages seq; Type: DEFAULT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages ALTER COLUMN seq SET DEFAULT nextval('product.messages_seq_seq'::regclass);


--
-- Name: outbox seq; Type: DEFAULT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.outbox ALTER COLUMN seq SET DEFAULT nextval('product.outbox_seq_seq'::regclass);


--
-- Name: inputs inputs_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.inputs
    ADD CONSTRAINT inputs_pkey PRIMARY KEY (command_id);


--
-- Name: outbox outbox_event_id_key; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.outbox
    ADD CONSTRAINT outbox_event_id_key UNIQUE (event_id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (seq);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (turn_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (thread_id);


--
-- Name: stops stops_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.stops
    ADD CONSTRAINT stops_pkey PRIMARY KEY (command_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (thread_id, cursor);


--
-- Name: execution_receipts execution_receipts_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.execution_receipts
    ADD CONSTRAINT execution_receipts_pkey PRIMARY KEY (event_id);


--
-- Name: execution_receipts execution_receipts_thread_id_sequence_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.execution_receipts
    ADD CONSTRAINT execution_receipts_thread_id_sequence_key UNIQUE (thread_id, sequence);


--
-- Name: execution_views execution_views_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.execution_views
    ADD CONSTRAINT execution_views_pkey PRIMARY KEY (thread_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (thread_id, message_id);


--
-- Name: outbox outbox_command_id_key; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.outbox
    ADD CONSTRAINT outbox_command_id_key UNIQUE (command_id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (seq);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (thread_id);


--
-- Name: one_running_turn_per_thread; Type: INDEX; Schema: execution; Owner: -
--

CREATE UNIQUE INDEX one_running_turn_per_thread ON execution.runs USING btree (thread_id) WHERE (state = 'running'::text);


--
-- Name: pending_inputs; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX pending_inputs ON execution.inputs USING btree (thread_id, ordinal) WHERE (turn_id IS NULL);


--
-- Name: messages_by_thread; Type: INDEX; Schema: product; Owner: -
--

CREATE INDEX messages_by_thread ON product.messages USING btree (thread_id, seq);


--
-- Name: inputs inputs_thread_id_fkey; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.inputs
    ADD CONSTRAINT inputs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES execution.sessions(thread_id);


--
-- Name: runs runs_thread_id_fkey; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.runs
    ADD CONSTRAINT runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES execution.sessions(thread_id);


--
-- Name: events events_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.events
    ADD CONSTRAINT events_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id) ON DELETE CASCADE;


--
-- Name: messages messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id) ON DELETE CASCADE;


--
-- Name: SCHEMA execution; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA execution TO vid_execution;


--
-- Name: SCHEMA product; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA product TO vid_product;


--
-- Name: TABLE inputs; Type: ACL; Schema: execution; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE execution.inputs TO vid_execution;


--
-- Name: SEQUENCE inputs_ordinal_seq; Type: ACL; Schema: execution; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE execution.inputs_ordinal_seq TO vid_execution;


--
-- Name: TABLE outbox; Type: ACL; Schema: execution; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE execution.outbox TO vid_execution;


--
-- Name: SEQUENCE outbox_seq_seq; Type: ACL; Schema: execution; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE execution.outbox_seq_seq TO vid_execution;


--
-- Name: TABLE runs; Type: ACL; Schema: execution; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE execution.runs TO vid_execution;


--
-- Name: TABLE sessions; Type: ACL; Schema: execution; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE execution.sessions TO vid_execution;


--
-- Name: TABLE stops; Type: ACL; Schema: execution; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE execution.stops TO vid_execution;


--
-- Name: TABLE events; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE product.events TO vid_product;


--
-- Name: TABLE execution_receipts; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE product.execution_receipts TO vid_product;


--
-- Name: TABLE execution_views; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE product.execution_views TO vid_product;


--
-- Name: TABLE messages; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE product.messages TO vid_product;


--
-- Name: SEQUENCE messages_seq_seq; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE product.messages_seq_seq TO vid_product;


--
-- Name: TABLE outbox; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE product.outbox TO vid_product;


--
-- Name: SEQUENCE outbox_seq_seq; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE product.outbox_seq_seq TO vid_product;


--
-- Name: TABLE threads; Type: ACL; Schema: product; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE product.threads TO vid_product;


--
-- PostgreSQL database dump complete
--

\unrestrict vid


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
-- Name: product; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA product;


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
-- Name: messages; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.messages (
    message_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    role product.message_role NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: threads; Type: TABLE; Schema: product; Owner: -
--

CREATE TABLE product.threads (
    thread_id uuid NOT NULL,
    owner_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


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
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (message_id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (thread_id);


--
-- Name: messages_thread_created_at_idx; Type: INDEX; Schema: product; Owner: -
--

CREATE INDEX messages_thread_created_at_idx ON product.messages USING btree (thread_id, created_at);


--
-- Name: command_outbox command_outbox_message_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.command_outbox
    ADD CONSTRAINT command_outbox_message_id_fkey FOREIGN KEY (message_id) REFERENCES product.messages(message_id);


--
-- Name: command_outbox command_outbox_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.command_outbox
    ADD CONSTRAINT command_outbox_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id);


--
-- Name: messages messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: product; Owner: -
--

ALTER TABLE ONLY product.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES product.threads(thread_id);


--
-- PostgreSQL database dump complete
--

\unrestrict vid

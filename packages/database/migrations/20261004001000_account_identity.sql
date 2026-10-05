-- migrate:up
-- Better Auth's generated core DDL omits this invariant. Concurrent OAuth
-- callbacks must not attach one provider identity to two product users.
-- Existing conflicting identities stop migration; never silently pick a user.
ALTER TABLE auth.account
  ADD CONSTRAINT account_provider_identity_key
  UNIQUE ("providerId", "accountId");

-- migrate:down
ALTER TABLE auth.account DROP CONSTRAINT account_provider_identity_key;

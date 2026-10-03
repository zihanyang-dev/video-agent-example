FROM ghcr.io/amacneil/dbmate:2.36.0
WORKDIR /app
COPY packages/database/migrations ./migrations
ENTRYPOINT ["dbmate", "--migrations-dir", "/app/migrations", "--no-dump-schema", "--wait"]
CMD ["migrate"]

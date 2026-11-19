#!/bin/bash
# Corre apenas na criação inicial de um primário (diretório de dados vazio).
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "create role replicator with replication login password '${REPL_PASSWORD}'"
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"

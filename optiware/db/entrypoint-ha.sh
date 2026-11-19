#!/bin/bash
# Entrypoint de um nó PostgreSQL com streaming replication.
#  - dados vazios + nenhum primário vivo + INITIAL_ROLE=primary  -> cria um primário novo
#  - dados vazios + primário vivo (ou INITIAL_ROLE=standby)       -> clona o primário (pg_basebackup) e arranca como standby
#  - dados existentes, nó NÃO é standby, mas existe outro primário vivo -> este nó ficou desatualizado após um failover:
#    descarta os dados e volta a clonar (re-junção automática como standby)
set -e
export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export PGPASSWORD="${POSTGRES_PASSWORD}"
export PGCONNECT_TIMEOUT=2

find_primary() {
  for h in ${PEERS}; do
    r=$(psql -h "$h" -U postgres -d postgres -Atc "select pg_is_in_recovery()" 2>/dev/null || true)
    if [ "$r" = "f" ]; then echo "$h"; return 0; fi
  done
  return 1
}

clone_from() {
  echo "[ha] a clonar o primário $1 ..."
  mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
  PGPASSWORD="${REPL_PASSWORD}" gosu postgres pg_basebackup -h "$1" -U replicator -D "$PGDATA" -R -X stream -c fast   # -c fast: não espera pelo próximo checkpoint (re-junção em segundos)
}

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  P=$(find_primary || true)
  if [ -z "$P" ] && [ "${INITIAL_ROLE}" = "standby" ]; then
    echo "[ha] standby inicial: a aguardar um primário ..."
    for i in $(seq 1 120); do P=$(find_primary || true); [ -n "$P" ] && break; sleep 1; done
  fi
  if [ -n "$P" ]; then clone_from "$P"; else echo "[ha] a criar primário novo"; fi
elif [ ! -f "$PGDATA/standby.signal" ]; then
  P=$(find_primary || true)
  if [ -n "$P" ]; then
    echo "[ha] existe outro primário ($P): este nó está desatualizado -> re-junção como standby"
    find "$PGDATA" -mindepth 1 -delete
    clone_from "$P"
  fi
fi

exec docker-entrypoint.sh postgres -c listen_addresses='*' -c wal_level=replica -c max_wal_senders=10 -c wal_keep_size=512MB -c hot_standby=on

#!/bin/bash
# Deteção de falha do primário e promoção automática do standby (pg_promote).
# Se o próprio watchdog falhar, o serviço NÃO para: apenas deixa de haver promoção automática.
export PGPASSWORD="${POSTGRES_PASSWORD}" PGCONNECT_TIMEOUT=2
read -ra HOSTS <<< "${HOSTS}"
THRESHOLD=${THRESHOLD:-3}
fails=0

state() {
  r=$(psql -h "$1" -U postgres -d postgres -Atc "select pg_is_in_recovery()" 2>/dev/null)
  case "$r" in f) echo primary ;; t) echo standby ;; *) echo down ;; esac
}

echo "[watchdog] a monitorizar: ${HOSTS[*]}"
while true; do
  prim=(); stby=()
  for h in "${HOSTS[@]}"; do
    s=$(state "$h")
    [ "$s" = primary ] && prim+=("$h")
    [ "$s" = standby ] && stby+=("$h")
  done
  if [ ${#prim[@]} -ge 1 ]; then
    fails=0
    [ ${#prim[@]} -gt 1 ] && echo "[watchdog] ALERTA: mais do que um primário (${prim[*]})"
  elif [ ${#stby[@]} -ge 1 ]; then
    fails=$((fails+1))
    echo "[watchdog] primário indisponível ($fails/$THRESHOLD)"
    if [ $fails -ge $THRESHOLD ]; then
      echo "[watchdog] a promover ${stby[0]} a primário"
      psql -h "${stby[0]}" -U postgres -d postgres -Atc "select pg_promote(true, 30)"
      fails=0
    fi
  else
    fails=0
    echo "[watchdog] nenhum nó disponível"
  fi
  sleep 2
done

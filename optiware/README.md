# OptiWare — Sistema Distribuído e Inteligente de Gestão de Armazéns

Protótipo da parte distribuída (Docker + PostgreSQL + RabbitMQ), do módulo de IA (CSP) e de uma interface web simples.

## Arranque

```bash
docker compose down -v              # só se já tinhas uma versão anterior a correr (a arquitetura mudou)
docker compose up -d --build        # 21 containers; 2-3 min na primeira vez (precisa de ~4 GB de RAM livre)
docker compose ps                   # tudo "healthy"
```

| Serviço | URL |
|---|---|
| **Interface web** (empresa + armazéns + painel de infraestrutura) | http://localhost:8000 |
| Central | http://localhost:8080 |
| Armazém wh1 | http://localhost:9001 |
| Armazém wh2 | http://localhost:9002 |
| RabbitMQ (guest/guest), consola do cluster | http://localhost:15672 |

Utilizadores (desenvolvimento): `admin/admin123`, `operador/operador123`, `consulta/consulta123`.

## Interface web

`http://localhost:8000` — um único ficheiro (`ui/index.html`, sem build), servido pelos dois nginx do gateway.

- **Empresa:** armazéns registados, stock de todos os armazéns (com indicação "ao vivo" / "último estado conhecido") e transferências.
- **Um separador por armazém:** stock por prateleira, receção de mercadoria com proposta do CSP, encomendas, prateleiras e movimentos.
- **Infraestrutura, agora** (coluna da direita): uma caixa por contentor (nginx, APIs, nós de BD com o papel primária/standby, nós RabbitMQ)
  e um registo de eventos. É o que se mostra na demonstração: pára-se um contentor e vê-se a reação.

O guião completo da demonstração, passo a passo, está em [`docs/GUIAO_DEMONSTRACAO.md`](docs/GUIAO_DEMONSTRACAO.md).

## Exemplo rápido (linha de comandos)

```bash
# 1. login no central
TOKEN=$(curl -s localhost:8080/auth/login -H 'content-type: application/json' \
  -d '{"username":"operador","password":"operador123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

# 2. armazéns registados e visão global de stock
curl -s localhost:8080/warehouses -H "Authorization: Bearer $TOKEN"
curl -s localhost:8080/stock -H "Authorization: Bearer $TOKEN"

# 3. transferência wh1 -> wh2 (assíncrona, via RabbitMQ)
curl -s localhost:8080/transfers -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"from":"wh1","to":"wh2","sku":"P-100","qty":50}'

# 4. IA/CSP: propor posições e depois o operador confirma
curl -s localhost:9002/allocate -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"P-200","qty":10},{"sku":"P-100","qty":500}]}'
curl -s localhost:9002/putaway -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"rececao-1","assignments":[{"sku":"P-200","qty":10,"shelfId":3}]}'

# 5. encomenda (reserva) e expedição no armazém
curl -s localhost:9001/orders -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"enc-1","sku":"P-100","qty":20}'
curl -s -X POST localhost:9001/orders/enc-1/fulfill -H "Authorization: Bearer $TOKEN"
```

(No Windows PowerShell usar `Invoke-RestMethod`, ou correr os comandos no WSL/Git Bash.)

## Demonstração de tolerância a faltas

A forma mais simples é seguir o [guião](docs/GUIAO_DEMONSTRACAO.md) com a interface aberta. Em alternativa, pela linha de comandos, mostrar em paralelo:

```bash
watch -n1 'curl -s localhost:8080/stats; echo; docker compose ps --format "table {{.Name}}\t{{.Status}}"'
docker compose logs -f central-watchdog
```

### Demonstração de falhas (uma de cada vez; `start` para recuperar)

```powershell
# 1. Entrada redundante: dois nginx no mesmo endereço (o cabeçalho X-Gateway mostra qual respondeu)
1..8 | % { (Invoke-WebRequest localhost:9001/health -UseBasicParsing).Headers['X-Gateway'] }
docker compose stop gateway-a          # o endereço continua a funcionar, servido pelo gateway-b
docker compose start gateway-a

# 2. API de um armazém: o cliente continua no 9001 (X-Served-By alterna wh1-api-a / wh1-api-b)
1..6 | % { (Invoke-WebRequest localhost:9001/health -UseBasicParsing).Headers['X-Served-By'] }
docker compose stop wh1-api-a ; docker compose start wh1-api-a

# 3. BD de um armazém: o watchdog promove o standby
docker compose stop wh1-db1
docker compose logs --tail 5 wh1-watchdog         # "a promover wh1-db2 a primário"
docker compose start wh1-db1                       # volta sozinho como standby

# 4. Um nó do cluster RabbitMQ (as filas são quorum queues replicadas nos 3 nós)
docker compose stop rabbitmq1                      # transferências continuam via rabbitmq2/3
docker compose start rabbitmq1
docker compose exec rabbitmq2 rabbitmq-diagnostics cluster_status

# 5. BD central e API central
docker compose stop central-db1 ; docker compose logs --tail 5 central-watchdog ; docker compose start central-db1
docker compose stop central-api1 ; docker compose start central-api1
```

Para cada falha: **o que falhou, como foi detetado, o que manteve o serviço, se houve perda de dados e como recuperou** (ver `docs/MODELO_DE_FALTAS.md`).

## Estrutura

```
docker-compose.yml        orquestração (redes: frontend, central-net, wh1-net, wh2-net)
app/src/central.js        serviços centrais (auth, registo, visão global, coordenação de transferências)
app/src/warehouse.js      serviço de um armazém (stock, encomendas, prateleiras, CSP, consumo de comandos)
app/src/csp.js            IA: Problema de Satisfação de Restrições
app/src/common.js         ligação HA à BD, JWT, auditoria, RabbitMQ com reconexão, outbox
db/                       imagem PostgreSQL com replicação + watchdog de failover
ui/index.html             interface web (um ficheiro; tipos de letra em ui/fonts)
lb/gateway.conf           nginx: endereços estáveis 8000 / 8080 / 9001 / 9002 (configuração comum aos 2 nginx)
lb/gateway-a.conf, -b     identidade de cada nginx (cabeçalho X-Gateway)
rabbitmq/cluster.conf     cluster RabbitMQ de 3 nós
docs/                     arquitetura, modelo de faltas, base de dados, guião da demonstração
```

## Adicionar um armazém

Copiar o bloco do wh2 no `docker-compose.yml` (BD primário+standby, watchdog, 2 APIs; novo id, volumes, rede, IPs fixos) e, no `lb/gateway.conf`,
acrescentar o `upstream`, a porta, o `location /api/wh3/` e as duas instâncias (no `map $node` e no `topology.json`); acrescentar a porta no serviço `gateway`.
O armazém regista-se sozinho no central através de heartbeat — não há lista fixa de armazéns — e aparece como novo separador na interface.

## Fora do âmbito deste protótipo (a fazer pelas outras UCs)

- **Segurança:** HTTPS (TLS no nginx), TLS/autenticação no RabbitMQ e PostgreSQL, gestão de segredos (as credenciais do
  compose são de desenvolvimento), rotação de chaves JWT.
- **Frontend definitivo** (por exemplo em React): a interface atual é propositadamente mínima e serve para operar e demonstrar o protótipo.
- **Engenharia de Software:** requisitos, UML e a estrutura de pastas da secção 08 do briefing.

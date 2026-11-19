# Modelo de Faltas — OptiWare

## 1. Componentes críticos
Interface web e gateway (2 nginx), serviço central (2 APIs + BD primário/standby), cada armazém (2 APIs + BD primário/standby), cluster RabbitMQ (3 nós), watchdogs e a rede entre containers.

## 2. Tipos de falha considerados
- **Crash-stop / crash-recovery** de containers (o processo termina e é depois reiniciado).
- **Indisponibilidade de comunicação** (container inalcançável, partição de rede).
- **Lentidão** que causa *timeouts*.
- **Não considerados:** falhas bizantinas, corrupção silenciosa de disco, perda total do host Docker.

## 3. Falhas simultâneas suportadas

| Componente | Réplicas | Toleradas |
|---|---|---|
| Gateway (nginx) | 2 | 1 |
| API central | 2 | 1 |
| API de cada armazém | 2 | 1 (por armazém, no mesmo endereço 9001 / 9002) |
| BD central | 2 (primário + standby) | 1 |
| BD de cada armazém | 2 (primário + standby) | 1 |
| RabbitMQ | 3 (quorum queues) | 1 (com 2 nós vivos há maioria) |
| Armazéns entre si | independentes | qualquer subconjunto; cada um afeta só as suas funções |

## 4. Garantias oferecidas

| Funcionalidade | Garantia |
|---|---|
| Endereço do cliente | Mantém-se (8080 / 9001 / 9002) perante a falha de **uma** instância de qualquer camada |
| Operações locais de um armazém | Disponíveis com o **central e o broker em baixo** e com **qualquer outro armazém em baixo** |
| Sem movimentos duplicados | Garantido por ids de idempotência, inbox e transições condicionais |
| Sem overselling | Garantido por transação + `CHECK (reserved <= qty)` |
| Pedido de transferência aceite (HTTP 202) | Não se perde: fica na outbox da BD central e o broker replica as mensagens em maioria |
| Transferência com destino/broker indisponíveis | Fica pendente (`REQUESTED`/`IN_TRANSIT`) e conclui sozinha |
| Visão global | Pode estar **desatualizada** (`stale`, com data) quando um armazém não responde |
| Escritas após falha do primário de uma BD | Retomam em ~10–20 s (deteção + promoção + redescoberta) |
| Informação que pode perder-se | Só as últimas transações do primário de uma BD ainda não replicadas (replicação assíncrona); mensagens confirmadas pelo broker não se perdem |
| Consistência | Forte **dentro** de cada armazém (ACID); **eventual** entre armazéns e central (mensagens); leituras globais com consistência eventual |

## 5. Cenários de demonstração

| # | Componente que falha | Como é detetada | Mecanismo que mantém o serviço | Impacto nos utilizadores | Perda de dados | Recuperação / redundância |
|---|---|---|---|---|---|---|
| 1 | **Um nginx** (`gateway-a`) | o socket desse nginx desaparece | `gateway-b` serve o mesmo endereço (`reuseport`) | nenhum (ligações em curso nesse nginx podem repetir-se) | não | `restart: always`; volta a partilhar a carga |
| 2 | **Uma API** de armazém (`wh1-api-a`) | `max_fails` no gateway | gateway reencaminha para `wh1-api-b` **no mesmo endereço 9001** | nenhum visível | não | reinício; volta ao pool |
| 3 | **Uma API central** (`central-api1`) | idem | gateway → `central-api2` (8080) | nenhum visível | não | reinício; volta ao pool |
| 4 | **Primário da BD de um armazém** (`wh1-db1`) | watchdog do armazém: 3 falhas consecutivas; API: erro de ligação | `pg_promote()` de `wh1-db2`; as APIs redescobrem o primário | escritas em wh1 indisponíveis ~10–15 s; wh2 e central não são afetados | só transações não replicadas (janela mínima) | nó antigo reinicia, deteta o novo primário e é re-clonado como standby |
| 5 | **Primário da BD central** (`central-db1`) | watchdog central | idem para `central-db2` | escritas centrais indisponíveis ~10–20 s | idem | idem |
| 6 | **Um nó RabbitMQ** (`rabbitmq1`) | o cliente perde a ligação; o cluster elege novo líder das filas | clientes ligam-se a `rabbitmq2/3`; quorum queues mantêm maioria (2 de 3) | transferências não são interrompidas (poucos segundos de reconexão) | não (mensagens confirmadas estão em maioria) | nó regressa e ressincroniza as filas |
| 7 | **Dois nós RabbitMQ** (limite) | sem maioria as filas ficam indisponíveis | outbox acumula; armazéns operam localmente | transferências ficam pendentes | não | ao voltar a maioria, a outbox descarrega e as transferências concluem |
| 8 | **Ambas as APIs de wh1** | heartbeat expira (20 s) | wh2 e central continuam; visão global usa snapshot `stale` de wh1 | só wh1 indisponível | não | reinício automático |
| 9 | Serviços centrais (ambas as APIs) | cliente recebe erro | armazéns operam sozinhos (JWT local) | sem transferências nem visão global | não | heartbeats voltam a registar os armazéns |
| 10 | Destino de uma transferência cai a meio | mensagem sem consumidor | mensagem persistida na fila do destino; estado `IN_TRANSIT` | transferência demora | não | destino volta, consome, `COMPLETED` |
| 11 | Reenvio de pedidos (cliente/rede) | ids repetidos | idempotência + inbox | nenhum | não | — |

Todos estes cenários podem ser provocados e observados na interface (`http://localhost:8000`), seguindo `docs/GUIAO_DEMONSTRACAO.md`.

## 6. Como se restabelece a redundância
- Gateway, APIs: política `restart` do Docker e *healthchecks*.
- BDs: o nó que regressa já não é standby e deteta um primário vivo ⇒ apaga os dados locais e faz `pg_basebackup`, voltando como standby (`db/entrypoint-ha.sh`).
- RabbitMQ: o nó que regressa volta ao cluster e ressincroniza as filas quorum (Raft).

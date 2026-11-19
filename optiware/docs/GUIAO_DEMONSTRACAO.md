# Guião da demonstração — mostrar que o OptiWare é um sistema distribuído

Duração: 10 a 12 minutos. Precisas de duas janelas lado a lado:

- **Browser** em `http://localhost:8000` (a interface). À direita está o painel "Infraestrutura, agora":
  cada caixa é um contentor e muda de cor sozinha quando o paras.
- **Terminal** na pasta do projeto, para os comandos `docker compose stop …` / `start …`.

Os tempos indicados foram medidos num banco de testes sem Docker (mesmos scripts, mesma topologia de rede).
No teu PC podem variar alguns segundos: ensaia uma vez antes da apresentação.

## Antes de começar

```bash
docker compose down -v            # estado limpo (apaga os dados de ensaios anteriores)
docker compose up -d --build      # 21 contentores; 2 a 3 minutos
docker compose ps                 # tudo "healthy" / "running"
```

Abre `http://localhost:8000`, entra como `operador` / `operador123` e confirma que no painel da direita
está tudo verde, com uma BD "primária" (amarelo) e uma "standby" em cada serviço.

Duas regras para os cenários de falha:

1. **Uma falha de cada vez.** Faz `start` e espera que a caixa volte a verde antes do cenário seguinte.
2. **Pára o nó que o painel mostra como ativo.** Depois de um failover a BD primária passa a ser a `…-db2`;
   se parares a `…-db1` nessa altura estás a parar a standby e não acontece nada de visível.

---

## Parte A — É distribuído (sem falhas, 3 minutos)

| # | O que fazes | O que se vê | O que dizes |
|---|---|---|---|
| A1 | `docker compose ps` no terminal e apontas para o painel | 21 contentores; no painel: Entrada, Empresa, Armazém Lisboa, Armazém Setúbal, Mensagens | "Há quatro serviços independentes. Cada um tem duas instâncias e a sua própria base de dados com réplica. Nada é partilhado entre armazéns." |
| A2 | Separador **Armazém Lisboa**, depois **Armazém Setúbal** | Lisboa tem stock; Setúbal está vazio | "Os dados de cada armazém vivem na BD desse armazém. A empresa não tem cópia de trabalho do stock." |
| A3 | Separador **Empresa** → *Transferir entre armazéns*: Lisboa → Setúbal, `P-100`, 50 → **Pedir transferência** | Na lista, o estado passa de *Pedida* a *Em trânsito* e a *Concluída* em 2 a 3 s; o stock muda nas duas colunas | "A empresa só coordena. O pedido segue por mensagens (RabbitMQ): Lisboa retira, Setúbal recebe. Os dois armazéns nunca falam diretamente." |
| A4 | Ficas no separador **Empresa** | Tabela *Stock em todos os armazéns*, com "ao vivo" em cada armazém | "A visão global é uma agregação feita no momento: a empresa pergunta a cada armazém." |
| A5 | Apontas para "última resposta" no painel, por cima de cada serviço | O nome alterna entre as duas instâncias | "O cliente usa sempre o mesmo endereço. Quem responde vai alternando entre as duas instâncias." |
| A6 | **Armazém Setúbal** → *Receber mercadoria*: `P-200`, 10 → **Propor prateleira** → **Confirmar arrumação** | Proposta de prateleira (B1 ou C1, as únicas zonas permitidas a químicos) | "A IA é um CSP: categoria, zona, peso e volume. O sistema propõe, o operador confirma." |

---

## Parte B — Tolera faltas (6 minutos)

Em cada cenário: corres o comando, apontas para o painel e para o registo de eventos, e mostras que
a aplicação continua a responder (muda de separador ou cria uma encomenda).
A tabela completa com os 7 pontos pedidos no enunciado está em `MODELO_DE_FALTAS.md`, secção 5.

### B1. Cai um nginx da entrada

```bash
docker compose stop gateway-a
```

- **Vê-se:** `gateway-a` fica vermelho; a página continua a funcionar no mesmo endereço.
- **Dizes:** "A entrada são dois nginx no mesmo endereço. Sem um, o outro recebe todas as ligações novas."
- **Medido:** 43 pedidos seguidos durante a falha, 0 falhados.
- **Recuperar:** `docker compose start gateway-a`

### B2. Cai uma instância de um armazém

```bash
docker compose stop wh1-api-a
```

- **Vê-se:** `wh1-api-a` vermelho; evento "wh1-api-b continua a servir o Armazém Lisboa no mesmo endereço".
- **Faz:** no separador Armazém Lisboa, cria uma encomenda (`P-100`, 5 → **Reservar stock**). Funciona.
- **Dizes:** "O nginx deteta a instância morta (`max_fails`) e manda tudo para a outra. As instâncias não têm estado: o estado está na BD."
- **Medido:** 0 pedidos falhados; o pior pedido demorou 1 s (o tempo de o nginx desistir da instância morta).
- **Recuperar:** `docker compose start wh1-api-a`

(Igual para a empresa: `docker compose stop central-api1`.)

### B3. Cai a base de dados primária de um armazém — o cenário mais importante

Fica no separador **Armazém Lisboa** e olha para a linha BD do Armazém Lisboa no painel.

```bash
docker compose stop wh1-db1        # ou a que estiver marcada como "primária"
```

Logo a seguir, cria uma encomenda (`P-100`, 5 → **Reservar stock**). O botão fica à espera.

- **Vê-se, por ordem:**
  1. `wh1-db1` vermelho, "sem resposta";
  2. 10 a 15 s depois, `wh1-db2` passa de "standby" a "primária" (amarelo);
  3. a encomenda que estava à espera é gravada, sem erro;
  4. Armazém Setúbal e Empresa nunca mudam: a falha fica contida no armazém.
- **Dizes:** "O watchdog deteta 3 falhas seguidas e promove a standby. As APIs redescobrem a primária e repetem a operação: o utilizador espera, não perde o pedido."
- **Medido:** escrita pedida no instante da falha concluída ao fim de 12 a 15 s; 0 pedidos falhados; os outros serviços com latência normal (< 30 ms).

Agora repõe a redundância:

```bash
docker compose start wh1-db1
docker compose logs --tail 5 wh1-db1      # "existe outro primário … re-junção como standby"
```

- **Vê-se:** `wh1-db1` volta como "standby" em poucos segundos; evento "A BD do Armazém Lisboa tem outra vez réplica".
- **Dizes:** "O nó antigo percebe que já há outra primária, deita fora os dados dele e clona a nova. A redundância volta sozinha."
- **Se perguntarem por perda de dados:** a replicação é assíncrona, por isso podem perder-se as transações dos últimos milissegundos antes da falha. É uma limitação assumida no modelo de faltas.

(Igual para a empresa: `docker compose stop central-db1`, com um pedido de transferência feito logo a seguir.)

### B4. Cai um nó do serviço de mensagens

No painel, vê a que nó as APIs estão ligadas ("mensagens via rabbitmq1") e pára esse.

```bash
docker compose stop rabbitmq1
```

Pede uma transferência no separador Empresa.

- **Vê-se:** `rabbitmq1` vermelho; as APIs passam a "mensagens via rabbitmq2"; a transferência fica *Concluída*.
- **Dizes:** "As filas são quorum queues replicadas nos 3 nós. Com 2 de 3 há maioria, por isso nada pára e nenhuma mensagem confirmada se perde."
- **Medido:** transferência concluída em 2 s com um nó em baixo.
- **Não faças `start` ainda** se quiseres mostrar o B5.

### B5. Caem dois nós de mensagens (o limite do sistema)

```bash
docker compose stop rabbitmq2
```

Pede outra transferência. Depois cria uma encomenda num armazém.

- **Vê-se:** os três nós ficam vermelhos (o que sobra pára de propósito, por não ter maioria);
  a transferência fica em *Pedida*; no painel, por baixo da Empresa, aparece a amarelo
  "1 mensagem guardada à espera de envio"; a encomenda local funciona normalmente.
- **Dizes:** "Este é o limite que definimos: sem maioria não há mensagens. Mas o pedido não se perde, fica gravado na BD da empresa (outbox), e os armazéns continuam a trabalhar sozinhos."

```bash
docker compose start rabbitmq2
docker compose start rabbitmq1
```

- **Vê-se:** cerca de 40 s depois de voltar a maioria, a transferência passa a *Concluída* sem ninguém fazer nada e o contador volta a "sem mensagens por enviar".

### B6. Um armazém inteiro fica incontactável

```bash
docker compose stop wh2-api-a wh2-api-b
```

No separador **Empresa**, pede uma transferência Lisboa → Setúbal.

- **Vê-se:** a transferência fica *Em trânsito* (Lisboa já enviou; Setúbal ainda não recebeu);
  na tabela Armazéns, Setúbal mostra "último estado conhecido, hh:mm:ss" e, ao fim de 20 s, "sem sinal";
  o separador Armazém Lisboa funciona como sempre.
- **Dizes:** "A falha de um armazém só afeta esse armazém. A visão global não mente: diz que os dados de Setúbal são de há X segundos."

```bash
docker compose start wh2-api-a wh2-api-b
```

- **Vê-se:** a transferência conclui em 1 a 2 s: a mensagem estava guardada na fila de Setúbal.

### B7. A empresa (serviços centrais) fica em baixo

```bash
docker compose stop central-api1 central-api2
```

- **Vê-se:** o separador Empresa mostra "Os serviços centrais não respondem"; nos separadores dos armazéns continua tudo a funcionar.
- **Faz:** cria e expede uma encomenda num armazém.
- **Dizes:** "Os armazéns não dependem da empresa para trabalhar: validam o token localmente. Só não há transferências novas, visão global nem novos logins."
- **Recuperar:** `docker compose start central-api1 central-api2`

---

## Parte C — Concorrência e pedidos repetidos (1 minuto)

1. Num armazém, em *Nova encomenda*, escolhe um produto e uma quantidade que não caiba 20 vezes no stock
   (por exemplo `P-300`, 3) e clica em **Testar: enviar 20 pedidos iguais ao mesmo tempo**.
   - **Vê-se** (com 20 unidades em stock): "20 pedidos em simultâneo de 3 × P-300: 6 aceites, 14 recusados por falta de stock."
   - **Dizes:** "Os 20 pedidos entram pelas duas instâncias ao mesmo tempo. A reserva é feita numa transação com bloqueio de linha e a BD tem um `CHECK (reserved <= qty)`: nunca se vende o que não existe."
   - **Medido:** 30 pedidos simultâneos de 50 unidades com 892 disponíveis → exatamente 17 aceites.
2. Pedidos repetidos: cada operação da interface leva um id criado no browser. Se a rede falhar e o pedido for
   repetido, o servidor reconhece o id e não duplica.
   - **Medido:** a mesma encomenda enviada 11 vezes → 1 reserva.

---

## Se perguntarem pelos limites

| Pergunta | Resposta curta |
|---|---|
| "Corre tudo no mesmo PC?" | Sim: o host Docker é um ponto único de falha assumido. Em produção cada réplica ficaria numa máquina diferente (Swarm/Kubernetes). As falhas simulam-se por contentor. |
| "E se o watchdog cair?" | O serviço continua; só deixa de haver promoção automática. Em produção usaria Patroni com etcd. |
| "Pode haver dois primários (split-brain)?" | Se a primária ficar isolada da rede sem parar, sim, durante a partição. O watchdog avisa ("mais do que um primário") e o nó antigo é re-clonado quando reinicia. É a principal limitação da solução. |
| "Perde dados?" | Mensagens confirmadas e pedidos aceites, não. Só as transações dos últimos milissegundos de uma BD primária que falhe (replicação assíncrona). |
| "Que consistência tem?" | Forte dentro de cada armazém (transações ACID). Eventual entre armazéns e empresa (mensagens). |
| "Quantas falhas aguenta?" | Uma por camada: 1 de 2 nginx, 1 de 2 APIs por serviço, 1 de 2 nós de cada BD, 1 de 3 nós de mensagens. |

## Se algo correr mal em palco

- Uma caixa não volta a verde: `docker compose ps` e `docker compose logs --tail 20 <contentor>`.
- A interface ficou no ecrã de entrada: a sessão dura 1 hora; entra outra vez.
- Queres recomeçar do zero: `docker compose down -v` e `docker compose up -d` (2 a 3 minutos).

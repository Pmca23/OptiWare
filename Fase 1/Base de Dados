# Estrutura da Base de Dados — OptiWare

**Projeto:** OptiWare — Sistema Distribuído e Inteligente de Gestão de Armazéns

**Tecnologia:** MySQL

---

# 1. Introdução

O OptiWare utiliza uma arquitetura distribuída para gerir vários armazéns através de uma única plataforma.

O sistema utilizará **MySQL** para armazenar e gerir a informação, garantindo a separação entre os dados globais e os dados operacionais de cada armazém.

### Objetivos

- Garantir a independência dos armazéns.
- Facilitar a expansão do sistema.
- Organizar os dados de forma estruturada.
- Garantir a integridade dos dados.
- Permitir a integração com o módulo CSP.

---

# 2. Tecnologia Utilizada — MySQL

O **MySQL** será o sistema de gestão de bases de dados utilizado no projeto.

### 2.1. Justificação da Escolha

A escolha do MySQL deve-se à sua integração com as restantes tecnologias previstas para o OptiWare.

- Compatibilidade com Java e Spring Boot.
- Suporte para bases de dados relacionais.
- Utilização de chaves primárias e estrangeiras.
- Suporte para transações através de InnoDB.
- Integração com Docker.
- Facilidade de manutenção e expansão.

---

# 3. Organização das Bases de Dados

O sistema será constituído por uma base de dados central e bases de dados independentes para cada armazém.

## 3.1. Base de Dados Central

**Nome:** `optiware_central`

Responsável pela informação global do sistema.

### Principais responsabilidades

- Gestão dos utilizadores.
- Gestão dos armazéns.
- Controlo de permissões.
- Coordenação de transferências.
- Registo do histórico das transferências.

## 3.2. Bases de Dados dos Armazéns

Cada armazém terá a sua própria base de dados MySQL.

**Exemplos:**

- `optiware_armazem_1`
- `optiware_armazem_2`
- `optiware_armazem_3`

Estas bases de dados serão responsáveis pela gestão de produtos, stock, zonas, prateleiras e propostas CSP.

---

# 4. Estrutura da Base de Dados Central

## 4.1. Tabela `armazens`

Guarda os dados dos armazéns registados na plataforma.

| Campo | Tipo | Descrição |
|---|---|---|
| id_armazem | INT, PK | Identificador único |
| nome | VARCHAR(100) | Nome do armazém |
| localizacao | VARCHAR(255) | Localização |
| estado | VARCHAR(30) | Estado operacional |

## 4.2. Tabela `utilizadores`

Guarda as informações dos utilizadores.

| Campo | Tipo | Descrição |
|---|---|---|
| id_utilizador | INT, PK | Identificador único |
| nome | VARCHAR(150) | Nome |
| email | VARCHAR(150), UNIQUE | Email |
| password_hash | VARCHAR(255) | Hash da palavra-passe |
| role | VARCHAR(30) | Perfil de acesso |

## 4.3. Tabela `utilizador_armazem`

Associa utilizadores aos armazéns autorizados.

| Campo | Tipo | Descrição |
|---|---|---|
| id_utilizador | INT, PK, FK | Utilizador |
| id_armazem | INT, PK, FK | Armazém |

## 4.4. Tabela `transferencias`

Regista transferências entre armazéns.

| Campo | Tipo | Descrição |
|---|---|---|
| id_transferencia | CHAR(36), PK | Identificador UUID |
| origem_id | INT, FK | Armazém de origem |
| destino_id | INT, FK | Armazém de destino |
| estado | VARCHAR(30) | Estado da transferência |
| data_criacao | DATETIME | Data de criação |

## 4.5. Tabela `transferencia_itens`

| Campo | Tipo | Descrição |
|---|---|---|
| id_item | INT, PK | Identificador |
| id_transferencia | CHAR(36), FK | Transferência |
| produto_sku | VARCHAR(100) | Código do produto |
| quantidade | INT | Quantidade |

## 4.6. Tabela `eventos_transferencia`

| Campo | Tipo | Descrição |
|---|---|---|
| id_evento | INT, PK | Identificador |
| id_transferencia | CHAR(36), FK | Transferência |
| tipo | VARCHAR(50) | Tipo de evento |
| data_evento | DATETIME | Data do evento |

---

# 5. Estrutura da Base de Dados dos Armazéns

## 5.1. Tabela `produtos`

| Campo | Tipo | Descrição |
|---|---|---|
| id_produto | INT, PK | Identificador |
| sku | VARCHAR(100), UNIQUE | Código do produto |
| nome | VARCHAR(150) | Nome |
| categoria | VARCHAR(100) | Categoria |
| peso | DECIMAL(10,2) | Peso unitário |
| volume | DECIMAL(10,3) | Volume unitário |

## 5.2. Tabela `zonas`

| Campo | Tipo | Descrição |
|---|---|---|
| id_zona | INT, PK | Identificador |
| nome | VARCHAR(100) | Nome da zona |

## 5.3. Tabela `prateleiras`

| Campo | Tipo | Descrição |
|---|---|---|
| id_prateleira | INT, PK | Identificador |
| id_zona | INT, FK | Zona |
| codigo | VARCHAR(50), UNIQUE | Código |
| capacidade_peso | DECIMAL(10,2) | Peso máximo |
| capacidade_volume | DECIMAL(10,3) | Volume máximo |

## 5.4. Tabela `stock`

| Campo | Tipo | Descrição |
|---|---|---|
| id_stock | INT, PK | Identificador |
| id_produto | INT, FK | Produto |
| id_prateleira | INT, FK | Prateleira |
| quantidade | INT | Quantidade armazenada |

## 5.5. Tabela `movimentos_stock`

| Campo | Tipo | Descrição |
|---|---|---|
| id_movimento | INT, PK | Identificador |
| id_produto | INT, FK | Produto |
| tipo | VARCHAR(30) | Tipo de movimento |
| quantidade | INT | Quantidade |
| data_movimento | DATETIME | Data |
| referencia | VARCHAR(100) | Referência |

## 5.6. Tabela `alocacoes_csp`

| Campo | Tipo | Descrição |
|---|---|---|
| id_alocacao | INT, PK | Identificador |
| estado | VARCHAR(30) | Estado da proposta |
| data_calculo | DATETIME | Data do cálculo |

## 5.7. Tabela `alocacao_itens`

| Campo | Tipo | Descrição |
|---|---|---|
| id_item | INT, PK | Identificador |
| id_alocacao | INT, FK | Alocação |
| id_produto | INT, FK | Produto |
| id_prateleira | INT, FK | Prateleira |
| quantidade | INT | Quantidade proposta |

---

# 6. Integridade e Consistência dos Dados

O OptiWare utilizará as funcionalidades do MySQL e do motor InnoDB para garantir a integridade dos dados.

### Regras previstas

1. Não permitir quantidades negativas de stock.
2. Respeitar as capacidades máximas das prateleiras.
3. Impedir registos duplicados do mesmo produto na mesma prateleira.
4. Utilizar transações para operações que alterem stock.
5. Validar as propostas CSP antes de atualizar os dados.
6. Evitar movimentos duplicados nas transferências.

---

# 7. Transferências Entre Armazéns

As transferências serão coordenadas pelos serviços centrais através de REST e RabbitMQ.

### Funcionamento previsto

1. Registo do pedido de transferência.
2. Verificação da disponibilidade no armazém de origem.
3. Reserva dos produtos.
4. Expedição da mercadoria.
5. Confirmação da receção.
6. Atualização do stock no destino.
7. Conclusão da transferência.

Cada armazém será responsável pelas alterações na sua própria base de dados MySQL.

---

# 8. Integração com Inteligência Artificial

O módulo CSP será utilizado para recomendar a distribuição de produtos pelas prateleiras.

### Restrições consideradas

- Peso dos produtos.
- Volume dos produtos.
- Capacidade das prateleiras.
- Espaço disponível.
- Quantidade de produtos.
- Restrições de armazenamento.

As recomendações serão apresentadas ao operador para confirmação antes de serem aplicadas.

---

# 9. MySQL e Docker

As bases de dados MySQL serão executadas em containers Docker, com volumes persistentes.

Cada armazém terá uma instância MySQL própria, permitindo separar os dados e os serviços.

Esta organização facilitará a instalação, manutenção e expansão do sistema.

---

# 10. Disponibilidade e Recuperação

A separação das bases de dados permitirá reduzir o impacto de falhas entre armazéns.

### Mecanismos previstos

- Backups periódicos.
- Recuperação de dados.
- Monitorização dos serviços.
- Reinício de containers.
- Persistência de mensagens RabbitMQ.
- Testes de falhas e recuperação.

A independência das bases de dados não garante, por si só, disponibilidade perante falhas da infraestrutura cloud.

---

# 11. Tecnologias do Sistema

| Componente | Tecnologia |
|---|---|
| Base de dados | MySQL |
| Motor de armazenamento | InnoDB |
| Backend | Java / Spring Boot |
| Persistência | Spring Data JPA / Hibernate |
| Frontend | React |
| Comunicação | REST / RabbitMQ |
| Containers | Docker / Docker Compose |
| Inteligência Artificial | CSP |
| Infraestrutura | Cloud |

---

# 12. Próximas Etapas

A estrutura apresentada corresponde ao modelo inicial da base de dados do OptiWare.

As próximas atividades serão:

- Criar os scripts SQL.
- Implementar as entidades Java.
- Configurar a ligação entre Spring Boot e MySQL.
- Configurar os containers Docker.
- Implementar a gestão de stock.
- Integrar o módulo CSP.
- Desenvolver as transferências entre armazéns.
- Realizar testes de integridade e recuperação.

# Estrutura das Bases de Dados (PostgreSQL)

## BD de cada armazém (`optiware_wh`, uma por armazém, com primário `whN-db1` + standby `whN-db2`)

```mermaid
erDiagram
  products ||--o{ stock : "tem"
  shelves  ||--o{ stock : "guarda"
  orders   ||--o{ order_allocations : "reserva"
  products { text sku PK  text name  text category  numeric weight_kg  numeric volume_l  text[] allowed_zones }
  shelves  { int id PK  text code  text zone  text[] allowed_categories  numeric max_weight  numeric max_volume }
  stock    { text sku PK,FK  int shelf_id PK,FK  int qty  int reserved }
  movements{ text id PK  text type  text sku  int shelf_id  int qty  text ref  timestamptz created_at }
  orders   { text id PK  text sku  int qty  text status }
  order_allocations { text order_id PK,FK  int shelf_id PK  text sku  int qty }
  transfers{ text id PK  text direction  text sku  int qty  text peer  text status }
  inbox    { text message_id PK }
  outbox   { uuid id PK  text topic  jsonb payload  timestamptz published_at }
  audit_log{ bigint id PK  text actor  text action  jsonb detail }
```

- `movements.id` é a chave de idempotência dos movimentos (impede duplicados).
- `stock`: `CHECK (reserved >= 0 AND reserved <= qty)`.
- `inbox` regista mensagens já processadas; `outbox` guarda mensagens a enviar (transactional outbox).

## BD central (`optiware_central`, primário `central-db1` + standby `central-db2`)

```mermaid
erDiagram
  users      { text username PK  text password_hash  text role }
  warehouses { text id PK  text name  text url  timestamptz last_seen }
  snapshots  { text warehouse_id PK  jsonb data  timestamptz taken_at }
  transfers  { text id PK  text from_wh  text to_wh  text sku  int qty  text status  text reason }
  outbox     { uuid id PK  text topic  jsonb payload  timestamptz published_at }
  audit_log  { bigint id PK  text actor  text action  jsonb detail }
```

Estados de `transfers.status`: `REQUESTED → IN_TRANSIT → COMPLETED` | `REJECTED`.

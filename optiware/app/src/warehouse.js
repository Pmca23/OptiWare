// Serviço de um armazém: backend + BD PostgreSQL próprios, autónomo em relação ao serviço central.
const express = require('express');
const C = require('./common');
const { solve, validate } = require('./csp');

const { httpError, wrap, audit, auth } = C;
const ID = process.env.WAREHOUSE_ID || 'wh1';
const NAME = process.env.WAREHOUSE_NAME || ID;
const INSTANCE = process.env.INSTANCE_ID || ID;
const SELF_URL = process.env.SELF_URL || `http://${ID}-api:3000`;
const CENTRAL_URLS = (process.env.CENTRAL_URLS || 'http://gateway:8080').split(',');
const OPERATOR = auth(['operator', 'admin']);
const ADMIN = auth(['admin']);
const ANY = auth();

const db = new C.HAPool(process.env.PG_HOSTS.split(','), {
  user: 'postgres',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.PG_DB || 'optiware_wh',
  retryMs: 15000, // tempo máximo à espera de um novo primário local (failover do watchdog ~6-8 s)
});
const mq = new C.MQ(process.env.AMQP_URL);

const SCHEMA = `
create table if not exists products (
  sku text primary key, name text not null, category text not null,
  weight_kg numeric not null check (weight_kg >= 0), volume_l numeric not null check (volume_l >= 0),
  allowed_zones text[]
);
create table if not exists shelves (
  id serial primary key, code text unique not null, zone text not null,
  allowed_categories text[] not null default '{}',
  max_weight numeric not null, max_volume numeric not null
);
create table if not exists stock (
  sku text not null references products(sku), shelf_id int not null references shelves(id),
  qty int not null check (qty >= 0),
  reserved int not null default 0,
  primary key (sku, shelf_id),
  check (reserved >= 0 and reserved <= qty)          -- a BD impede overselling
);
create table if not exists movements (
  id text primary key,                                -- chave de idempotência: impede movimentos duplicados
  type text not null, sku text not null, shelf_id int, qty int not null, ref text,
  created_at timestamptz not null default now()
);
create table if not exists orders (
  id text primary key, sku text not null, qty int not null check (qty > 0), status text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists order_allocations (
  order_id text not null references orders(id), sku text not null, shelf_id int not null, qty int not null,
  primary key (order_id, shelf_id)
);
create table if not exists transfers (
  id text primary key, direction text not null, sku text not null, qty int not null,
  peer text, status text not null, updated_at timestamptz not null default now()
);
create table if not exists inbox (message_id text primary key, received_at timestamptz not null default now());
${C.OUTBOX_AUDIT_SQL}`;

async function seed() {
  await db.tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(4243)'); // várias instâncias a arrancar: só uma faz o seed
    if ((await c.query('select count(*)::int n from shelves')).rows[0].n > 0) return;
    await c.query(`insert into products(sku,name,category,weight_kg,volume_l,allowed_zones) values
      ('P-100','Parafusos M8 (caixa)','hardware',0.02,0.01,null),
      ('P-200','Detergente industrial 5L','chemicals',5.0,6.0,'{B,C}'),
      ('P-300','Monitor 24"','electronics',3.5,20,null) on conflict do nothing`);
    await c.query(`insert into shelves(code,zone,allowed_categories,max_weight,max_volume) values
      ('A1','A','{hardware,electronics}',500,2000),
      ('A2','A','{hardware}',300,1000),
      ('B1','B','{chemicals}',400,800),
      ('C1','C','{}',200,500),
      ('DOCK','RECEIVING','{}',1000000,1000000)`);
    if (process.env.SEED_STOCK === '1') {
      await c.query(`insert into stock(sku,shelf_id,qty) select 'P-100', id, 1000 from shelves where code='A1'`);
      await c.query(`insert into stock(sku,shelf_id,qty) select 'P-200', id, 50 from shelves where code='B1'`);
      await c.query(`insert into stock(sku,shelf_id,qty) select 'P-300', id, 20 from shelves where code='A1'`);
    }
    console.log(`[${INSTANCE}] dados de exemplo criados`);
  });
}

// ---------- helpers de domínio ----------
/** Prateleiras com capacidade livre (peso/volume), opcionalmente bloqueadas para escrita. */
async function loadShelves(c, { lock = false, includeDock = false } = {}) {
  if (lock) await c.query('select id from shelves for update');
  const { rows } = await c.query(`
    select s.id, s.code, s.zone, s.allowed_categories, s.max_weight::float8 mw, s.max_volume::float8 mv,
           coalesce(sum(st.qty * p.weight_kg), 0)::float8 uw, coalesce(sum(st.qty * p.volume_l), 0)::float8 uv
    from shelves s left join stock st on st.shelf_id = s.id left join products p on p.sku = st.sku
    ${includeDock ? '' : "where s.zone <> 'RECEIVING'"}
    group by s.id order by s.id`);
  return rows.map((r) => ({ id: r.id, code: r.code, zone: r.zone, allowedCategories: r.allowed_categories, freeWeight: r.mw - r.uw, freeVolume: r.mv - r.uv }));
}

async function buildItems(c, lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const { sku, qty } = lines[i];
    if (!sku || !Number.isInteger(qty) || qty <= 0) throw httpError(400, `linha ${i}: sku e qty (inteiro > 0) obrigatórios`);
    const p = (await c.query('select * from products where sku = $1', [sku])).rows[0];
    if (!p) throw httpError(404, `produto ${sku} desconhecido`);
    items.push({ key: i, sku, qty, category: p.category, allowedZones: p.allowed_zones, weight: qty * Number(p.weight_kg), volume: qty * Number(p.volume_l) });
  }
  return items;
}

const addStock = (c, sku, shelfId, qty) =>
  c.query('insert into stock(sku, shelf_id, qty) values($1,$2,$3) on conflict (sku, shelf_id) do update set qty = stock.qty + excluded.qty', [sku, shelfId, qty]);
const addMovement = (c, id, type, sku, shelfId, qty, ref) =>
  c.query('insert into movements(id,type,sku,shelf_id,qty,ref) values($1,$2,$3,$4,$5,$6)', [id, type, sku, shelfId, qty, ref || null]);
const emit = (c, payload) => c.query("insert into outbox(topic, payload) values('central.events', $1)", [JSON.stringify(payload)]);

/** Retira `qty` unidades disponíveis (qty - reserved) de várias prateleiras; devolve [{shelf_id, take}] ou null. */
async function pickAvailable(c, sku, qty) {
  const { rows } = await c.query('select shelf_id, qty, reserved from stock where sku=$1 and qty-reserved>0 order by qty-reserved desc for update', [sku]);
  let need = qty;
  const picks = [];
  for (const r of rows) {
    const take = Math.min(need, r.qty - r.reserved);
    if (take > 0) picks.push({ shelf_id: r.shelf_id, take });
    need -= take;
    if (need === 0) break;
  }
  return need === 0 ? picks : null;
}

// ---------- consumo de comandos do serviço central (transferências) ----------
async function onCommand(msg, messageId) {
  await db.tx(async (c) => {
    const dup = await c.query('insert into inbox(message_id) values($1) on conflict do nothing returning 1', [messageId || `${msg.type}:${msg.transferId}`]);
    if (!dup.rowCount) return; // já processada -> não repete o movimento

    if (msg.type === 'TRANSFER_OUT') {
      const p = (await c.query('select * from products where sku=$1', [msg.sku])).rows[0];
      const picks = p ? await pickAvailable(c, msg.sku, msg.qty) : null;
      if (!picks) {
        await emit(c, { type: 'TRANSFER_REJECTED', transferId: msg.transferId, reason: 'stock insuficiente no armazém de origem' });
        await c.query("insert into transfers(id,direction,sku,qty,peer,status) values($1,'OUT',$2,$3,$4,'REJECTED') on conflict do nothing", [msg.transferId, msg.sku, msg.qty, msg.to]);
        return;
      }
      for (const k of picks) {
        await c.query('update stock set qty = qty - $1 where sku=$2 and shelf_id=$3', [k.take, msg.sku, k.shelf_id]);
        await addMovement(c, `${msg.transferId}:out:${k.shelf_id}`, 'TRANSFER_OUT', msg.sku, k.shelf_id, k.take, msg.transferId);
      }
      await c.query("insert into transfers(id,direction,sku,qty,peer,status) values($1,'OUT',$2,$3,$4,'SHIPPED') on conflict do nothing", [msg.transferId, msg.sku, msg.qty, msg.to]);
      await emit(c, { type: 'TRANSFER_SHIPPED', transferId: msg.transferId, product: { name: p.name, category: p.category, weight_kg: Number(p.weight_kg), volume_l: Number(p.volume_l), allowed_zones: p.allowed_zones } });
    }

    if (msg.type === 'TRANSFER_IN') {
      const pr = msg.product;
      await c.query('insert into products(sku,name,category,weight_kg,volume_l,allowed_zones) values($1,$2,$3,$4,$5,$6) on conflict do nothing', [msg.sku, pr.name, pr.category, pr.weight_kg, pr.volume_l, pr.allowed_zones]);
      const items = await buildItems(c, [{ sku: msg.sku, qty: msg.qty }]);
      const shelves = await loadShelves(c, { lock: true });
      const sol = solve(items, shelves);
      let shelfId;
      let fallback = false;
      if (sol.ok) shelfId = sol.assignments[0].shelfId;
      else {
        shelfId = (await c.query("select id from shelves where zone='RECEIVING' limit 1")).rows[0].id; // CSP sem solução -> doca de receção
        fallback = true;
      }
      await addStock(c, msg.sku, shelfId, msg.qty);
      await addMovement(c, `${msg.transferId}:in`, 'TRANSFER_IN', msg.sku, shelfId, msg.qty, msg.transferId);
      await c.query("insert into transfers(id,direction,sku,qty,peer,status) values($1,'IN',$2,$3,$4,'RECEIVED') on conflict do nothing", [msg.transferId, msg.sku, msg.qty, msg.from]);
      await emit(c, { type: 'TRANSFER_RECEIVED', transferId: msg.transferId, shelfId, usedReceivingDock: fallback });
    }
  });
}
mq.consume(`wh.${ID}`, onCommand);

// ---------- API HTTP ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('X-Warehouse', ID);
  res.set('X-Served-By', INSTANCE); // qual instância respondeu (útil na demonstração)
  next();
});

app.get('/live', (req, res) => res.send('ok'));
app.get(
  '/health',
  wrap(async (req, res) => {
    await db.query('select 1');
    res.json({ warehouse: ID, db: 'up', broker: mq.up ? 'up' : 'down' });
  })
);
app.get('/stats', wrap(async (req, res) => res.json({ instance: INSTANCE, service: ID, warehouse: ID, name: NAME, ...(await C.infraStats(db, mq)) })));

// Consulta
app.get('/products', ANY, wrap(async (req, res) => res.json((await db.query('select * from products order by sku')).rows)));
app.get(
  '/shelves',
  ANY,
  wrap(async (req, res) => {
    const shelves = await loadShelves(db, { includeDock: true });
    res.json(shelves);
  })
);
app.get(
  '/stock',
  ANY,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `select s.sku, p.name, sh.code shelf, s.qty, s.reserved, s.qty - s.reserved available
       from stock s join products p using(sku) join shelves sh on sh.id = s.shelf_id
       where s.qty > 0 and ($1::text is null or s.sku = $1) order by s.sku, sh.code`,
      [req.query.sku || null]
    );
    res.json(rows);
  })
);
app.get('/movements', ANY, wrap(async (req, res) => res.json((await db.query('select * from movements order by created_at desc limit $1', [Math.min(parseInt(req.query.limit || '50', 10), 500)])).rows)));
app.get('/orders', ANY, wrap(async (req, res) => res.json((await db.query('select * from orders order by created_at desc limit 100')).rows)));
app.get('/transfers', ANY, wrap(async (req, res) => res.json((await db.query('select * from transfers order by updated_at desc limit 100')).rows)));
app.get('/audit', ADMIN, wrap(async (req, res) => res.json((await db.query('select * from audit_log order by id desc limit 100')).rows)));

// Consulta interna para o serviço central (visão global)
app.get(
  '/internal/stock',
  C.serviceAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `select s.sku, p.name, sum(s.qty)::int total, sum(s.reserved)::int reserved, sum(s.qty - s.reserved)::int available
       from stock s join products p using(sku) group by s.sku, p.name order by s.sku`
    );
    res.json({ warehouse: ID, items: rows });
  })
);

// Catálogo e prateleiras
app.post(
  '/products',
  ADMIN,
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.sku || !b.name || !b.category) throw httpError(400, 'sku, name e category obrigatórios');
    await db.query('insert into products(sku,name,category,weight_kg,volume_l,allowed_zones) values($1,$2,$3,$4,$5,$6) on conflict (sku) do nothing', [b.sku, b.name, b.category, b.weight_kg ?? 0, b.volume_l ?? 0, b.allowed_zones ?? null]);
    await audit(db, req.user.sub, 'PRODUCT_CREATED', b);
    res.status(201).json({ ok: true });
  })
);
app.post(
  '/shelves',
  ADMIN,
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.code || !b.zone) throw httpError(400, 'code e zone obrigatórios');
    await db.query('insert into shelves(code,zone,allowed_categories,max_weight,max_volume) values($1,$2,$3,$4,$5) on conflict (code) do nothing', [b.code, b.zone, b.allowed_categories || [], b.max_weight, b.max_volume]);
    await audit(db, req.user.sub, 'SHELF_CREATED', b);
    res.status(201).json({ ok: true });
  })
);

// IA (CSP): propõe posições; NÃO altera dados.
app.post(
  '/allocate',
  OPERATOR,
  wrap(async (req, res) => {
    const lines = (req.body && req.body.items) || [];
    if (!lines.length) throw httpError(400, 'items obrigatório');
    const items = await buildItems(db, lines);
    const shelves = await loadShelves(db);
    const sol = solve(items, shelves);
    const code = new Map(shelves.map((s) => [s.id, s.code]));
    res.json({
      feasible: sol.ok,
      nodesExplored: sol.nodes,
      assignments: sol.ok ? sol.assignments.map((a) => ({ sku: items[a.key].sku, qty: items[a.key].qty, shelfId: a.shelfId, shelf: code.get(a.shelfId) })) : [],
      unplaceable: sol.ok ? [] : sol.unplaceable.map((k) => items[k].sku),
    });
  })
);

// Confirmação pelo operador: revalida as restrições dentro da transação e só então grava.
app.post(
  '/putaway',
  OPERATOR,
  wrap(async (req, res) => {
    const { id, assignments } = req.body || {};
    if (!id || !Array.isArray(assignments) || !assignments.length) throw httpError(400, 'id e assignments obrigatórios');
    const result = await db.tx(async (c) => {
      if ((await c.query('select 1 from movements where id=$1', [`${id}:0`])).rowCount) return { duplicate: true };
      const items = await buildItems(c, assignments);
      const shelves = await loadShelves(c, { lock: true, includeDock: true });
      const errors = validate(items, shelves, assignments.map((a, i) => ({ key: i, shelfId: a.shelfId })));
      if (errors.length) throw Object.assign(httpError(409, 'atribuição viola restrições'), { details: errors });
      for (let i = 0; i < assignments.length; i++) {
        await addStock(c, assignments[i].sku, assignments[i].shelfId, assignments[i].qty);
        await addMovement(c, `${id}:${i}`, 'IN', assignments[i].sku, assignments[i].shelfId, assignments[i].qty, id);
      }
      return { stored: assignments.length };
    });
    if (!result.duplicate) await audit(db, req.user.sub, 'PUTAWAY', { id, assignments });
    res.status(result.duplicate ? 200 : 201).json(result);
  })
);

// Encomendas: reserva transacional (nunca reserva mais do que o disponível)
app.post(
  '/orders',
  OPERATOR,
  wrap(async (req, res) => {
    const { id, sku, qty } = req.body || {};
    if (!id || !sku || !Number.isInteger(qty) || qty <= 0) throw httpError(400, 'id, sku e qty (inteiro > 0) obrigatórios');
    try {
      const out = await db.tx(async (c) => {
        const ex = (await c.query('select * from orders where id=$1', [id])).rows[0];
        if (ex) return { ...ex, duplicate: true };
        const picks = await pickAvailable(c, sku, qty);
        if (!picks) throw httpError(409, 'stock insuficiente');
        await c.query("insert into orders(id,sku,qty,status) values($1,$2,$3,'RESERVED')", [id, sku, qty]);
        for (const k of picks) {
          await c.query('update stock set reserved = reserved + $1 where sku=$2 and shelf_id=$3', [k.take, sku, k.shelf_id]);
          await c.query('insert into order_allocations(order_id,sku,shelf_id,qty) values($1,$2,$3,$4)', [id, sku, k.shelf_id, k.take]);
        }
        return { id, sku, qty, status: 'RESERVED' };
      });
      if (!out.duplicate) await audit(db, req.user.sub, 'ORDER_RESERVED', { id, sku, qty });
      res.status(out.duplicate ? 200 : 201).json(out);
    } catch (e) {
      if (e.code === '23505') return res.status(200).json({ id, duplicate: true }); // pedido concorrente com o mesmo id
      throw e;
    }
  })
);

async function closeOrder(req, res, fulfill) {
  const id = req.params.id;
  const out = await db.tx(async (c) => {
    const o = (await c.query('select * from orders where id=$1 for update', [id])).rows[0];
    if (!o) throw httpError(404, 'encomenda inexistente');
    const target = fulfill ? 'FULFILLED' : 'CANCELLED';
    if (o.status === target) return { ...o, duplicate: true };
    if (o.status !== 'RESERVED') throw httpError(409, `encomenda em estado ${o.status}`);
    const allocs = (await c.query('select * from order_allocations where order_id=$1', [id])).rows;
    for (const a of allocs) {
      if (fulfill) {
        await c.query('update stock set qty = qty - $1, reserved = reserved - $1 where sku=$2 and shelf_id=$3', [a.qty, a.sku, a.shelf_id]);
        await addMovement(c, `${id}:out:${a.shelf_id}`, 'OUT', a.sku, a.shelf_id, a.qty, id);
      } else await c.query('update stock set reserved = reserved - $1 where sku=$2 and shelf_id=$3', [a.qty, a.sku, a.shelf_id]);
    }
    await c.query('update orders set status=$2, updated_at=now() where id=$1', [id, target]);
    return { id, status: target };
  });
  if (!out.duplicate) await audit(db, req.user.sub, fulfill ? 'ORDER_FULFILLED' : 'ORDER_CANCELLED', { id });
  res.json(out);
}
app.post('/orders/:id/fulfill', OPERATOR, wrap((req, res) => closeOrder(req, res, true)));
app.post('/orders/:id/cancel', OPERATOR, wrap((req, res) => closeOrder(req, res, false)));

app.use((err, req, res, next) => res.status(err.status || 400).json({ error: err.message })); // JSON inválido, etc.

// ---------- arranque ----------
async function heartbeat() {
  for (const base of CENTRAL_URLS) {
    try {
      const r = await fetch(`${base}/warehouses/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-key': C.SERVICE_KEY },
        body: JSON.stringify({ id: ID, name: NAME, url: SELF_URL }),
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch (_) {
      /* central indisponível: o armazém continua a funcionar sozinho */
    }
  }
}

(async () => {
  await db.migrate(SCHEMA);
  await seed();
  C.startOutbox(db, mq);
  app.listen(3000, () => console.log(`[${INSTANCE}] armazém ${ID} a escutar em :3000`));
  heartbeat();
  setInterval(heartbeat, 5000);
})();

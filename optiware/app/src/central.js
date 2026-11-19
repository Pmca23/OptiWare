// Serviços centrais: registo de armazéns, autenticação, visão global e coordenação de transferências.
// Várias instâncias sem estado + BD PostgreSQL com primário/standby.
const express = require('express');
const C = require('./common');

const { httpError, wrap, audit, auth } = C;
const INSTANCE = process.env.INSTANCE_ID || require('os').hostname();
const ANY = auth();
const OPERATOR = auth(['operator', 'admin']);

const db = new C.HAPool(process.env.PG_HOSTS.split(','), {
  user: 'postgres',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.PG_DB || 'optiware_central',
  retryMs: 20000, // tempo máximo à espera de um novo primário (failover)
});
const mq = new C.MQ(process.env.AMQP_URL);

const SCHEMA = `
create table if not exists users (username text primary key, password_hash text not null, role text not null check (role in ('admin','operator','viewer')));
create table if not exists warehouses (id text primary key, name text not null, url text not null, last_seen timestamptz not null default now());
create table if not exists snapshots (warehouse_id text primary key, data jsonb not null, taken_at timestamptz not null default now());
create table if not exists transfers (
  id text primary key, from_wh text not null, to_wh text not null, sku text not null, qty int not null check (qty > 0),
  status text not null, reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
${C.OUTBOX_AUDIT_SQL}`;

async function seedUsers() {
  const users = [
    ['admin', process.env.ADMIN_PASSWORD || 'admin123', 'admin'],
    ['operador', process.env.OPERATOR_PASSWORD || 'operador123', 'operator'],
    ['consulta', process.env.VIEWER_PASSWORD || 'consulta123', 'viewer'],
  ];
  for (const [u, p, r] of users) await db.query('insert into users values($1,$2,$3) on conflict do nothing', [u, C.hashPassword(p), r]);
}

// ---------- eventos dos armazéns -> máquina de estados da transferência ----------
// REQUESTED -> IN_TRANSIT -> COMPLETED   (ou REQUESTED -> REJECTED)
// As transições condicionais ao estado tornam o processamento idempotente (mensagens repetidas são ignoradas).
async function onEvent(msg) {
  await db.tx(async (c) => {
    const t = (await c.query('select * from transfers where id=$1 for update', [msg.transferId])).rows[0];
    if (!t) return;
    if (msg.type === 'TRANSFER_SHIPPED' && t.status === 'REQUESTED') {
      await c.query("update transfers set status='IN_TRANSIT', updated_at=now() where id=$1", [t.id]);
      await c.query('insert into outbox(topic, payload) values($1,$2)', [`wh.${t.to_wh}`, JSON.stringify({ type: 'TRANSFER_IN', transferId: t.id, sku: t.sku, qty: t.qty, from: t.from_wh, product: msg.product })]);
    } else if (msg.type === 'TRANSFER_REJECTED' && t.status === 'REQUESTED') {
      await c.query("update transfers set status='REJECTED', reason=$2, updated_at=now() where id=$1", [t.id, msg.reason]);
    } else if (msg.type === 'TRANSFER_RECEIVED' && t.status === 'IN_TRANSIT') {
      await c.query("update transfers set status='COMPLETED', updated_at=now() where id=$1", [t.id]);
    }
  });
}
mq.consume('central.events', onEvent);

// ---------- API HTTP ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('X-Served-By', INSTANCE);
  next();
});

app.get('/live', (req, res) => res.send('ok'));
app.get(
  '/health',
  wrap(async (req, res) => {
    await db.query('select 1');
    res.json({ instance: INSTANCE, db: 'up', broker: mq.up ? 'up' : 'down' });
  })
);
app.get(
  '/stats',
  wrap(async (req, res) => {
    const s = await C.infraStats(db, mq, async () => {
      const w = await db.query("select count(*) filter (where last_seen > now() - interval '20 seconds')::int up, count(*)::int total from warehouses");
      return { warehousesUp: w.rows[0].up, warehousesTotal: w.rows[0].total };
    });
    res.json({ instance: INSTANCE, service: 'central', ...s });
  })
);

app.post(
  '/auth/login',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    const u = username && (await db.query('select * from users where username=$1', [username])).rows[0];
    if (!u || !C.verifyPassword(String(password || ''), u.password_hash)) {
      await audit(db, username || '?', 'LOGIN_FAILED', {});
      throw httpError(401, 'credenciais inválidas');
    }
    await audit(db, u.username, 'LOGIN', {});
    res.json({ token: C.signToken(u), role: u.role });
  })
);

// Registo/heartbeat de armazéns (qualquer número de armazéns, sem lista fixa)
app.post(
  '/warehouses/heartbeat',
  C.serviceAuth,
  wrap(async (req, res) => {
    const { id, name, url } = req.body || {};
    if (!id || !url) throw httpError(400, 'id e url obrigatórios');
    await db.query(
      'insert into warehouses(id,name,url,last_seen) values($1,$2,$3,now()) on conflict (id) do update set name=$2, url=$3, last_seen=now()',
      [id, name || id, url]
    );
    res.json({ ok: true });
  })
);
app.get(
  '/warehouses',
  ANY,
  wrap(async (req, res) => {
    const { rows } = await db.query("select id, name, url, last_seen, case when last_seen > now() - interval '20 seconds' then 'UP' else 'DOWN' end as status from warehouses order by id");
    res.json(rows);
  })
);

// Visão global: consulta cada armazém; se algum não responder usa o último snapshot (marcado como stale).
async function fetchWarehouse(w) {
  try {
    const r = await fetch(`${w.url}/internal/stock`, { headers: { 'x-service-key': C.SERVICE_KEY }, signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    db.query('insert into snapshots(warehouse_id,data,taken_at) values($1,$2,now()) on conflict (warehouse_id) do update set data=$2, taken_at=now()', [w.id, JSON.stringify(data.items)]).catch(() => {});
    return { warehouse: w.id, state: 'live', asOf: new Date().toISOString(), items: data.items };
  } catch (_) {
    const s = (await db.query('select data, taken_at from snapshots where warehouse_id=$1', [w.id])).rows[0];
    return { warehouse: w.id, state: s ? 'stale' : 'unavailable', asOf: s ? s.taken_at : null, items: s ? s.data : [] };
  }
}
// Atualiza snapshots em segundo plano, para haver sempre um "último estado conhecido" quando um armazém cai.
setInterval(() => db.query('select id, url from warehouses').then((r) => Promise.all(r.rows.map(fetchWarehouse))).catch(() => {}), 10000);

app.get(
  '/stock',
  ANY,
  wrap(async (req, res) => {
    const whs = (await db.query('select id, url from warehouses order by id')).rows;
    const results = await Promise.all(whs.map(fetchWarehouse));
    const filter = req.query.sku;
    const totals = {};
    for (const r of results)
      for (const i of r.items)
        if (!filter || i.sku === filter) {
          totals[i.sku] = totals[i.sku] || { sku: i.sku, name: i.name, total: 0, available: 0 };
          totals[i.sku].total += i.total;
          totals[i.sku].available += i.available;
        }
    res.json({ warehouses: results.map((r) => ({ ...r, items: filter ? r.items.filter((i) => i.sku === filter) : r.items })), totals: Object.values(totals) });
  })
);

// Transferências: o pedido é aceite (202) e gravado de forma duradoura mesmo que o broker esteja em baixo.
app.post(
  '/transfers',
  OPERATOR,
  wrap(async (req, res) => {
    const b = req.body || {};
    const id = b.id || require('crypto').randomUUID();
    if (!b.from || !b.to || !b.sku || !Number.isInteger(b.qty) || b.qty <= 0 || b.from === b.to) throw httpError(400, 'from, to (diferentes), sku e qty (inteiro > 0) obrigatórios');
    const known = (await db.query('select id from warehouses where id = any($1)', [[b.from, b.to]])).rowCount;
    if (known < 2) throw httpError(404, 'armazém de origem ou destino não registado');
    const created = await db.tx(async (c) => {
      const ins = await c.query("insert into transfers(id,from_wh,to_wh,sku,qty,status) values($1,$2,$3,$4,$5,'REQUESTED') on conflict do nothing returning 1", [id, b.from, b.to, b.sku, b.qty]);
      if (!ins.rowCount) return false;
      await c.query('insert into outbox(topic,payload) values($1,$2)', [`wh.${b.from}`, JSON.stringify({ type: 'TRANSFER_OUT', transferId: id, sku: b.sku, qty: b.qty, to: b.to })]);
      return true;
    });
    if (created) await audit(db, req.user.sub, 'TRANSFER_REQUESTED', { id, ...b });
    res.status(202).json({ id, status: 'REQUESTED', duplicate: !created });
  })
);
app.get('/transfers', ANY, wrap(async (req, res) => res.json((await db.query('select * from transfers order by created_at desc limit 100')).rows)));
app.get(
  '/transfers/:id',
  ANY,
  wrap(async (req, res) => {
    const t = (await db.query('select * from transfers where id=$1', [req.params.id])).rows[0];
    if (!t) throw httpError(404, 'transferência inexistente');
    res.json(t);
  })
);
app.get('/audit', auth(['admin']), wrap(async (req, res) => res.json((await db.query('select * from audit_log order by id desc limit 100')).rows)));

app.use((err, req, res, next) => res.status(err.status || 400).json({ error: err.message }));

(async () => {
  await db.migrate(SCHEMA);
  await seedUsers();
  C.startOutbox(db, mq);
  app.listen(3000, () => console.log(`[${INSTANCE}] serviço central a escutar em :3000`));
})();

// Código partilhado: ligação HA à BD, autenticação, auditoria, mensagens (RabbitMQ) e outbox.
const { Pool } = require('pg');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const net = require('net');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const SERVICE_KEY = process.env.SERVICE_KEY || 'dev-service-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (status, message) => Object.assign(new Error(message), { status });

const CONN_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '25006'];
function isConnErr(e) {
  return CONN_CODES.includes(e.code) || /Connection terminated|timeout|read-only transaction|the database system is/i.test(e.message || '');
}

/**
 * Pool com suporte a vários nós (primário + standby). Se o nó atual falhar ou deixar de ser
 * escrevível, redescobre o primário (pg_is_in_recovery() = false) e repete a operação.
 * Com um único host comporta-se como um pool normal que "aguenta" reinícios da BD (retryMs).
 */
class HAPool {
  constructor(hosts, { user, password, database, retryMs = 10000 }) {
    this.hosts = hosts;
    this.retryMs = retryMs;
    this.cur = 0;
    this.pools = hosts.map((hp) => {
      const [host, port] = hp.split(':'); // aceita "host" ou "host:porta"
      const p = new Pool({ host, port: port ? Number(port) : 5432, user, password, database, max: 10, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000 });
      p.on('error', () => {});
      return p;
    });
  }
  get primaryHost() {
    return this.hosts[this.cur];
  }
  async findPrimary() {
    for (let i = 0; i < this.pools.length; i++) {
      try {
        const r = await this.pools[i].query('select pg_is_in_recovery() as r');
        if (!r.rows[0].r) {
          this.cur = i;
          return i;
        }
      } catch (_) {
        /* nó em baixo */
      }
    }
    return -1;
  }
  async run(fn) {
    const deadline = Date.now() + this.retryMs;
    let last;
    for (;;) {
      try {
        return await fn(this.pools[this.cur]);
      } catch (e) {
        if (!isConnErr(e)) throw e;
        last = e;
        if (Date.now() > deadline) throw last;
        if ((await this.findPrimary()) < 0) await sleep(1000);
      }
    }
  }
  query(text, params) {
    return this.run((pool) => pool.query(text, params));
  }
  tx(fn) {
    return this.run(async (pool) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try {
          await c.query('ROLLBACK');
        } catch (_) {}
        throw e;
      } finally {
        c.release();
      }
    });
  }
  /** Papel atual de cada nó (primary | standby | down). Não bloqueia durante um failover. */
  status() {
    return Promise.all(
      this.pools.map(async (p, i) => {
        try {
          const r = await p.query('select pg_is_in_recovery() as r');
          return { host: this.hosts[i], role: r.rows[0].r ? 'standby' : 'primary' };
        } catch (_) {
          return { host: this.hosts[i], role: 'down' };
        }
      })
    );
  }
  /** Executa o esquema (idempotente) com lock para várias instâncias não colidirem. */
  async migrate(sql) {
    for (;;) {
      try {
        await this.tx(async (c) => {
          await c.query('select pg_advisory_xact_lock(4242)');
          await c.query(sql);
        });
        return;
      } catch (e) {
        console.log('[db] a aguardar base de dados:', e.message);
        await sleep(2000);
      }
    }
  }
}

// ---------- passwords e tokens ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
const signToken = (user) => jwt.sign({ sub: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });

/** Middleware: valida o JWT localmente (sem chamar o serviço central -> armazéns são autónomos). */
function auth(roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    try {
      const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
      if (roles && !roles.includes(p.role)) return res.status(403).json({ error: 'sem permissão para esta operação' });
      req.user = p;
      next();
    } catch (_) {
      res.status(401).json({ error: 'não autenticado' });
    }
  };
}
function serviceAuth(req, res, next) {
  if (req.headers['x-service-key'] === SERVICE_KEY) return next();
  res.status(401).json({ error: 'chave de serviço inválida' });
}

// ---------- erros e auditoria ----------
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || (isConnErr(e) ? 503 : e.code === '23514' || e.code === '23503' ? 409 : 500);
    if (status >= 500) console.log('[erro]', e.message);
    res.status(status).json({ error: status === 503 ? 'base de dados indisponível' : e.message, ...(e.details ? { details: e.details } : {}) });
  });

async function audit(db, actor, action, detail) {
  try {
    await db.query('insert into audit_log(actor, action, detail) values($1,$2,$3)', [actor, action, JSON.stringify(detail || {})]);
  } catch (_) {
    /* a auditoria nunca deve impedir a operação */
  }
}

// ---------- RabbitMQ com reconexão ----------
class MQ {
  constructor(urls) {
    this.urls = urls.split(','); // vários nós do cluster RabbitMQ: tenta o seguinte quando um falha
    this.next = 0;
    this.ch = null;
    this.up = false;
    this.node = null; // nó do cluster a que esta instância está ligada
    this.consumers = [];
    this.asserted = new Set();
    this.loop();
  }
  async loop() {
    for (;;) {
      try {
        const url = this.urls[this.next++ % this.urls.length];
        const conn = await amqp.connect(url);
        conn.on('error', () => {});
        const ch = await conn.createConfirmChannel();
        ch.on('error', () => {});
        await ch.prefetch(10);
        this.ch = ch;
        this.asserted.clear();
        for (const c of this.consumers) await this.startConsumer(c);
        this.up = true;
        this.node = new URL(url).hostname;
        console.log(`[mq] ligado ao broker (${this.node})`);
        await new Promise((r) => {
          conn.once('close', r);
          ch.once('close', r);
        });
        try {
          await conn.close();
        } catch (_) {}
      } catch (e) {
        console.log('[mq] broker indisponível:', e.message);
      }
      this.up = false;
      this.node = null;
      this.ch = null;
      await sleep(2000);
    }
  }
  /** Que nós do cluster aceitam ligações (teste TCP, com cache de 2 s). Só para o painel de infraestrutura. */
  async nodes() {
    if (this._nodes && Date.now() - this._nodesAt < 2000) return this._nodes;
    this._nodes = await Promise.all(
      this.urls.map((u) => {
        const { hostname, port } = new URL(u);
        return new Promise((resolve) => {
          const s = net.connect({ host: hostname, port: Number(port) || 5672 });
          const done = (up) => {
            s.destroy();
            resolve({ host: hostname, up });
          };
          s.setTimeout(1000, () => done(false));
          s.once('connect', () => done(true));
          s.once('error', () => done(false));
        });
      })
    );
    this._nodesAt = Date.now();
    return this._nodes;
  }
  async assert(q) {
    if (!this.asserted.has(q)) {
      // quorum queue: replicada em 3 nós (Raft); sobrevive à perda de 1 nó sem perder mensagens
      await this.ch.assertQueue(q, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-quorum-initial-group-size': 3 } });
      this.asserted.add(q);
    }
  }
  /** Publica com confirmação do broker (publisher confirms) e mensagem persistente. */
  async publish(queue, msg, messageId) {
    if (!this.ch) throw new Error('broker indisponível');
    await this.assert(queue);
    await new Promise((resolve, reject) =>
      this.ch.sendToQueue(queue, Buffer.from(JSON.stringify(msg)), { persistent: true, messageId, contentType: 'application/json' }, (err) => (err ? reject(err) : resolve()))
    );
  }
  async consume(queue, handler) {
    const c = { queue, handler };
    this.consumers.push(c);
    if (this.ch) await this.startConsumer(c);
  }
  async startConsumer({ queue, handler }) {
    const ch = this.ch;
    await this.assert(queue);
    await ch.consume(queue, async (m) => {
      if (!m) return;
      try {
        await handler(JSON.parse(m.content.toString()), m.properties.messageId);
        ch.ack(m);
      } catch (e) {
        console.log('[mq] falha a processar, será reentregue:', e.message);
        setTimeout(() => {
          try {
            ch.nack(m, false, true);
          } catch (_) {}
        }, 3000);
      }
    });
  }
}

/**
 * Transactional outbox: as mensagens são gravadas na mesma transação que a alteração de dados
 * e só depois enviadas. Se o broker estiver em baixo, nada se perde: ficam pendentes na BD.
 */
function startOutbox(db, mq) {
  let busy = false;
  setInterval(async () => {
    if (busy || !mq.up) return;
    busy = true;
    try {
      await db.tx(async (c) => {
        const { rows } = await c.query('select id, topic, payload from outbox where published_at is null order by created_at limit 50 for update skip locked');
        for (const r of rows) {
          await mq.publish(r.topic, r.payload, r.id);
          await c.query('update outbox set published_at = now() where id = $1', [r.id]);
        }
      });
    } catch (_) {
      /* repete no próximo ciclo; os consumidores são idempotentes */
    }
    busy = false;
  }, 1000);
}

/**
 * Estado de uma instância para o painel de infraestrutura da interface: papel de cada nó da BD,
 * nó do broker a que está ligada e mensagens ainda por enviar. Responde em ~2 s mesmo a meio de um failover.
 */
async function infraStats(db, mq, extra) {
  const [dbNodes, brokerNodes] = await Promise.all([db.status(), mq.nodes()]);
  const primary = dbNodes.find((n) => n.role === 'primary');
  let more = {};
  if (primary) {
    const q = async () => ({
      outboxPending: (await db.query('select count(*)::int n from outbox where published_at is null')).rows[0].n,
      ...(extra ? await extra() : {}),
    });
    more = await Promise.race([q().catch(() => ({})), sleep(2500).then(() => ({}))]);
  }
  return { dbPrimary: primary ? primary.host : null, dbNodes, broker: mq.up ? 'up' : 'down', brokerNode: mq.node, brokerNodes, ...more };
}

const OUTBOX_AUDIT_SQL = `
create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text,
  action text not null,
  detail jsonb
);`;

module.exports = { HAPool, MQ, startOutbox, infraStats, auth, serviceAuth, signToken, hashPassword, verifyPassword, wrap, audit, httpError, isConnErr, sleep, OUTBOX_AUDIT_SQL, SERVICE_KEY };

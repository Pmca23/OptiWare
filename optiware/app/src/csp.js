// Módulo de IA: Problema de Satisfação de Restrições (CSP) para alocação de produtos a prateleiras.
//
// Variáveis : cada lote (item) a arrumar.
// Domínios  : prateleiras.
// Restrições:
//   (unárias)  categoria do produto permitida na prateleira; zona permitida para o produto;
//   (globais)  soma dos pesos <= peso máximo livre; soma dos volumes <= volume máximo livre.
// Algoritmo : backtracking com MRV (variável com menor domínio), forward checking
//             (falha logo que algum item fica sem domínio) e best-fit como ordenação de valores.

const EPS = 1e-9;

function unaryOk(item, shelf) {
  const catOk = !shelf.allowedCategories || shelf.allowedCategories.length === 0 || shelf.allowedCategories.includes(item.category);
  const zoneOk = !item.allowedZones || item.allowedZones.length === 0 || item.allowedZones.includes(shelf.zone);
  return catOk && zoneOk;
}

/**
 * items:  [{ key, category, weight, volume, allowedZones? }]   (peso/volume TOTAIS do lote)
 * shelves:[{ id, zone, allowedCategories, freeWeight, freeVolume }]
 * devolve { ok, assignments:[{key, shelfId}], nodes, unplaceable:[key] }
 */
function solve(items, shelves, { maxNodes = 200000 } = {}) {
  const rem = new Map(shelves.map((s) => [s.id, { w: s.freeWeight, v: s.freeVolume }]));
  const unary = items.map((it) => shelves.filter((s) => unaryOk(it, s)));
  const impossible = items.filter((it, i) => !unary[i].some((s) => it.weight <= s.freeWeight + EPS && it.volume <= s.freeVolume + EPS)).map((it) => it.key);
  if (impossible.length) return { ok: false, assignments: [], nodes: 0, unplaceable: impossible };

  const assign = new Array(items.length).fill(null);
  let nodes = 0;
  const domain = (i) =>
    unary[i].filter((s) => {
      const r = rem.get(s.id);
      return items[i].weight <= r.w + EPS && items[i].volume <= r.v + EPS;
    });

  function bt(left) {
    if (left.size === 0) return true;
    if (++nodes > maxNodes) return false;
    let best = -1;
    let bestDom = null;
    for (const i of left) {
      const d = domain(i); // forward checking
      if (d.length === 0) return false;
      if (!bestDom || d.length < bestDom.length) {
        best = i;
        bestDom = d;
      }
    }
    const it = items[best];
    const slack = (s) => rem.get(s.id).w - it.weight + (rem.get(s.id).v - it.volume);
    bestDom.sort((a, b) => slack(a) - slack(b)); // best-fit: preenche prateleiras já usadas primeiro
    left.delete(best);
    for (const s of bestDom) {
      const r = rem.get(s.id);
      r.w -= it.weight;
      r.v -= it.volume;
      assign[best] = s.id;
      if (bt(left)) return true;
      r.w += it.weight;
      r.v += it.volume;
      assign[best] = null;
    }
    left.add(best);
    return false;
  }

  const ok = bt(new Set(items.map((_, i) => i)));
  return {
    ok,
    assignments: ok ? items.map((it, i) => ({ key: it.key, shelfId: assign[i] })) : [],
    nodes,
    unplaceable: ok ? [] : items.map((it) => it.key),
  };
}

/** Valida uma atribuição proposta (usada na confirmação pelo operador). Devolve lista de erros. */
function validate(items, shelves, assignments) {
  const byShelf = new Map(shelves.map((s) => [s.id, { s, w: s.freeWeight, v: s.freeVolume }]));
  const errors = [];
  assignments.forEach((a) => {
    const it = items.find((x) => x.key === a.key);
    const slot = byShelf.get(a.shelfId);
    if (!it) return errors.push(`item ${a.key} desconhecido`);
    if (!slot) return errors.push(`prateleira ${a.shelfId} inexistente`);
    if (!unaryOk(it, slot.s)) errors.push(`item ${a.key}: categoria/zona não permitida na prateleira ${a.shelfId}`);
    slot.w -= it.weight;
    slot.v -= it.volume;
    if (slot.w < -EPS) errors.push(`prateleira ${a.shelfId}: peso máximo excedido`);
    if (slot.v < -EPS) errors.push(`prateleira ${a.shelfId}: volume máximo excedido`);
  });
  return errors;
}

module.exports = { solve, validate };

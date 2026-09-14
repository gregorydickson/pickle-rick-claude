const CARTESIAN_CAP = 256;
function edgeCondition(edge) {
    const attrs = typeof edge['attrs'] === 'object' && edge['attrs'] !== null
        ? edge['attrs']
        : null;
    const raw = attrs?.['condition'] ?? edge['condition'];
    return typeof raw === 'string' ? raw : null;
}
function parseConditions(condition) {
    const parsed = [];
    for (const rawClause of condition.split('&&')) {
        const clause = rawClause.trim();
        if (!clause)
            continue;
        const match = /^(?:context\.)?([A-Za-z_][A-Za-z0-9_.]*)\s*(=|!=)\s*(.+)$/.exec(clause);
        if (!match || match[1] === 'outcome')
            return null;
        parsed.push({
            key: match[1],
            operator: match[2],
            expectedValue: match[3],
        });
    }
    return parsed.length > 0 ? parsed : null;
}
function edgeId(edge) {
    if (typeof edge['id'] === 'string')
        return edge['id'];
    const src = (typeof edge['source'] === 'string' ? edge['source'] : null) ??
        (typeof edge['from'] === 'string' ? edge['from'] : null) ??
        '?';
    const tgt = (typeof edge['target'] === 'string' ? edge['target'] : null) ??
        (typeof edge['to'] === 'string' ? edge['to'] : null) ??
        '?';
    return `${src}->${tgt}`;
}
function nodeClass(node) {
    if (typeof node['class'] === 'string')
        return node['class'];
    const attrs = typeof node['attrs'] === 'object' && node['attrs'] !== null
        ? node['attrs']
        : null;
    return typeof attrs?.['class'] === 'string' ? attrs['class'] : null;
}
function cartesian(keySets) {
    if (keySets.length === 0)
        return [{}];
    const [[key, values], ...rest] = keySets;
    const subs = cartesian(rest);
    const result = [];
    for (const val of values) {
        for (const sub of subs) {
            result.push({ [key]: val, ...sub });
        }
    }
    return result;
}
function parseContextAssignments(raw) {
    const pairs = [];
    for (const kv of raw.split(',')) {
        const eq = kv.indexOf('=');
        if (eq < 0)
            continue;
        const k = kv.slice(0, eq).trim();
        const v = kv.slice(eq + 1).trim();
        if (k && v)
            pairs.push([k, v]);
    }
    return pairs;
}
function collectObservedValues(graph) {
    const observed = new Map();
    const rawAssignments = graph.nodes.flatMap((node) => [node['context_on_success'], node['context_on_failure']]);
    for (const raw of rawAssignments) {
        if (typeof raw !== 'string')
            continue;
        for (const [k, v] of parseContextAssignments(raw)) {
            const values = observed.get(k) ?? new Set();
            values.add(v);
            observed.set(k, values);
        }
    }
    return observed;
}
function sourceId(edge) {
    return (typeof edge['source'] === 'string' ? edge['source'] : null) ??
        (typeof edge['from'] === 'string' ? edge['from'] : null);
}
function collectConditionalOutgoingEdges(graph) {
    const outgoing = new Map();
    for (const edge of graph.edges) {
        const src = sourceId(edge);
        if (!src)
            continue;
        const condStr = edgeCondition(edge);
        if (!condStr)
            continue;
        const parsed = parseConditions(condStr);
        if (parsed === null)
            continue;
        if (!outgoing.has(src))
            outgoing.set(src, []);
        outgoing.get(src).push({ id: edgeId(edge), conditions: parsed });
    }
    return outgoing;
}
function collectDiamondIds(graph, outgoing) {
    const diamonds = new Set();
    for (const node of graph.nodes) {
        const id = typeof node['id'] === 'string' ? node['id'] : null;
        if (!id)
            continue;
        if (nodeClass(node) === 'diamond') {
            diamonds.add(id);
        }
        else if ((outgoing.get(id)?.length ?? 0) >= 2) {
            diamonds.add(id);
        }
    }
    return diamonds;
}
function keySetsForEdges(edges, observed) {
    const referencedKeys = [...new Set(edges.flatMap(edge => edge.conditions.map(condition => condition.key)))].sort();
    return referencedKeys.map(key => {
        if (key === 'outcome')
            return [key, ['fail', 'success', 'unset']];
        const obs = observed.get(key) ?? new Set();
        const expected = edges
            .flatMap(edge => edge.conditions
            .filter(condition => condition.key === key)
            .map(condition => condition.expectedValue));
        return [key, [...new Set([...obs, ...expected, 'unset'])].sort()];
    });
}
function buildTooComplexRow(diamond) {
    return {
        diamond,
        covered_states: [],
        stuck_states: [
            { cell: {}, matchingEdges: [], note: 'diamond too complex to enumerate mechanically' },
        ],
    };
}
function buildDiamondRow(diamond, edges, observed) {
    const keySets = keySetsForEdges(edges, observed);
    const totalCells = keySets.reduce((acc, [, vals]) => acc * vals.length, 1);
    if (totalCells > CARTESIAN_CAP)
        return buildTooComplexRow(diamond);
    const covered = [];
    const stuck = [];
    for (const cell of cartesian(keySets)) {
        const matching = edges
            .filter(edge => edge.conditions.every(condition => {
            const actual = cell[condition.key];
            return condition.operator === '='
                ? actual === condition.expectedValue
                : actual !== condition.expectedValue;
        }))
            .map(e => e.id)
            .sort();
        if (matching.length === 0) {
            stuck.push({ cell, matchingEdges: [] });
        }
        else {
            covered.push({ cell, matchingEdges: matching });
        }
    }
    return { diamond, covered_states: covered, stuck_states: stuck };
}
export function buildDiamondRouting(graph) {
    const outgoing = collectConditionalOutgoingEdges(graph);
    const observed = collectObservedValues(graph);
    const diamonds = collectDiamondIds(graph, outgoing);
    const rows = [];
    for (const diamond of [...diamonds].sort()) {
        const edges = outgoing.get(diamond);
        if (!edges || edges.length === 0)
            continue;
        rows.push(buildDiamondRow(diamond, edges, observed));
    }
    return rows;
}

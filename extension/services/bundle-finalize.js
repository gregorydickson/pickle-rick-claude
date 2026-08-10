const TEST_DELTA_PATTERN = /\btests:([+-]?\d+)\b/i;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const BASELINE_KEYS = new Set([
    'test_baseline',
    'tests_baseline',
    'baseline_test_count',
    'refinement_test_baseline',
]);
function finiteInteger(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.floor(value) !== value)
        return null;
    return value;
}
function parseScalarNumber(value) {
    const trimmed = value.trim().replace(/^["']|["']$/g, '');
    if (!/^[+-]?\d+$/.test(trimmed))
        return null;
    return Number(trimmed);
}
export function parseRefinementBaseline(markdown) {
    const match = FRONTMATTER_PATTERN.exec(markdown);
    if (!match)
        return null;
    for (const line of match[1].split(/\r?\n/)) {
        const keyValue = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (!keyValue)
            continue;
        const key = keyValue[1].toLowerCase();
        if (!BASELINE_KEYS.has(key))
            continue;
        return parseScalarNumber(keyValue[2]);
    }
    return null;
}
export function parseCommitTestDelta(commitMessage) {
    if (!commitMessage)
        return 0;
    const match = TEST_DELTA_PATTERN.exec(commitMessage);
    return match ? Number(match[1]) : 0;
}
function isDropped(ticket) {
    const status = ticket.status?.toLowerCase().trim();
    return status === 'dropped'
        || status === 'drop'
        || status === 'cancelled'
        || status === 'canceled'
        || status === 'skipped';
}
function isPreShipped(ticket) {
    return ticket.preShipped === true;
}
function resolveBaseline(input) {
    const direct = finiteInteger(input.baseline);
    if (direct !== null)
        return direct;
    if (input.refinementSummaryMarkdown !== undefined) {
        const parsed = parseRefinementBaseline(input.refinementSummaryMarkdown);
        if (parsed !== null)
            return parsed;
    }
    throw new Error('bundle test floor requires a refinement-time test baseline');
}
export function computeBundleTestFloor(input) {
    const baseline = resolveBaseline(input);
    const totalTestCount = finiteInteger(input.totalTestCount);
    const warnings = [];
    const contributions = input.tickets.map((ticket) => {
        if (isDropped(ticket)) {
            return { id: ticket.id, delta: 0, included: false, reason: 'dropped' };
        }
        if (isPreShipped(ticket)) {
            return { id: ticket.id, delta: 0, included: false, reason: 'pre_shipped' };
        }
        return {
            id: ticket.id,
            delta: parseCommitTestDelta(ticket.commitMessage),
            included: true,
            reason: 'scheduled',
        };
    });
    const delta = contributions.reduce((sum, contribution) => sum + contribution.delta, 0);
    if (delta < 0) {
        warnings.push(`net_delta_from_baseline clamped to 0 because scheduled test delta is ${delta}`);
    }
    const floor = baseline + delta;
    const rawNetDelta = totalTestCount === null ? delta : totalTestCount - baseline;
    const netDeltaFromBaseline = Math.max(0, rawNetDelta);
    const meetsFloor = totalTestCount === null ? null : totalTestCount >= floor;
    if (meetsFloor === false) {
        warnings.push(`total_test_count ${totalTestCount} is below bundle test floor ${floor}`);
    }
    return {
        baseline,
        delta,
        floor,
        totalTestCount,
        netDeltaFromBaseline,
        meetsFloor,
        warnings,
        contributions,
    };
}
function yamlStringList(values) {
    if (values.length === 0)
        return ['warnings: []'];
    return ['warnings:', ...values.map((value) => `  - ${JSON.stringify(value)}`)];
}
export function renderMorningSummaryFrontmatter(result, body = '') {
    const lines = [
        '---',
        `test_baseline: ${result.baseline}`,
        `test_delta: ${result.delta}`,
        `test_floor: ${result.floor}`,
        `total_test_count: ${result.totalTestCount ?? 'null'}`,
        `net_delta_from_baseline: ${result.netDeltaFromBaseline}`,
        `test_floor_met: ${result.meetsFloor ?? 'null'}`,
        ...yamlStringList(result.warnings),
        '---',
    ];
    return `${lines.join('\n')}\n${body}`;
}

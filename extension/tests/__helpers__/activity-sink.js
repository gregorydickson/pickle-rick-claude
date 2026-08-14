import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads the jsonl activity sink (`<dataRoot>/activity/*.jsonl`) and returns advisory
 * worker-gate residuals (`gate_skipped` events) matching the given discriminators.
 */
export function findResiduals({ dataRoot, ticketId, reason, site, verdict } = {}) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    const events = files
        .flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf-8').split(/\r?\n/).filter(Boolean))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    return events.filter((e) => {
        if (e.event !== 'gate_skipped') return false;
        if (ticketId !== undefined && e.ticket_id !== ticketId) return false;
        if (reason !== undefined && e.gate_payload?.reason !== reason) return false;
        if (site !== undefined && e.gate_payload?.site !== site) return false;
        if (verdict !== undefined && e.gate_payload?.verdict !== verdict) return false;
        return true;
    });
}

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
const OPEN_TIMEOUT_MS = 5_000;
function esc(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
const STRENGTH_CLASSES = {
    strong: 'bg-green-100 text-green-800',
    moderate: 'bg-yellow-100 text-yellow-800',
    speculative: 'bg-gray-100 text-gray-600',
};
function renderStrengthBadge(strength) {
    return `<span class="inline-block px-2 py-0.5 rounded text-xs font-semibold ${STRENGTH_CLASSES[strength]} capitalize">${esc(strength)}</span>`;
}
function renderListItems(items, cls) {
    return items.map(item => `<li class="${cls}">${esc(item)}</li>`).join('');
}
function sectionLabel(label) {
    return `<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">${label}</h3>`;
}
function renderDiagramSection(mermaidSource) {
    return [
        `<div>`,
        `  ${sectionLabel('Depth — Before / After Diagram')}`,
        `  <div class="mermaid bg-gray-50 p-3 rounded border border-gray-200 text-sm overflow-auto">`,
        `${esc(mermaidSource)}`,
        `  </div>`,
        `</div>`,
    ].join('\n');
}
function renderCandidateBody(c) {
    return [
        `<div class="mb-4">`,
        `  ${sectionLabel('Module — Files')}`,
        `  <ul class="list-disc list-inside space-y-0.5">${renderListItems(c.files, 'font-mono text-sm text-gray-700')}</ul>`,
        `</div>`,
        `<div class="mb-4">`,
        `  ${sectionLabel('Interface — Problem')}`,
        `  <p class="text-gray-700">${esc(c.problem)}</p>`,
        `</div>`,
        `<div class="mb-4">`,
        `  ${sectionLabel('Adapter — Solution')}`,
        `  <p class="text-gray-700">${esc(c.solution)}</p>`,
        `</div>`,
        `<div class="mb-4">`,
        `  ${sectionLabel('Leverage / Locality — Benefits')}`,
        `  <ul class="list-disc list-inside space-y-0.5">${renderListItems(c.benefits, 'text-gray-700')}</ul>`,
        `</div>`,
        renderDiagramSection(c.beforeAfterDiagram),
    ].join('\n');
}
function renderCandidateArticle(c) {
    return [
        `<article class="bg-white rounded-lg shadow p-6 mb-6 border border-gray-200">`,
        `  <div class="flex items-start justify-between mb-4">`,
        `    <h2 class="text-lg font-semibold text-gray-900">${esc(c.id)}</h2>`,
        `    ${renderStrengthBadge(c.strength)}`,
        `  </div>`,
        renderCandidateBody(c),
        `</article>`,
    ].join('\n');
}
function isFullCandidate(rec) {
    return 'problem' in rec;
}
function renderTopRefCard(ref) {
    return [
        `<p class="text-indigo-800 mb-2">`,
        `  <span class="font-semibold">Candidate:</span> ${esc(ref.candidateId)}`,
        `</p>`,
        `<p class="text-indigo-800">`,
        `  <span class="font-semibold">Rationale:</span> ${esc(ref.rationale)}`,
        `</p>`,
    ].join('\n');
}
function renderTopRecommendationContent(rec) {
    if (isFullCandidate(rec)) {
        return renderCandidateArticle(rec);
    }
    return renderTopRefCard(rec);
}
function renderCandidatesSection(candidates) {
    return [
        `<section class="mb-12">`,
        `  <h2 class="text-xl font-semibold text-gray-700 mb-6">Refactoring Candidates</h2>`,
        candidates.map(renderCandidateArticle).join('\n'),
        `</section>`,
    ].join('\n');
}
function renderTopSection(rec) {
    return [
        `<section id="top-recommendation" class="border-2 border-indigo-400 rounded-lg p-6 bg-indigo-50 mt-8">`,
        `  <h2 class="text-xl font-semibold text-indigo-900 mb-4">Top Recommendation — Architectural Seam</h2>`,
        renderTopRecommendationContent(rec),
        `</section>`,
    ].join('\n');
}
function renderMermaidScript() {
    return [
        `<script type="module">`,
        `  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';`,
        `  mermaid.initialize({ theme: 'neutral', securityLevel: 'loose' });`,
        `  await mermaid.run();`,
        `</script>`,
    ].join('\n');
}
export function renderDeathCrystalReport(report) {
    return [
        `<!DOCTYPE html>`,
        `<html lang="en">`,
        `<head>`,
        `  <meta charset="UTF-8">`,
        `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
        `  <title>Architecture Review — Death Crystal</title>`,
        `  <script src="https://cdn.tailwindcss.com"></script>`,
        `</head>`,
        `<body class="bg-gray-50 min-h-screen font-sans">`,
        `  <div class="max-w-4xl mx-auto py-10 px-4">`,
        `    <header class="mb-10">`,
        `      <h1 class="text-3xl font-bold text-gray-900">Architecture Review</h1>`,
        `      <p class="text-sm text-gray-500 mt-1">Generated: ${esc(report.generatedAt)}</p>`,
        `    </header>`,
        renderCandidatesSection(report.candidates),
        renderTopSection(report.topRecommendation),
        `  </div>`,
        renderMermaidScript(),
        `</body>`,
        `</html>`,
    ].join('\n');
}
function sanitizeForFilename(s) {
    return s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'unknown';
}
/**
 * Writes the report and NOTHING else. The browser hand-off used to live inside this
 * function, which made a `write*` name lie about what it did and gave every caller a
 * desktop side effect it could neither see nor decline. Opening is now its own named
 * export (`openDeathCrystalReport`) so the call site states it.
 */
export function writeDeathCrystalReport(sessionRoot, report) {
    const dir = path.join(sessionRoot, 'death-crystal');
    fs.mkdirSync(dir, { recursive: true });
    const ts = sanitizeForFilename(report.generatedAt);
    const htmlFile = `architecture-review-${ts}.html`;
    const htmlPath = path.join(dir, htmlFile);
    const symlinkPath = path.join(dir, 'latest.html');
    fs.writeFileSync(htmlPath, renderDeathCrystalReport(report), 'utf-8');
    try {
        fs.unlinkSync(symlinkPath);
    }
    catch { }
    fs.symlinkSync(htmlFile, symlinkPath);
    return { htmlPath, symlinkPath };
}
/** Hands `htmlPath` to the platform opener. Best-effort: a headless box has no opener. */
export function openDeathCrystalReport(htmlPath) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [htmlPath], { timeout: OPEN_TIMEOUT_MS });
}

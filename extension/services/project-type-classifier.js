import * as fs from 'node:fs';
import * as path from 'node:path';
export const PROJECT_TYPE_CATEGORIES = [
    'web',
    'mobile',
    'backend',
    'cli',
    'library',
    'desktop',
    'game',
    'data',
    'extension',
    'infra/embedded',
];
const CSV_COLUMNS = [
    'category',
    'label',
    'description',
    'file_patterns',
    'directory_patterns',
    'package_keywords',
];
const IGNORED_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.next',
    '.turbo',
    'vendor',
]);
export function getProjectTypesCsvPath(extensionRoot) {
    return path.join(extensionRoot, 'extension', 'data', 'project-types.csv');
}
export function loadProjectTypeDefinitions(extensionRoot) {
    const registryPath = getProjectTypesCsvPath(extensionRoot);
    const rows = parseCsv(fs.readFileSync(registryPath, 'utf8'));
    return rows.map(definitionFromRow);
}
export function classifyProjectType(projectRoot, options) {
    const registryPath = getProjectTypesCsvPath(options.extensionRoot);
    const definitions = loadProjectTypeDefinitions(options.extensionRoot);
    const files = listProjectFiles(projectRoot, options.maxFiles ?? 2_000);
    const packageKeywords = readPackageKeywords(projectRoot);
    const scores = definitions
        .map((definition) => scoreDefinition(definition, files, packageKeywords))
        .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
    const best = scores[0] ?? emptyScore('library');
    return {
        category: best.category,
        confidence: confidenceFor(best, scores[1]),
        reason: reasonFor(best),
        registryPath,
        scores,
    };
}
function definitionFromRow(row) {
    const category = row.category;
    if (!isProjectTypeCategory(category)) {
        throw new Error(`Unknown project type category in project-types.csv: ${category}`);
    }
    return {
        category,
        label: row.label,
        description: row.description,
        filePatterns: splitCell(row.file_patterns),
        directoryPatterns: splitCell(row.directory_patterns),
        packageKeywords: splitCell(row.package_keywords).map((keyword) => keyword.toLowerCase()),
    };
}
// A package dependency is the strongest signal, a named file next, a directory name weakest.
const FILE_MATCH_WEIGHT = 5;
const DIRECTORY_MATCH_WEIGHT = 2;
const PACKAGE_MATCH_WEIGHT = 8;
// 'high' needs a strong score AND a clear lead over the runner-up; 'medium' needs a strong score alone.
const HIGH_CONFIDENCE_MIN_SCORE = 30;
const HIGH_CONFIDENCE_MIN_LEAD = 10;
const MEDIUM_CONFIDENCE_MIN_SCORE = 15;
function scoreDefinition(definition, files, packageKeywords) {
    const matchedFiles = unique(files.filter((file) => definition.filePatterns.some((pattern) => matchesPattern(file, pattern))));
    const matchedDirectories = unique(files.flatMap((file) => matchingDirectories(file, definition.directoryPatterns)));
    const matchedPackages = definition.packageKeywords.filter((keyword) => packageKeywords.has(keyword));
    return {
        category: definition.category,
        score: matchedFiles.length * FILE_MATCH_WEIGHT +
            matchedDirectories.length * DIRECTORY_MATCH_WEIGHT +
            matchedPackages.length * PACKAGE_MATCH_WEIGHT,
        matchedFiles,
        matchedDirectories,
        matchedPackages,
    };
}
function listProjectFiles(projectRoot, maxFiles) {
    const files = [];
    const stack = [''];
    while (stack.length > 0 && files.length < maxFiles) {
        const relativeDir = stack.pop() ?? '';
        const absoluteDir = path.join(projectRoot, relativeDir);
        for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
            const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
            collectEntry(entry, relativePath, stack, files);
            if (files.length >= maxFiles)
                break;
        }
    }
    return files;
}
function collectEntry(entry, relativePath, stack, files) {
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name.toLowerCase())) {
        stack.push(relativePath);
        return;
    }
    if (entry.isFile())
        files.push(relativePath);
}
function readPackageKeywords(projectRoot) {
    const packagePath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(packagePath))
        return new Set();
    try {
        const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return new Set([
            ...Object.keys(manifest.dependencies ?? {}),
            ...Object.keys(manifest.devDependencies ?? {}),
            ...Object.keys(manifest.peerDependencies ?? {}),
            ...(manifest.keywords ?? []),
        ].map((keyword) => keyword.toLowerCase()));
    }
    catch {
        return new Set();
    }
}
function matchingDirectories(file, patterns) {
    const parts = file.split('/').slice(0, -1).map((part) => part.toLowerCase());
    return patterns.filter((pattern) => parts.includes(pattern.toLowerCase()));
}
function matchesPattern(file, pattern) {
    const normalizedFile = file.toLowerCase();
    const normalizedPattern = pattern.toLowerCase().replaceAll('\\', '/');
    if (normalizedPattern.includes('*'))
        return globLikeMatch(normalizedFile, normalizedPattern);
    if (normalizedPattern.includes('/'))
        return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
    return path.posix.basename(normalizedFile) === normalizedPattern;
}
function globLikeMatch(file, pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`).test(file);
}
function confidenceFor(best, runnerUp) {
    const hasClearLead = !runnerUp || best.score >= runnerUp.score + HIGH_CONFIDENCE_MIN_LEAD;
    if (best.score >= HIGH_CONFIDENCE_MIN_SCORE && hasClearLead)
        return 'high';
    if (best.score >= MEDIUM_CONFIDENCE_MIN_SCORE)
        return 'medium';
    return 'low';
}
function reasonFor(score) {
    const parts = [
        `${score.matchedFiles.length} file-pattern matches`,
        `${score.matchedDirectories.length} directory matches`,
        `${score.matchedPackages.length} package matches`,
    ];
    return parts.join(', ');
}
function splitCell(value) {
    return value.split(';').map((part) => part.trim()).filter(Boolean);
}
function unique(values) {
    return [...new Set(values)];
}
function emptyScore(category) {
    return { category, score: 0, matchedFiles: [], matchedDirectories: [], matchedPackages: [] };
}
function isProjectTypeCategory(value) {
    return PROJECT_TYPE_CATEGORIES.includes(value);
}
function parseCsv(input) {
    const rows = input.trim().split(/\r?\n/).map(parseCsvLine);
    const header = rows.shift();
    if (!header || header.join(',') !== CSV_COLUMNS.join(',')) {
        throw new Error(`project-types.csv header must be: ${CSV_COLUMNS.join(',')}`);
    }
    return rows.map((row) => Object.fromEntries(header.map((column, index) => [column, row[index] ?? ''])));
}
function parseCsvLine(line) {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            quoted = !quoted;
        }
        else if (char === ',' && !quoted) {
            cells.push(current);
            current = '';
        }
        else {
            current += char;
        }
    }
    cells.push(current);
    return cells;
}

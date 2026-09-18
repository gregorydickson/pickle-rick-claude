#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getDataRoot, getExtensionRoot, safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
const CACHE_FILE = 'update-check.json';
const SETTINGS_FILE = 'pickle_settings.json';
const DEBUG_LOG = 'debug.log';
// AP-EXT-ITER94-01: a RUNAWAY BACKSTOP for the installer spawn below, not a schedule.
// The upgrade payload has no `.git`, so `install.sh` takes its TARBALL branch, whose
// mandatory step is a NETWORKED `npm install @colbymchenry/codegraph@0.9.9` at the deploy
// root — measured 46 MB fetched, unpacking to 181 MB, on EVERY upgrade (the rsync above it
// runs `--delete-excluded`, so `node_modules` is rebuilt each run). The former 30s needed
// >12 Mbps sustained before a single local step, and this repo's own harness for the same
// script uses 600_000 after 120_000 was measured a false-failure source (fde629a7: ~95s on
// the operator host, observed failing twice). A cap that fires lands MID-DEPLOY: the rsync
// has already published the new JS and the new `extension/package.json`, so
// `getCurrentVersion()` reports the new version and `checkForUpdate` never retries, while
// every step after the npm install — the codegraph self-probe, MANAGED_KEYS, the commands
// rsync and all three hook registrations — never ran.
const INSTALL_SCRIPT_TIMEOUT_MS = 600_000;
function log(message) {
    try {
        const extensionRoot = getExtensionRoot();
        const timestamp = new Date().toISOString();
        fs.appendFileSync(path.join(extensionRoot, DEBUG_LOG), `[${timestamp}] [check-update] ${message}\n`);
    }
    catch {
        /* fail-open */
    }
}
// Release `X.Y.Z` or prerelease `X.Y.Z-<ident>.<N>` (e.g. 2.0.0-beta.1).
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/;
function parseSemverParts(version) {
    const match = SEMVER_RE.exec(version);
    if (!match)
        return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] !== undefined ? { ident: match[4], num: Number(match[5]) } : null,
    };
}
export function parseVersion(tag) {
    if (!tag)
        return null;
    const stripped = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!parseSemverParts(stripped))
        return null;
    return stripped;
}
function comparePrerelease(a, b) {
    if (!a && !b)
        return 0;
    if (!a)
        return 1; // release > prerelease of the same triple
    if (!b)
        return -1;
    if (a.ident !== b.ident)
        return a.ident < b.ident ? -1 : 1;
    if (a.num !== b.num)
        return a.num < b.num ? -1 : 1;
    return 0;
}
export function compareSemver(a, b) {
    const normalizedA = parseVersion(a);
    const normalizedB = parseVersion(b);
    const parsedA = normalizedA ? parseSemverParts(normalizedA) : null;
    const parsedB = normalizedB ? parseSemverParts(normalizedB) : null;
    if (!parsedA || !parsedB) {
        throw new Error(`Invalid semver comparison: '${a}' vs '${b}'`);
    }
    const partsA = [parsedA.major, parsedA.minor, parsedA.patch];
    const partsB = [parsedB.major, parsedB.minor, parsedB.patch];
    for (let i = 0; i < 3; i++) {
        if (partsA[i] < partsB[i])
            return -1;
        if (partsA[i] > partsB[i])
            return 1;
    }
    return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}
export class BlockedDowngradeError extends Error {
    candidate;
    current;
    constructor(candidate, current) {
        super(`Refusing to install downgrade candidate ${candidate} over current ${current}`);
        this.name = 'BlockedDowngradeError';
        this.candidate = candidate;
        this.current = current;
    }
}
function defaultCache() {
    return { last_check_epoch: 0, latest_version: '', current_version: '' };
}
export function readCache() {
    try {
        const filePath = path.join(getExtensionRoot(), CACHE_FILE);
        const raw = readRecoverableJsonObject(filePath);
        if (!raw) {
            log('Cache missing or corrupted, using defaults');
            return defaultCache();
        }
        const latestVersion = typeof raw.latest_version === 'string' ? parseVersion(raw.latest_version) ?? '' : '';
        const currentVersion = typeof raw.current_version === 'string' ? parseVersion(raw.current_version) ?? '' : '';
        const cacheVersionsValid = latestVersion !== '' && currentVersion !== '';
        return {
            last_check_epoch: cacheVersionsValid && typeof raw.last_check_epoch === 'number' ? raw.last_check_epoch : 0,
            latest_version: latestVersion,
            current_version: currentVersion,
        };
    }
    catch {
        log('Cache missing or corrupted, using defaults');
        return defaultCache();
    }
}
export function writeCache(cache) {
    const filePath = path.join(getExtensionRoot(), CACHE_FILE);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2) + '\n');
        fs.renameSync(tmpPath, filePath);
        log(`Cache written: ${cache.latest_version}`);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore cleanup failure */ }
        const msg = safeErrorMessage(err);
        log(`Failed to write cache: ${msg}`);
    }
}
export function readSettings() {
    const defaults = {
        auto_update_enabled: true,
        update_check_interval_hours: 24,
    };
    try {
        const filePath = path.join(getExtensionRoot(), SETTINGS_FILE);
        const raw = readRecoverableJsonObject(filePath);
        if (!raw)
            return defaults;
        if (typeof raw.auto_update_enabled === 'boolean') {
            defaults.auto_update_enabled = raw.auto_update_enabled;
        }
        if (typeof raw.update_check_interval_hours === 'number' && Number.isFinite(raw.update_check_interval_hours) && raw.update_check_interval_hours > 0) {
            defaults.update_check_interval_hours = raw.update_check_interval_hours;
        }
        return defaults;
    }
    catch {
        log('Settings missing or corrupted, using defaults');
        return defaults;
    }
}
export function isCacheStale(cache, intervalHours) {
    if (cache.last_check_epoch === 0)
        return true;
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (cache.last_check_epoch > nowEpoch)
        return true;
    const intervalSeconds = intervalHours * 3600;
    return (nowEpoch - cache.last_check_epoch) >= intervalSeconds;
}
export function getLatestRelease() {
    try {
        const result = spawnSync('gh', [
            'api', 'repos/gregorydickson/pickle-rick-claude/releases/latest',
            '--jq', '{tag_name: .tag_name, assets: [.assets[] | {name: .name, url: .browser_download_url}]}',
        ], { encoding: 'utf-8', timeout: 15_000 });
        if (result.status !== 0) {
            log(`gh api failed: ${(result.stderr || '').trim()}`);
            return null;
        }
        const parsed = JSON.parse(result.stdout);
        return {
            tagName: parsed.tag_name,
            assets: Array.isArray(parsed.assets) ? parsed.assets : [],
        };
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`getLatestRelease error: ${msg}`);
        return null;
    }
}
export function getCurrentVersion() {
    try {
        const pkgPath = path.join(getExtensionRoot(), 'extension', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    }
    catch {
        log('Could not read package.json version');
        return '0.0.0';
    }
}
export function downloadRelease(tag) {
    let tmpDir = '';
    try {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-update-')));
        log(`Downloading release ${tag} to ${tmpDir}`);
        const result = spawnSync('gh', [
            'release', 'download', tag,
            '-R', 'gregorydickson/pickle-rick-claude',
            '-p', '*.tar.gz',
            '-D', tmpDir,
        ], { encoding: 'utf-8', timeout: 60_000 });
        if (result.status !== 0) {
            log(`gh release download failed: ${(result.stderr || '').trim()}`);
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return null;
        }
        const files = fs.readdirSync(tmpDir)
            .filter((file) => file.endsWith('.tar.gz'))
            .map((file) => path.join(tmpDir, file));
        if (files.length === 0) {
            log('No .tar.gz asset found in downloaded release');
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return null;
        }
        const installable = files.filter(isInstallableReleaseTarball);
        if (installable.length !== 1) {
            log(installable.length === 0
                ? 'No installable tar.gz asset found in downloaded release'
                : 'Multiple installable tar.gz assets found in downloaded release');
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return null;
        }
        return installable[0];
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`downloadRelease error: ${msg}`);
        if (tmpDir) {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
            catch { /* best-effort */ }
        }
        return null;
    }
}
function isInstallableReleaseTarball(tarballPath) {
    const payloadRoot = resolveInstallablePayloadRoot(tarballPath);
    return payloadRoot !== null;
}
function listTarballMembers(tarballPath) {
    const tar = spawnSync('tar', ['-tzf', tarballPath], {
        encoding: 'utf-8',
        timeout: 30_000,
    });
    if (tar.status !== 0)
        return null;
    return (tar.stdout || '').split(/\r?\n/).filter(Boolean);
}
function normalizeTarMember(member) {
    return member.replace(/^\.\/+/, '').replace(/\/+$/, '');
}
function payloadRootForMember(member, suffix) {
    const normalized = normalizeTarMember(member);
    if (normalized === suffix)
        return '';
    const marker = `/${suffix}`;
    return normalized.endsWith(marker)
        ? normalized.slice(0, -marker.length)
        : null;
}
function resolveInstallablePayloadRoot(tarballPath) {
    const members = listTarballMembers(tarballPath);
    if (!members)
        return null;
    const packageRoots = new Set();
    const installRoots = new Set();
    for (const member of members) {
        const packageRoot = payloadRootForMember(member, 'extension/package.json');
        if (packageRoot !== null)
            packageRoots.add(packageRoot);
        const installRoot = payloadRootForMember(member, 'install.sh');
        if (installRoot !== null)
            installRoots.add(installRoot);
    }
    const sharedRoots = [...packageRoots].filter((root) => installRoots.has(root));
    return sharedRoots.length === 1 ? sharedRoots[0] : null;
}
function extractInstallablePayload(tarballPath, extractDir) {
    const payloadRoot = resolveInstallablePayloadRoot(tarballPath);
    if (payloadRoot === null) {
        return {
            success: false,
            error: 'Release tarball must contain exactly one payload root shared by extension/package.json and install.sh',
        };
    }
    const tarArgs = ['xzf', tarballPath, '-C', extractDir];
    if (payloadRoot !== '') {
        tarArgs.push('--strip-components=1', payloadRoot);
    }
    const tar = spawnSync('tar', tarArgs, {
        encoding: 'utf-8',
        timeout: 30_000,
    });
    if (tar.status === 0)
        return { success: true };
    const msg = (tar.stderr || '').trim();
    return { success: false, error: `Extraction failed: ${msg}` };
}
function cleanupDownloadedRelease(tarballPath, extractDir) {
    try {
        fs.rmSync(path.dirname(tarballPath), { recursive: true, force: true });
    }
    catch { /* best-effort */ }
    if (extractDir) {
        try {
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
        catch { /* best-effort */ }
    }
}
function extractReleaseForInspection(tarballPath) {
    const extractDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-extract-')));
    try {
        log(`Inspecting ${tarballPath} in ${extractDir}`);
        const extracted = extractInstallablePayload(tarballPath, extractDir);
        if (!extracted.success)
            throw new Error(extracted.error);
        const pkgPath = path.join(extractDir, 'extension', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const version = typeof pkg.version === 'string' ? parseVersion(pkg.version) : null;
        if (!version) {
            throw new Error('Release package.json has invalid version');
        }
        return { extractDir, version };
    }
    catch (err) {
        try {
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
        catch { /* best-effort */ }
        throw err;
    }
}
function extractReleaseForInstall(tarballPath) {
    const extractDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-extract-')));
    log(`Extracting ${tarballPath} to ${extractDir}`);
    const extracted = extractInstallablePayload(tarballPath, extractDir);
    if (extracted.success)
        return { extractDir };
    log(extracted.error);
    return { extractDir, error: extracted.error };
}
function runReleaseInstallScript(extractDir) {
    const installScript = path.join(extractDir, 'install.sh');
    if (!fs.existsSync(installScript)) {
        log('install.sh not found in extracted tarball');
        return { success: false, error: 'install.sh not found in release' };
    }
    log('Running install.sh');
    const install = spawnSync('bash', ['install.sh'], {
        cwd: extractDir,
        encoding: 'utf-8',
        timeout: INSTALL_SCRIPT_TIMEOUT_MS,
    });
    if (install.status === 0) {
        log('install.sh completed successfully');
        return { success: true };
    }
    const msg = (install.stderr || '').trim();
    log(`install.sh failed (exit ${install.status}): ${msg}`);
    return { success: false, error: `install.sh failed (exit ${install.status})` };
}
export function extractAndInstall(tarballPath, preExtractedDir) {
    const tarballDir = path.dirname(tarballPath);
    let extractDir = '';
    try {
        if (preExtractedDir) {
            extractDir = preExtractedDir;
            log(`Installing pre-extracted release from ${extractDir}`);
        }
        else {
            const extracted = extractReleaseForInstall(tarballPath);
            extractDir = extracted.extractDir;
            if (extracted.error)
                return { success: false, error: extracted.error };
        }
        return runReleaseInstallScript(extractDir);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`extractAndInstall error: ${msg}`);
        return { success: false, error: msg };
    }
    finally {
        try {
            fs.rmSync(tarballDir, { recursive: true, force: true });
        }
        catch { /* best-effort */ }
        if (extractDir) {
            try {
                fs.rmSync(extractDir, { recursive: true, force: true });
            }
            catch { /* best-effort */ }
        }
    }
}
function findActiveSession() {
    const sessionsRoot = path.join(getDataRoot(), 'sessions');
    let sessionDirs;
    try {
        sessionDirs = fs.readdirSync(sessionsRoot);
    }
    catch {
        return null;
    }
    for (const sessionDir of sessionDirs) {
        const statePath = path.join(sessionsRoot, sessionDir, 'state.json');
        try {
            const state = readRecoverableJsonObject(statePath);
            if (!state)
                continue;
            if (state.active === true) {
                return {
                    id: typeof state.session_id === 'string' && state.session_id ? state.session_id : sessionDir,
                };
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
function auditLogPath() {
    const installRoot = process.env.PICKLE_INSTALL_ROOT && process.env.PICKLE_INSTALL_ROOT.trim() !== ''
        ? process.env.PICKLE_INSTALL_ROOT
        : path.join(os.homedir(), '.claude', 'pickle-rick');
    return path.join(installRoot, 'deploy-audit.log');
}
function appendDowngradeAudit(srcVersion, depVersion, options, sessionId) {
    const filePath = auditLogPath();
    const existed = fs.existsSync(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const entry = {
        event: 'DOWNGRADE',
        src_version: srcVersion,
        dep_version: depVersion,
        ts: new Date().toISOString(),
        operator: process.env.USER || process.env.LOGNAME || '',
        invocation: process.argv.join(' '),
        session_id: sessionId,
        override_active: options.overrideActive === true,
        no_confirm: options.noConfirm === true,
        closer_context: options.closerContext === true,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (!existed) {
        fs.chmodSync(filePath, 0o600);
    }
}
function confirmDowngrade(srcVersion, depVersion) {
    process.stderr.write(`Downgrade ${depVersion} → ${srcVersion} — proceed? [y/N] `);
    try {
        const chunks = [];
        const buffer = Buffer.alloc(1);
        while (chunks.length < 1024) {
            const bytesRead = fs.readSync(0, buffer, 0, 1, null);
            if (bytesRead === 0)
                break;
            const char = buffer.toString('utf-8', 0, bytesRead);
            if (char === '\n' || char === '\r')
                break;
            chunks.push(char);
        }
        const answer = chunks.join('').trim();
        return answer === 'y' || answer === 'Y';
    }
    catch {
        return false;
    }
}
function evaluateDowngradeUx(srcVersion, depVersion, options) {
    const activeSession = findActiveSession();
    if (activeSession && options.overrideActive !== true && options.closerContext !== true) {
        const error = `REFUSE: active session ${activeSession.id} — kill the pipeline first or pass --override-active`;
        process.stderr.write(`${error}\n`);
        return { success: false, error, exitCode: 2 };
    }
    if (options.noConfirm !== true && !confirmDowngrade(srcVersion, depVersion)) {
        return { success: true, aborted: true };
    }
    appendDowngradeAudit(srcVersion, depVersion, options, activeSession?.id ?? null);
    return null;
}
function inspectReleaseForUpgrade(tarballPath, options) {
    try {
        const inspected = extractReleaseForInspection(tarballPath);
        const currentVersion = getCurrentVersion();
        if (compareSemver(inspected.version, currentVersion) >= 0) {
            return { inspected };
        }
        if (options?.allowDowngrade !== true) {
            cleanupDownloadedRelease(tarballPath, inspected.extractDir);
            throw new BlockedDowngradeError(inspected.version, currentVersion);
        }
        const downgradeUxResult = evaluateDowngradeUx(inspected.version, currentVersion, options);
        if (downgradeUxResult) {
            cleanupDownloadedRelease(tarballPath, inspected.extractDir);
            return { result: downgradeUxResult };
        }
        return { inspected };
    }
    catch (err) {
        if (err instanceof BlockedDowngradeError)
            throw err;
        cleanupDownloadedRelease(tarballPath);
        const msg = safeErrorMessage(err);
        log(`Release inspection failed: ${msg}`);
        return { result: { success: false, error: msg } };
    }
}
function updateCacheAfterInstall(to) {
    writeCache({
        last_check_epoch: Math.floor(Date.now() / 1000),
        latest_version: to,
        current_version: getCurrentVersion(),
    });
}
export function performUpgrade(from, to, tag, options) {
    try {
        const settings = readSettings();
        if (!settings.auto_update_enabled && !options?.force) {
            log('Auto-update disabled in settings; refusing performUpgrade');
            return { success: false, error: 'Auto-update disabled in pickle_settings.json' };
        }
        log(`Starting upgrade: ${from} → ${to} (${tag})`);
        const tarballPath = downloadRelease(tag);
        if (!tarballPath) {
            return { success: false, error: 'Failed to download release' };
        }
        const inspection = inspectReleaseForUpgrade(tarballPath, options);
        if ('result' in inspection)
            return inspection.result;
        const result = extractAndInstall(tarballPath, inspection.inspected.extractDir);
        if (!result.success) {
            return result;
        }
        updateCacheAfterInstall(to);
        process.stderr.write(`🥒 Pickle Rick upgraded: v${from} → v${to}\n`);
        log(`Upgrade complete: ${from} → ${to}`);
        return { success: true };
    }
    catch (err) {
        if (err instanceof BlockedDowngradeError) {
            log(`performUpgrade downgrade blocked: candidate=${err.candidate} current=${err.current}`);
            throw err;
        }
        const msg = safeErrorMessage(err);
        log(`performUpgrade error: ${msg}`);
        return { success: false, error: msg };
    }
}
function checkFreshCache(currentVersion, cache) {
    log('Cache is fresh, using cached result');
    if (cache.latest_version && compareSemver(currentVersion, cache.latest_version) < 0) {
        return { status: 'update-available', currentVersion, latestVersion: cache.latest_version };
    }
    return { status: 'up-to-date', currentVersion };
}
function fetchLatestVersion(currentVersion) {
    log('Cache stale or forced, fetching latest release');
    const release = getLatestRelease();
    if (!release) {
        return { status: 'error', currentVersion, error: 'Failed to fetch latest release' };
    }
    const latestVersion = parseVersion(release.tagName);
    if (!latestVersion) {
        return { status: 'error', currentVersion, error: `Invalid release tag: ${release.tagName}` };
    }
    writeCache({
        last_check_epoch: Math.floor(Date.now() / 1000),
        latest_version: latestVersion,
        current_version: currentVersion,
    });
    return { latestVersion, tagName: release.tagName };
}
function applyAvailableUpdate(currentVersion, latestVersion, tagName, options) {
    if (compareSemver(currentVersion, latestVersion) >= 0) {
        log(`Up to date: ${currentVersion}`);
        return { status: 'up-to-date', currentVersion, latestVersion };
    }
    log(`Update available: ${currentVersion} → ${latestVersion}`);
    const upgrade = performUpgrade(currentVersion, latestVersion, tagName, { force: options?.force });
    if (upgrade.success) {
        return { status: 'up-to-date', currentVersion: latestVersion, latestVersion };
    }
    return { status: 'update-available', currentVersion, latestVersion };
}
export function checkForUpdate(options) {
    const currentVersion = getCurrentVersion();
    const errorResult = { status: 'error', currentVersion };
    try {
        const settings = readSettings();
        if (!settings.auto_update_enabled && !options?.force) {
            log('Auto-update disabled in settings');
            return { status: 'up-to-date', currentVersion };
        }
        const cache = readCache();
        if (!options?.force && !isCacheStale(cache, settings.update_check_interval_hours)) {
            return checkFreshCache(currentVersion, cache);
        }
        const latest = fetchLatestVersion(currentVersion);
        if ('status' in latest) {
            return latest;
        }
        return applyAvailableUpdate(currentVersion, latest.latestVersion, latest.tagName, options);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`checkForUpdate error: ${msg}`);
        return { ...errorResult, error: msg };
    }
}
function parseCliArgs(args) {
    const parsed = { upgrade: false };
    for (const arg of args) {
        switch (arg) {
            case '--force':
                parsed.force = true;
                break;
            case '--upgrade':
                parsed.upgrade = true;
                break;
            case '--allow-downgrade':
                parsed.allowDowngrade = true;
                break;
            case '--override-active':
                parsed.overrideActive = true;
                break;
            case '--no-confirm':
                parsed.noConfirm = true;
                break;
            case '--closer-context':
                parsed.closerContext = true;
                break;
            default:
                throw new Error(`Unknown flag: ${arg}`);
        }
    }
    return parsed;
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-update.js') {
    let cliOptions;
    try {
        cliOptions = parseCliArgs(process.argv.slice(2));
    }
    catch (err) {
        console.error(safeErrorMessage(err));
        process.exit(1);
    }
    if (cliOptions.upgrade) {
        const current = getCurrentVersion();
        const release = getLatestRelease();
        if (!release) {
            console.error('Failed to fetch latest release');
            process.exit(1);
        }
        const latest = parseVersion(release.tagName);
        if (!latest || compareSemver(current, latest) >= 0) {
            console.log(JSON.stringify({ status: 'up-to-date', currentVersion: current }));
        }
        else {
            const upgrade = performUpgrade(current, latest, release.tagName, cliOptions);
            console.log(JSON.stringify(upgrade, null, 2));
            process.exit(upgrade.success ? 0 : upgrade.exitCode ?? 1);
        }
    }
    else {
        const result = checkForUpdate({ force: cliOptions.force });
        console.log(JSON.stringify(result, null, 2));
    }
}

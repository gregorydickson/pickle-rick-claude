import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ChangedFileSummary, DiffSummary } from './diff-walker.js';
import { ProjectShape } from './project-shape.js';
import { CitadelSeverity, escapeTableCell, slugify, uniqueSortedStrings } from './reporter.js';

export type SiblingAuthSeverity = 'Critical' | 'High' | 'Medium';

const PARITY_SEVERITY: CitadelSeverity = 'Medium';

export interface SiblingAuthEvidence {
  file: string;
  line: number;
  text: string;
}

export interface ControllerRoute {
  file: string;
  line: number;
  controllerPath: string;
  methodName: string;
  httpMethod: string;
  methodPath: string;
  fullPath: string;
  resourcePrefix: string;
  guardPrefix: string[];
  roles: string[];
  destructive: boolean;
}

export interface GuardParityFinding {
  id: string;
  severity: CitadelSeverity;
  message: string;
  controller: string;
  resourcePrefix: string;
  methods: string[];
  missingGuards: string[];
  evidence: SiblingAuthEvidence[];
}

export interface DestructiveRoleFinding {
  id: string;
  severity: 'Critical' | 'High';
  message: string;
  controller: string;
  methods: string[];
  roleAllowlists: Array<{
    method: string;
    roles: string[];
  }>;
  evidence: SiblingAuthEvidence[];
}

export interface WeakerDestructiveRoleFinding {
  id: string;
  severity: 'High';
  message: string;
  controller: string;
  method: string;
  roles: string[];
  stricterSiblingMethod: string;
  stricterSiblingRoles: string[];
  evidence: SiblingAuthEvidence[];
}

export interface SiblingAuthAuditOptions {
  /** Detected project shapes; the destructive-verb weaker-@Roles check is gated on `nestjs-api`. */
  projectShapes?: ProjectShape[];
}

export interface SiblingAuthAuditReport {
  routes: ControllerRoute[];
  guardParityFindings: GuardParityFinding[];
  destructiveRoleFindings: DestructiveRoleFinding[];
  weakerDestructiveRoleFindings: WeakerDestructiveRoleFinding[];
  findings: Array<GuardParityFinding | DestructiveRoleFinding | WeakerDestructiveRoleFinding>;
  destructiveRoleDriftTable: string;
  summary: {
    controllers: number;
    routes: number;
    guardParityFindings: number;
    destructiveRoleFindings: number;
    weakerDestructiveRoleFindings: number;
  };
}

interface SourceFile {
  path: string;
  lines: string[];
}

interface BraceScanState {
  inBlockComment: boolean;
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
  inTemplateLiteral: boolean;
  templateExpressionDepth: number;
}

interface DecoratorEvidence {
  name: string;
  args: string;
  line: number;
  text: string;
}

interface ControllerClass {
  file: string;
  line: number;
  controllerPath: string;
  classDecorators: DecoratorEvidence[];
  methods: ControllerRoute[];
}

const CODE_FILE_PATTERN = /\.[cm]?tsx?$/i;
const DECORATOR_PATTERN = /^\s*@([A-Za-z_][\w.]*)\s*\((.*)\)\s*$/;
const HTTP_DECORATOR_PATTERN = /^(Get|Post|Put|Patch|Delete|Head|Options)$/i;
const METHOD_DECL_PATTERN = /^\s*(?:public|private|protected|async|static|\s)*([A-Za-z_]\w*)\s*\(/;
const DESTRUCTIVE_NAME_PATTERN = /(delete|revert|override|cancel|purge|destroy)/i;
const DESTRUCTIVE_ROUTE_PATTERN = /(revert|override|cancel|purge)-/i;

export function auditSiblingAuthPreconditions(
  diff: DiffSummary,
  options: SiblingAuthAuditOptions = {},
): SiblingAuthAuditReport {
  const controllers = loadControllerFiles(diff.changedFiles, diff.repoRoot).flatMap(parseControllers);
  const routes = stableRoutes(controllers.flatMap((controller) => controller.methods));
  const guardParityFindings = findGuardParityFindings(routes);
  const destructiveRoleFindings = findDestructiveRoleFindings(routes);
  const weakerRolesEnabled = !!options.projectShapes?.includes('nestjs-api');
  const weakerDestructiveRoleFindings = findWeakerDestructiveRoleFindings(routes, weakerRolesEnabled);
  const findings = [...guardParityFindings, ...destructiveRoleFindings, ...weakerDestructiveRoleFindings]
    .sort(compareFindings);

  return {
    routes,
    guardParityFindings,
    destructiveRoleFindings,
    weakerDestructiveRoleFindings,
    findings,
    destructiveRoleDriftTable: renderDestructiveRoleDriftTable(destructiveRoleFindings),
    summary: {
      controllers: controllers.length,
      routes: routes.length,
      guardParityFindings: guardParityFindings.length,
      destructiveRoleFindings: destructiveRoleFindings.length,
      weakerDestructiveRoleFindings: weakerDestructiveRoleFindings.length,
    },
  };
}

function loadControllerFiles(changedFiles: ChangedFileSummary[], repoRoot: string): SourceFile[] {
  return changedFiles.flatMap((summary) => {
    if (summary.kind !== 'production' || summary.status === 'D' || !CODE_FILE_PATTERN.test(summary.path)) return [];
    try {
      return [{
        path: summary.path,
        lines: readFileSync(path.join(repoRoot, summary.path), 'utf-8').split(/\r?\n/),
      }];
    } catch {
      return [];
    }
  });
}

function parseControllers(file: SourceFile): ControllerClass[] {
  const controllers: ControllerClass[] = [];
  let pendingDecorators: DecoratorEvidence[] = [];
  let current: ControllerClass | undefined;

  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index];
    const decorator = parseDecorator(line, index + 1);
    if (decorator) {
      pendingDecorators.push(decorator);
      continue;
    }

    const controllerDecorator = pendingDecorators.find((entry) => entry.name === 'Controller');
    if (controllerDecorator && /\bclass\s+[A-Za-z_]\w*/.test(line)) {
      current = {
        file: file.path,
        line: index + 1,
        controllerPath: decoratorPath(controllerDecorator.args),
        classDecorators: pendingDecorators,
        methods: [],
      };
      controllers.push(current);
      pendingDecorators = [];
      continue;
    }

    if (!current) {
      pendingDecorators = [];
      continue;
    }

    const httpDecorator = pendingDecorators.find((entry) => HTTP_DECORATOR_PATTERN.test(entry.name));
    const methodMatch = line.match(METHOD_DECL_PATTERN);
    if (httpDecorator && methodMatch) {
      current.methods.push(toRoute(file, current, pendingDecorators, httpDecorator, methodMatch[1], index + 1));
    }
    pendingDecorators = [];
  }

  return controllers;
}

function parseDecorator(line: string, lineNumber: number): DecoratorEvidence | undefined {
  const match = line.match(DECORATOR_PATTERN);
  if (!match) return undefined;
  return {
    name: match[1].split('.').at(-1) ?? match[1],
    args: match[2],
    line: lineNumber,
    text: line.trim(),
  };
}

function toRoute(
  file: SourceFile,
  controller: ControllerClass,
  methodDecorators: DecoratorEvidence[],
  httpDecorator: DecoratorEvidence,
  methodName: string,
  methodLine: number,
): ControllerRoute {
  const methodPath = decoratorPath(httpDecorator.args);
  const fullPath = normalizePath(joinEndpointPaths(controller.controllerPath, methodPath));
  const body = methodBody(file.lines, methodLine);
  const allDecorators = [...controller.classDecorators, ...methodDecorators];
  const roles = uniqueSortedStrings(allDecorators.filter((entry) => entry.name === 'Roles').flatMap((entry) => roleArgs(entry.args)));
  return {
    file: file.path,
    line: httpDecorator.line,
    controllerPath: normalizePath(controller.controllerPath),
    methodName,
    httpMethod: httpDecorator.name.toUpperCase(),
    methodPath: normalizePath(methodPath),
    fullPath,
    resourcePrefix: resourcePrefix(fullPath),
    guardPrefix: guardPrefix(allDecorators, body),
    roles,
    destructive: isDestructiveRoute(httpDecorator, methodName, methodPath),
  };
}

function methodBody(lines: string[], startLine: number): string[] {
  const body: string[] = [];
  let depth = 0;
  let opened = false;
  const scanState: BraceScanState = {
    inBlockComment: false,
    inSingleQuote: false,
    inDoubleQuote: false,
    inTemplateLiteral: false,
    templateExpressionDepth: 0,
  };
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = lines[index];
    body.push(line);
    const { openedBrace, delta } = structuralBraceDelta(line, scanState);
    depth += delta;
    if (openedBrace) opened = true;
    if (opened && depth <= 0) break;
  }
  return body;
}

function structuralBraceDelta(line: string, state: BraceScanState): { openedBrace: boolean; delta: number } {
  let delta = 0;
  let openedBrace = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    const blockCommentAdvance = advanceBlockComment(state, char, next);
    if (blockCommentAdvance !== null) {
      index += blockCommentAdvance;
      continue;
    }

    const quoteAdvance = advanceQuotedState(state, char);
    if (quoteAdvance !== null) {
      index += quoteAdvance;
      continue;
    }

    const templateAdvance = advanceTemplateLiteral(state, char, next);
    if (templateAdvance !== null) {
      if (templateAdvance > 0) {
        openedBrace = true;
        delta += 1;
      }
      index += Math.abs(templateAdvance);
      continue;
    }

    const enteredNonCodeState = enterNonCodeState(state, char, next);
    if (enteredNonCodeState === 'line-comment') break;
    if (enteredNonCodeState !== 'none') {
      index += enteredNonCodeState === 'block-comment' ? 1 : 0;
      continue;
    }

    if (char === '{') {
      openedBrace = true;
      delta += 1;
      if (state.templateExpressionDepth > 0) state.templateExpressionDepth += 1;
      continue;
    }
    if (char === '}') {
      delta -= 1;
      if (state.templateExpressionDepth > 0) {
        state.templateExpressionDepth -= 1;
        if (state.templateExpressionDepth === 0) state.inTemplateLiteral = true;
      }
    }
  }

  return { openedBrace, delta };
}

function advanceBlockComment(state: BraceScanState, char: string, next: string | undefined): number | null {
  if (!state.inBlockComment) return null;
  if (char === '*' && next === '/') {
    state.inBlockComment = false;
    return 1;
  }
  return 0;
}

function advanceQuotedState(state: BraceScanState, char: string): number | null {
  if (!state.inSingleQuote && !state.inDoubleQuote) return null;
  if (char === '\\') return 1;
  if (state.inSingleQuote && char === '\'') state.inSingleQuote = false;
  if (state.inDoubleQuote && char === '"') state.inDoubleQuote = false;
  return 0;
}

function advanceTemplateLiteral(state: BraceScanState, char: string, next: string | undefined): number | null {
  if (!state.inTemplateLiteral) return null;
  if (char === '\\') return 1;
  if (char === '`') {
    state.inTemplateLiteral = false;
    return 0;
  }
  if (char === '$' && next === '{') {
    state.templateExpressionDepth = 1;
    state.inTemplateLiteral = false;
    return 1;
  }
  return 0;
}

function enterNonCodeState(
  state: BraceScanState,
  char: string,
  next: string | undefined,
): 'none' | 'line-comment' | 'block-comment' | 'single-quote' | 'double-quote' | 'template-literal' {
  if (char === '/' && next === '/') return 'line-comment';
  if (char === '/' && next === '*') {
    state.inBlockComment = true;
    return 'block-comment';
  }
  if (char === '\'') {
    state.inSingleQuote = true;
    return 'single-quote';
  }
  if (char === '"') {
    state.inDoubleQuote = true;
    return 'double-quote';
  }
  if (char === '`') {
    state.inTemplateLiteral = true;
    return 'template-literal';
  }
  return 'none';
}

function guardPrefix(decorators: DecoratorEvidence[], body: string[]): string[] {
  const tokens = decorators.flatMap(decoratorGuardTokens);
  if (body.some((line) => /featureFlag|flagGate|isFeatureEnabled|requireFeature/i.test(line))) tokens.push('flag-check');
  if (body.some((line) => /budget|checkBudget|validateBudget|budgetGuard|assertBudget/i.test(line))) tokens.push('budget-check');
  if (body.some((line) => /csrf|verifyCsrf|validateCsrf|checkCsrf|csrfToken/i.test(line))) tokens.push('csrf-validation');
  if (body.some((line) => /ownership|owner|ownedBy|assertOwner|requireOwner/i.test(line))) tokens.push('ownership-lookup');
  if (body.some((line) => /status|state|assertStatus|validateStatus|requireStatus/i.test(line))) tokens.push('status-validation');
  return uniqueSortedStrings(tokens);
}

function decoratorGuardTokens(decorator: DecoratorEvidence): string[] {
  if (decorator.name === 'Roles') return [`roles(${roleArgs(decorator.args).join(',')})`];
  if (decorator.name === 'UseGuards') return [`guards(${argumentTokens(decorator.args).join(',')})`];
  // @Throttle parity: a rate-limit decorator present on one sibling route but absent on another
  // surfaces through the guard-parity signature comparison as a missing 'throttle' token.
  if (decorator.name === 'Throttle') return ['throttle'];
  return [];
}

function findGuardParityFindings(routes: ControllerRoute[]): GuardParityFinding[] {
  const groups = groupBy(routes, (route) => `${route.file}|${route.resourcePrefix}`);
  return [...groups.values()].flatMap((group) => {
    if (group.length < 2) return [];
    const signatures = new Set(group.map((route) => route.guardPrefix.join('|')));
    if (signatures.size <= 1) return [];
    const expected = uniqueSortedStrings(group.flatMap((route) => route.guardPrefix));
    const missingGuards = uniqueSortedStrings(group.flatMap((route) => expected.filter((token) => !route.guardPrefix.includes(token))));
    const first = group[0];
    return [{
      id: `citadel-sibling-guard-parity-${slug(first.file)}-${slug(first.resourcePrefix)}`,
      severity: PARITY_SEVERITY,
      message: `Sibling guard/precondition drift under ${first.resourcePrefix}.`,
      controller: first.file,
      resourcePrefix: first.resourcePrefix,
      methods: group.map(formatRouteMethod).sort((a, b) => a.localeCompare(b)),
      missingGuards,
      evidence: group.map(routeEvidence),
    }];
  }).sort(compareFindings);
}

function findDestructiveRoleFindings(routes: ControllerRoute[]): DestructiveRoleFinding[] {
  const destructiveRoutes = routes.filter((route) => route.destructive);
  const missingRoleFindings = destructiveRoutes
    .filter((route) => route.roles.length === 0)
    .map(missingRoleFinding);
  const driftFindings = [...groupBy(destructiveRoutes, (route) => route.file).values()]
    .filter((group) => group.length > 1 && new Set(group.map((route) => route.roles.join('|'))).size > 1)
    .map(destructiveRoleDriftFinding);
  return [...missingRoleFindings, ...driftFindings].sort(compareFindings);
}

/**
 * Gated `nestjs-api` detection: a destructive sibling route whose @Roles allowlist is a STRICT
 * SUPERSET of another destructive sibling's allowlist (same controller file) — i.e. it grants
 * strictly broader (weaker) access to a destructive operation than a sibling does. Distinct from
 * the unconditional drift finding (which fires on any difference); this isolates the
 * privilege-escalation direction the remediator should tighten.
 */
function findWeakerDestructiveRoleFindings(
  routes: ControllerRoute[],
  enabled: boolean,
): WeakerDestructiveRoleFinding[] {
  if (!enabled) return [];
  const destructiveRoutes = routes.filter((route) => route.destructive && route.roles.length > 0);
  const findings: WeakerDestructiveRoleFinding[] = [];
  for (const group of groupBy(destructiveRoutes, (route) => route.file).values()) {
    if (group.length < 2) continue;
    for (const route of group) {
      const stricter = group.find((sibling) => sibling !== route && isStrictSubset(sibling.roles, route.roles));
      if (!stricter) continue;
      findings.push({
        id: `citadel-destructive-role-weaker-${slug(route.file)}-${slug(route.methodName)}`,
        severity: 'High',
        message:
          `Destructive route ${route.methodName} allows a weaker @Roles allowlist `
          + `[${route.roles.join(', ')}] than its sibling ${stricter.methodName} `
          + `[${stricter.roles.join(', ')}]; tighten it to the stricter sibling.`,
        controller: route.file,
        method: formatRouteMethod(route),
        roles: route.roles,
        stricterSiblingMethod: formatRouteMethod(stricter),
        stricterSiblingRoles: stricter.roles,
        evidence: [routeEvidence(route), routeEvidence(stricter)],
      });
    }
  }
  return findings.sort(compareFindings);
}

function isStrictSubset(subset: string[], superset: string[]): boolean {
  if (subset.length >= superset.length) return false;
  const supersetSet = new Set(superset);
  return subset.every((role) => supersetSet.has(role));
}

function missingRoleFinding(route: ControllerRoute): DestructiveRoleFinding {
  return {
    id: `citadel-destructive-role-missing-${slug(route.file)}-${slug(route.methodName)}`,
    severity: 'Critical',
    message: `Destructive route ${route.methodName} has no effective @Roles allowlist.`,
    controller: route.file,
    methods: [formatRouteMethod(route)],
    roleAllowlists: [{ method: formatRouteMethod(route), roles: [] }],
    evidence: [routeEvidence(route)],
  };
}

function destructiveRoleDriftFinding(routes: ControllerRoute[]): DestructiveRoleFinding {
  const first = routes[0];
  const methods = routes.map(formatRouteMethod).sort((a, b) => a.localeCompare(b));
  return {
    id: `citadel-destructive-role-drift-${slug(first.file)}`,
    severity: 'High',
    message: `destructive-role drift in ${first.file}.`,
    controller: first.file,
    methods,
    roleAllowlists: routes
      .map((route) => ({ method: formatRouteMethod(route), roles: route.roles }))
      .sort((a, b) => a.method.localeCompare(b.method)),
    evidence: routes.map(routeEvidence),
  };
}

function renderDestructiveRoleDriftTable(findings: DestructiveRoleFinding[]): string {
  const driftFindings = findings.filter((finding) => finding.severity === 'High');
  return [
    '| Controller | Method | Roles |',
    '|---|---|---|',
    ...driftFindings.flatMap((finding) =>
      finding.roleAllowlists.map((row) => `| ${escapeTableCell(finding.controller)} | ${escapeTableCell(row.method)} | ${escapeTableCell(row.roles.join(', ') || '(none)')} |`),
    ),
  ].join('\n');
}

function isDestructiveRoute(httpDecorator: DecoratorEvidence, methodName: string, methodPath: string): boolean {
  return httpDecorator.name.toLowerCase() === 'delete' ||
    DESTRUCTIVE_NAME_PATTERN.test(methodName) ||
    DESTRUCTIVE_ROUTE_PATTERN.test(methodPath);
}

function routeEvidence(route: ControllerRoute): SiblingAuthEvidence {
  return {
    file: route.file,
    line: route.line,
    text: `${route.httpMethod} ${route.fullPath} ${route.methodName}`,
  };
}

function formatRouteMethod(route: ControllerRoute): string {
  return `${route.methodName} (${route.httpMethod} ${route.fullPath})`;
}

function resourcePrefix(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  if (segments.length <= 1) return fullPath;
  return `/${segments.slice(0, -1).join('/')}`;
}

function decoratorPath(args: string): string {
  const match = args.match(/['"`]([^'"`]*)['"`]/);
  return match?.[1] ?? '';
}

function roleArgs(args: string): string[] {
  return argumentTokens(args).map((role) => role.replace(/^Roles?\./, ''));
}

function argumentTokens(args: string): string[] {
  return args
    .split(',')
    .map((arg) => arg.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function joinEndpointPaths(basePath: string, methodPath: string): string {
  return [basePath, methodPath]
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function normalizePath(value: string): string {
  const normalized = value
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

function stableRoutes(routes: ControllerRoute[]): ControllerRoute[] {
  return [...routes].sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.methodName.localeCompare(b.methodName));
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function compareFindings(a: { id: string; severity: string }, b: { id: string; severity: string }): number {
  return severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id);
}

function severityRank(severity: string): number {
  if (severity === 'Critical') return 0;
  if (severity === 'High') return 1;
  return 2;
}

function slug(value: string): string {
  return slugify(value, 'unknown', 80);
}

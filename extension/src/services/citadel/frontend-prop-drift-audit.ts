import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { ChangedFileSummary, DiffSummary } from './diff-walker.js';
import { slugifyOrRoot } from './reporter.js';

export type FrontendPropDriftSeverity = 'High';

export interface FrontendPropDriftEvidence {
  file: string;
  line: number;
  text: string;
}

export interface FrontendPropDriftFinding {
  id: string;
  severity: FrontendPropDriftSeverity;
  message: string;
  component: string;
  file: string;
  line: number;
  passedProps: string[];
  declaredProps: string[];
  undeclaredProps: string[];
  evidence: FrontendPropDriftEvidence[];
}

export interface FrontendSpreadBlindSpot {
  file: string;
  line: number;
  component: string;
  text: string;
}

export interface FrontendPropDriftReport {
  header: string;
  analyzedFiles: string[];
  components: Array<{
    name: string;
    file: string;
    declaredProps: string[];
  }>;
  spreadBlindSpots: FrontendSpreadBlindSpot[];
  findings: FrontendPropDriftFinding[];
  summary: {
    files: number;
    components: number;
    invocations: number;
    spreadBlindSpots: number;
    findings: number;
  };
}

interface SourceFileRecord {
  path: string;
  sourceFile: ts.SourceFile;
}

interface ComponentProps {
  name: string;
  file: string;
  props: Set<string>;
}

interface AnalysisContext {
  files: SourceFileRecord[];
  typeProps: Map<string, Set<string>>;
  components: Map<string, ComponentProps[]>;
}

const TSX_FILE_PATTERN = /\.tsx$/i;
const SPREAD_BLIND_SPOT_HEADER = 'Spread props are not analyzed: any sibling invocation using JSX spread attributes is reported as a blind spot and skipped for drift matching.';
const SPECIAL_JSX_ATTRIBUTES = new Set(['key', 'ref']);

export function auditFrontendPropDrift(diff: DiffSummary): FrontendPropDriftReport {
  const files = loadTsxFiles(diff.changedFiles, diff.repoRoot);
  const context: AnalysisContext = {
    files,
    typeProps: new Map(),
    components: new Map(),
  };

  for (const file of files) {
    collectTypeProps(file.sourceFile, context.typeProps);
  }
  for (const file of files) {
    collectComponents(file, context);
  }

  const spreadBlindSpots: FrontendSpreadBlindSpot[] = [];
  const findings: FrontendPropDriftFinding[] = [];
  let invocations = 0;

  for (const file of files) {
    visitJsx(file.sourceFile, (node) => {
      const tag = jsxTagName(node.tagName);
      if (!tag || !isComponentName(tag)) return;
      const component = resolveComponent(context.components, tag, file.path);
      if (!component) return;
      invocations += 1;

      const explicitProps = explicitJsxPropNames(node.attributes.properties);
      const hasSpread = node.attributes.properties.some(ts.isJsxSpreadAttribute);
      if (hasSpread) {
        spreadBlindSpots.push(toSpreadBlindSpot(file, node, tag));
        return;
      }

      const undeclaredProps = explicitProps.filter((prop) => !component.props.has(prop));
      if (undeclaredProps.length === 0) return;
      findings.push(toFinding(file, node, component, explicitProps, undeclaredProps));
    });
  }

  const analyzedFiles = files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
  const components = [...context.components.values()]
    .flat()
    .map((component) => ({
      name: component.name,
      file: component.file,
      declaredProps: sortedStrings([...component.props]),
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  return {
    header: SPREAD_BLIND_SPOT_HEADER,
    analyzedFiles,
    components,
    spreadBlindSpots: spreadBlindSpots.sort(compareBlindSpots),
    findings: findings.sort(compareFindings),
    summary: {
      files: files.length,
      components: components.length,
      invocations,
      spreadBlindSpots: spreadBlindSpots.length,
      findings: findings.length,
    },
  };
}

function loadTsxFiles(changedFiles: ChangedFileSummary[], repoRoot: string): SourceFileRecord[] {
  return changedFiles.flatMap((summary) => {
    if (summary.kind !== 'production' || summary.status === 'D' || !TSX_FILE_PATTERN.test(summary.path)) return [];
    const fullPath = path.join(repoRoot, summary.path);
    try {
      const source = readFileSync(fullPath, 'utf-8');
      return [{
        path: summary.path,
        sourceFile: ts.createSourceFile(summary.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
      }];
    } catch {
      return [];
    }
  });
}

function collectTypeProps(sourceFile: ts.SourceFile, typeProps: Map<string, Set<string>>): void {
  sourceFile.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) {
      typeProps.set(node.name.text, propsFromMembers(node.members));
    } else if (ts.isTypeAliasDeclaration(node)) {
      const props = propsFromTypeNode(node.type, typeProps);
      if (props) typeProps.set(node.name.text, props);
    }
  });
}

function collectComponents(file: SourceFileRecord, context: AnalysisContext): void {
  file.sourceFile.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && isComponentName(node.name.text)) {
      addComponent(context, file.path, node.name.text, propsFromParameters(node.parameters, context.typeProps));
    } else if (ts.isVariableStatement(node)) {
      collectVariableComponents(file.path, node, context);
    }
  });
}

function collectVariableComponents(filePath: string, node: ts.VariableStatement, context: AnalysisContext): void {
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !isComponentName(declaration.name.text)) continue;
    const declaredProps = propsFromVariableType(declaration.type, context.typeProps);
    const parameterProps = functionLikeInitializerProps(declaration.initializer, context.typeProps);
    const props = declaredProps ?? parameterProps;
    addComponent(context, filePath, declaration.name.text, props);
  }
}

function addComponent(context: AnalysisContext, filePath: string, name: string, props: Set<string> | undefined): void {
  if (!props) return;
  const existing = context.components.get(name) ?? [];
  existing.push({ name, file: filePath, props });
  context.components.set(name, existing);
}

function resolveComponent(components: Map<string, ComponentProps[]>, name: string, filePath: string): ComponentProps | undefined {
  const candidates = components.get(name) ?? [];
  const sameFile = candidates.filter((component) => component.file === filePath);
  if (sameFile.length === 1) return sameFile[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function propsFromVariableType(type: ts.TypeNode | undefined, typeProps: Map<string, Set<string>>): Set<string> | undefined {
  if (!type) return undefined;
  if (ts.isTypeReferenceNode(type)) {
    const typeName = type.typeName.getText();
    if ((typeName === 'FC' || typeName === 'React.FC' || typeName === 'FunctionComponent' || typeName === 'React.FunctionComponent') && type.typeArguments?.[0]) {
      return propsFromTypeNode(type.typeArguments[0], typeProps);
    }
  }
  return propsFromTypeNode(type, typeProps);
}

function functionLikeInitializerProps(node: ts.Expression | undefined, typeProps: Map<string, Set<string>>): Set<string> | undefined {
  if (!node) return undefined;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return propsFromParameters(node.parameters, typeProps);
  }
  return undefined;
}

function propsFromParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>, typeProps: Map<string, Set<string>>): Set<string> | undefined {
  const first = parameters[0];
  if (!first) return new Set();
  if (first.type) {
    const fromType = propsFromTypeNode(first.type, typeProps);
    if (fromType) return fromType;
  }
  if (ts.isObjectBindingPattern(first.name)) {
    return new Set(first.name.elements.flatMap((element) => bindingPropName(element)));
  }
  return undefined;
}

function propsFromTypeNode(type: ts.TypeNode, typeProps: Map<string, Set<string>>): Set<string> | undefined {
  if (ts.isTypeLiteralNode(type)) return propsFromMembers(type.members);
  if (ts.isTypeReferenceNode(type)) {
    const typeName = type.typeName.getText();
    if (typeName === 'PropsWithChildren' || typeName === 'React.PropsWithChildren') {
      const inner = type.typeArguments?.[0];
      const props = inner ? propsFromTypeNode(inner, typeProps) : new Set<string>();
      props?.add('children');
      return props;
    }
    const direct = typeProps.get(typeName);
    if (direct) return new Set(direct);
  }
  if (ts.isIntersectionTypeNode(type)) {
    const combined = new Set<string>();
    let found = false;
    for (const part of type.types) {
      const props = propsFromTypeNode(part, typeProps);
      if (!props) continue;
      found = true;
      for (const prop of props) combined.add(prop);
    }
    return found ? combined : undefined;
  }
  return undefined;
}

function propsFromMembers(members: ts.NodeArray<ts.TypeElement>): Set<string> {
  return new Set(members.flatMap((member) => {
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) return [];
    const name = propertyNameText(member.name);
    return name ? [name] : [];
  }));
}

function bindingPropName(element: ts.BindingElement): string[] {
  const propertyName = element.propertyName ? propertyNameText(element.propertyName) : undefined;
  const name = propertyName ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
  return name ? [name] : [];
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function visitJsx(sourceFile: ts.SourceFile, visitor: (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => void): void {
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) visitor(node);
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
}

function explicitJsxPropNames(properties: ts.NodeArray<ts.JsxAttributeLike>): string[] {
  const names = properties.flatMap((property) => {
    if (!ts.isJsxAttribute(property)) return [];
    const name = property.name.getText();
    return SPECIAL_JSX_ATTRIBUTES.has(name) ? [] : [name];
  });
  return sortedStrings([...new Set(names)]);
}

function toSpreadBlindSpot(
  file: SourceFileRecord,
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  component: string,
): FrontendSpreadBlindSpot {
  return {
    file: file.path,
    line: lineNumber(file.sourceFile, node),
    component,
    text: node.getText(file.sourceFile),
  };
}

function toFinding(
  file: SourceFileRecord,
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  component: ComponentProps,
  passedProps: string[],
  undeclaredProps: string[],
): FrontendPropDriftFinding {
  const line = lineNumber(file.sourceFile, node);
  return {
    id: `citadel-frontend-prop-drift-${slugifyOrRoot(file.path)}-${slugifyOrRoot(component.name)}-${line}`,
    severity: 'High',
    message: `${component.name} receives undeclared prop(s): ${undeclaredProps.join(', ')}.`,
    component: component.name,
    file: file.path,
    line,
    passedProps,
    declaredProps: sortedStrings([...component.props]),
    undeclaredProps,
    evidence: [{
      file: file.path,
      line,
      text: node.getText(file.sourceFile),
    }],
  };
}

function jsxTagName(name: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPropertyAccessExpression(name)) return name.name.text;
  return undefined;
}

function isComponentName(value: string): boolean {
  return /^[A-Z]/.test(value);
}

function lineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function compareFindings(a: FrontendPropDriftFinding, b: FrontendPropDriftFinding): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.component.localeCompare(b.component);
}

function compareBlindSpots(a: FrontendSpreadBlindSpot, b: FrontendSpreadBlindSpot): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.component.localeCompare(b.component);
}

function sortedStrings(values: string[]): string[] {
  return values.sort((a, b) => a.localeCompare(b));
}

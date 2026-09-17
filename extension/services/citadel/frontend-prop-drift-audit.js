import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { slugifyOrRoot } from './reporter.js';
const TSX_FILE_PATTERN = /\.tsx$/i;
const SPREAD_BLIND_SPOT_HEADER = 'Spread props are not analyzed: any sibling invocation using JSX spread attributes is reported as a blind spot and skipped for drift matching.';
const SPECIAL_JSX_ATTRIBUTES = new Set(['key', 'ref']);
export function auditFrontendPropDrift(diff) {
    const files = loadTsxFiles(diff.changedFiles, diff.repoRoot);
    const context = {
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
    const spreadBlindSpots = [];
    const findings = [];
    let invocations = 0;
    for (const file of files) {
        visitJsx(file.sourceFile, (node) => {
            const tag = jsxTagName(node.tagName);
            if (!tag || !isComponentName(tag))
                return;
            const component = resolveComponent(context.components, tag, file.path);
            if (!component)
                return;
            invocations += 1;
            const explicitProps = explicitJsxPropNames(node.attributes.properties);
            const hasSpread = node.attributes.properties.some(ts.isJsxSpreadAttribute);
            if (hasSpread) {
                spreadBlindSpots.push(toSpreadBlindSpot(file, node, tag));
                return;
            }
            const undeclaredProps = explicitProps.filter((prop) => !component.props.has(prop));
            if (undeclaredProps.length === 0)
                return;
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
function loadTsxFiles(changedFiles, repoRoot) {
    return changedFiles.flatMap((summary) => {
        if (summary.kind !== 'production' || summary.status === 'D' || !TSX_FILE_PATTERN.test(summary.path))
            return [];
        const fullPath = path.join(repoRoot, summary.path);
        try {
            const source = readFileSync(fullPath, 'utf-8');
            return [{
                    path: summary.path,
                    sourceFile: ts.createSourceFile(summary.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
                }];
        }
        catch {
            return [];
        }
    });
}
function collectTypeProps(sourceFile, typeProps) {
    sourceFile.forEachChild((node) => {
        if (ts.isInterfaceDeclaration(node)) {
            typeProps.set(node.name.text, propsFromMembers(node.members));
        }
        else if (ts.isTypeAliasDeclaration(node)) {
            const props = propsFromTypeNode(node.type, typeProps);
            if (props)
                typeProps.set(node.name.text, props);
        }
    });
}
function collectComponents(file, context) {
    file.sourceFile.forEachChild((node) => {
        if (ts.isFunctionDeclaration(node) && node.name && isComponentName(node.name.text)) {
            addComponent(context, file.path, node.name.text, propsFromParameters(node.parameters, context.typeProps));
        }
        else if (ts.isVariableStatement(node)) {
            collectVariableComponents(file.path, node, context);
        }
    });
}
function collectVariableComponents(filePath, node, context) {
    for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !isComponentName(declaration.name.text))
            continue;
        const declaredProps = propsFromVariableType(declaration.type, context.typeProps);
        const parameterProps = functionLikeInitializerProps(declaration.initializer, context.typeProps);
        const props = declaredProps ?? parameterProps;
        addComponent(context, filePath, declaration.name.text, props);
    }
}
function addComponent(context, filePath, name, props) {
    if (!props)
        return;
    const existing = context.components.get(name) ?? [];
    existing.push({ name, file: filePath, props });
    context.components.set(name, existing);
}
function resolveComponent(components, name, filePath) {
    const candidates = components.get(name) ?? [];
    const sameFile = candidates.filter((component) => component.file === filePath);
    if (sameFile.length === 1)
        return sameFile[0];
    return candidates.length === 1 ? candidates[0] : undefined;
}
function propsFromVariableType(type, typeProps) {
    if (!type)
        return undefined;
    if (ts.isTypeReferenceNode(type)) {
        const typeName = type.typeName.getText();
        if ((typeName === 'FC' || typeName === 'React.FC' || typeName === 'FunctionComponent' || typeName === 'React.FunctionComponent') && type.typeArguments?.[0]) {
            return propsFromTypeNode(type.typeArguments[0], typeProps);
        }
    }
    return propsFromTypeNode(type, typeProps);
}
function functionLikeInitializerProps(node, typeProps) {
    if (!node)
        return undefined;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        return propsFromParameters(node.parameters, typeProps);
    }
    return undefined;
}
function propsFromParameters(parameters, typeProps) {
    const first = parameters[0];
    if (!first)
        return new Set();
    if (first.type) {
        const fromType = propsFromTypeNode(first.type, typeProps);
        if (fromType)
            return fromType;
    }
    if (ts.isObjectBindingPattern(first.name)) {
        return new Set(first.name.elements.flatMap((element) => bindingPropName(element)));
    }
    return undefined;
}
function propsFromTypeNode(type, typeProps) {
    if (ts.isTypeLiteralNode(type))
        return propsFromMembers(type.members);
    if (ts.isTypeReferenceNode(type)) {
        const typeName = type.typeName.getText();
        if (typeName === 'PropsWithChildren' || typeName === 'React.PropsWithChildren') {
            const inner = type.typeArguments?.[0];
            const props = inner ? propsFromTypeNode(inner, typeProps) : new Set();
            props?.add('children');
            return props;
        }
        const direct = typeProps.get(typeName);
        if (direct)
            return new Set(direct);
    }
    if (ts.isIntersectionTypeNode(type)) {
        const combined = new Set();
        let found = false;
        for (const part of type.types) {
            const props = propsFromTypeNode(part, typeProps);
            if (!props)
                continue;
            found = true;
            for (const prop of props)
                combined.add(prop);
        }
        return found ? combined : undefined;
    }
    return undefined;
}
function propsFromMembers(members) {
    return new Set(members.flatMap((member) => {
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member))
            return [];
        const name = propertyNameText(member.name);
        return name ? [name] : [];
    }));
}
function bindingPropName(element) {
    const propertyName = element.propertyName ? propertyNameText(element.propertyName) : undefined;
    const name = propertyName ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
    return name ? [name] : [];
}
function propertyNameText(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
        return name.text;
    return undefined;
}
function visitJsx(sourceFile, visitor) {
    const visit = (node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
            visitor(node);
        node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
}
function explicitJsxPropNames(properties) {
    const names = properties.flatMap((property) => {
        if (!ts.isJsxAttribute(property))
            return [];
        const name = property.name.getText();
        return SPECIAL_JSX_ATTRIBUTES.has(name) ? [] : [name];
    });
    return sortedStrings([...new Set(names)]);
}
function toSpreadBlindSpot(file, node, component) {
    return {
        file: file.path,
        line: lineNumber(file.sourceFile, node),
        component,
        text: node.getText(file.sourceFile),
    };
}
function toFinding(file, node, component, passedProps, undeclaredProps) {
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
function jsxTagName(name) {
    if (ts.isIdentifier(name))
        return name.text;
    if (ts.isPropertyAccessExpression(name))
        return name.name.text;
    return undefined;
}
function isComponentName(value) {
    return /^[A-Z]/.test(value);
}
function lineNumber(sourceFile, node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
function compareFindings(a, b) {
    return a.file.localeCompare(b.file) || a.line - b.line || a.component.localeCompare(b.component);
}
function compareBlindSpots(a, b) {
    return a.file.localeCompare(b.file) || a.line - b.line || a.component.localeCompare(b.component);
}
function sortedStrings(values) {
    return values.sort((a, b) => a.localeCompare(b));
}

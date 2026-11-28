#!/usr/bin/env node
/** Exact source inventory, not a browser test. No game/server/DOM mutation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(root, process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'games/tyaga/qa/UI_ELEMENTS.json');
const check = process.argv.includes('--check');
const client = 'games/tyaga/src/client';
const sha = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const compact = text => text.replace(/\s+/g, ' ').trim();
const text = node => node?.getText() ?? '';
const visit = (node, fn) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };
const unwrap = node => node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) ? unwrap(node.expression) : node;
async function filesBelow(folder) {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true })) {
    const name = path.posix.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(name)); else if (/\.(ts|tsx|css)$/.test(name)) result.push(name);
  }
  return result.sort();
}
const scanned = [...await filesBelow(client), 'games/tyaga/src/core/types.ts', 'games/tyaga/src/core/config.ts', 'games/tyaga/src/maps/index.ts', 'games/tyaga/src/tutorial/index.ts', 'games/tyaga/src/server-world/actions.ts', 'games/tyaga/UI_COVERAGE.md', 'packages/game-registry/games.json'].sort();
const sources = new Map(), fingerprints = [];
for (const file of scanned) {
  const bytes = await fs.readFile(path.join(root, file));
  fingerprints.push({ file, bytes: bytes.length, sha256: sha(bytes), gitBlobSha1: sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1') });
  if (/\.tsx?$/.test(file)) sources.set(file, ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
}
const definitions = new Map();
for (const [file, source] of sources) visit(source, node => {
  if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    const list = definitions.get(node.name.text) ?? []; list.push({ file, node }); definitions.set(node.name.text, list);
  }
});
function location(node) {
  const source = node.getSourceFile(), start = node.getStart(source), point = source.getLineAndCharacterOfPosition(start);
  return { file: source.fileName, utf16Start: start, utf16End: node.end, line: point.line + 1, column: point.character + 1, nodeSha256: sha(text(node)) };
}
function owner(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isClassDeclaration(p) && p.name) return p.name.text;
  }
  return '(module)';
}
function literal(node) {
  node = unwrap(node); if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p => [ts.isStringLiteralLike(p.name) ? p.name.text : text(p.name), literal(p.initializer)]));
  return { expression: text(node) };
}
function declaration(name, near) {
  const list = definitions.get(name) ?? [];
  return list.find(d => d.file === near.getSourceFile().fileName && owner(d.node) === owner(near)) ?? list.find(d => d.file === near.getSourceFile().fileName) ?? list[0];
}
function valueOf(name) { const item = definitions.get(name)?.[0]; return item?.node.initializer ? literal(item.node.initializer) : null; }
const mapCopy = valueOf('MAP_COPY'), tasks = valueOf('taskLabels');
const registry = JSON.parse(await fs.readFile(path.join(root, 'packages/game-registry/games.json'), 'utf8'));
const game = (registry.games ?? registry).find(item => item.gameId === 'tyaga');
const actionType = definitions.get('TyagaAction')[0].node;
const actionNames = [];
visit(actionType, node => { if (ts.isPropertySignature(node) && text(node.name) === 'type' && node.type && ts.isLiteralTypeNode(node.type) && ts.isStringLiteral(node.type.literal)) actionNames.push(node.type.literal.text); });
function domain(expression, node) {
  const input = unwrap(expression), raw = text(input);
  if (input && ts.isArrayLiteralExpression(input)) return { kind: 'finite-literal', values: literal(input), count: input.elements.length };
  if (raw.includes('MAP_COPY')) return { kind: 'finite-source-dictionary', reference: 'mapCopy', values: Object.keys(mapCopy), count: Object.keys(mapCopy).length };
  if (raw.includes('taskLabels')) return { kind: 'finite-source-dictionary', reference: 'botTasks', values: Object.keys(tasks), count: Object.keys(tasks).length };
  if (/room\.capacity|view\.participants/.test(raw)) return { kind: 'runtime-seats', source: 'packages/game-registry/games.json#tyaga', maximum: game.maxPlayers, every: 'seatIndex / participantId, for each existing human or bot' };
  if (/\.sockets|targetSockets/.test(raw)) return { kind: 'runtime-sockets', every: 'entityId + socket.id; preserve role, occupancy and source/target filtering', expression: raw };
  if (/inventory|straps/.test(raw)) return { kind: 'runtime-inventory', every: 'unique item.id, its kind and stored/world/attached/destroyed state', expression: raw };
  if (/connections|links/.test(raw)) return { kind: 'runtime-connections', every: 'connection.id, kind, endpoints, broken/detached flags', expression: raw };
  if (/friends/.test(raw)) return { kind: 'account-dependent', every: 'returned friend.playerId; no account data is synthesized', expression: raw };
  if (/rooms\.slice\(0,\s*8\)/.test(raw)) return { kind: 'runtime-rooms', maximum: 8, every: 'roomId and lobby/playing/finished state', expression: raw };
  if (/cargo/.test(raw)) return { kind: 'map-cargo', reference: 'mapInventory', count: 3, every: 'each map-specific required cargo ID' };
  const decl = ts.isIdentifier(input) ? declaration(input.text, node) : null;
  return { kind: 'runtime-expression', expression: raw, ...(decl ? { definition: location(decl.node), initializer: text(decl.node.initializer) } : {}) };
}
function context(node) {
  const conditions = [], repeats = [], ancestors = [];
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind) && node.pos >= p.right.pos) conditions.push({ expression: text(p.left), branch: p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'truthy' : 'falsy' });
    if (ts.isConditionalExpression(p)) conditions.push({ expression: text(p.condition), branch: node.pos >= p.whenTrue.pos && node.end <= p.whenTrue.end ? 'true' : 'false' });
    if (ts.isIfStatement(p)) conditions.push({ expression: text(p.expression), branch: node.pos >= p.thenStatement.pos && node.end <= p.thenStatement.end ? 'true' : 'false' });
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'map') repeats.push({ expression: text(p.expression.expression), callback: p.arguments.map(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a) ? a.parameters.map(text) : []).flat(), domain: domain(p.expression.expression, node) });
    if (ts.isCallExpression(p) && text(p.expression) === 'Array.from') { const arg = unwrap(p.arguments[0]), length = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find(prop => ts.isPropertyAssignment(prop) && text(prop.name) === 'length') : null; const count = length ? literal(length.initializer) : null; repeats.push({ expression: `Array.from(${text(p.arguments[0])})`, domain: typeof count === 'number' ? { kind: 'finite-count', count, values: Array.from({ length: count }, (_, i) => i) } : domain(length?.initializer, node) }); }
    if (ts.isForOfStatement(p)) repeats.push({ expression: text(p.expression), binding: text(p.initializer), domain: domain(p.expression, node) });
    if (ts.isJsxElement(p)) { const tag = text(p.openingElement.tagName); if (/^[A-Z]/.test(tag)) ancestors.push(tag); }
    if (ts.isFunctionDeclaration(p)) break;
  }
  return { conditions: conditions.reverse(), repeats: repeats.reverse(), componentAncestors: ancestors.reverse() };
}
function attrs(node) {
  return Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(a => [text(a.name), a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer ?? true]));
}
const attrText = value => value === true ? 'true' : text(value);
function ruEn(nodes) {
  const result = [];
  for (const node of nodes.filter(n => n && n !== true)) visit(node, n => {
    if (ts.isCallExpression(n) && text(n.expression) === 't' && n.arguments.length >= 2) result.push({ ru: literal(n.arguments[0]), en: literal(n.arguments[1]), expression: text(n) });
    if (ts.isConditionalExpression(n) && /(?:lang|language)\s*===\s*['"]ru['"]/.test(text(n.condition)) && !(ts.isNumericLiteral(n.whenTrue) && ts.isNumericLiteral(n.whenFalse))) result.push({ ru: literal(n.whenTrue), en: literal(n.whenFalse), expression: text(n) });
  });
  return [...new Map(result.map(pair => [JSON.stringify(pair), pair])).values()];
}
const labelsByFor = new Map();
for (const source of sources.values()) visit(source, node => {
  if (ts.isJsxElement(node) && text(node.openingElement.tagName) === 'label') { const a = attrs(node.openingElement); if (a.htmlFor) labelsByFor.set(`${source.fileName}|${owner(node)}|${attrText(a.htmlFor)}`, node); }
});
function label(node, a) {
  const outer = ts.isJsxOpeningElement(node) ? node.parent : node;
  let origin = 'children', nodes = ts.isJsxElement(outer) ? [...outer.children] : [];
  for (const name of ['aria-label', 'label']) if (a[name]) { origin = name; nodes = [a[name]]; break; }
  if (text(node.tagName) === 'Dialog' && a.title) { origin = 'dialog-title-prop'; nodes = [a.title]; }
  if (text(node.tagName).endsWith('.Provider')) { origin = 'context-value'; nodes = a.value ? [a.value] : []; }
  if (origin === 'children' && a.id) { const associated = labelsByFor.get(`${node.getSourceFile().fileName}|${owner(node)}|${attrText(a.id)}`); if (associated) { origin = 'associated-label'; nodes = associated.children; } }
  if (!nodes.length || /^(input|select)$/.test(text(node.tagName)) && origin === 'children') for (let p = outer.parent; p; p = p.parent) if (ts.isJsxElement(p) && text(p.openingElement.tagName) === 'label') { origin = 'wrapping-label'; nodes = p.children.filter(child => child !== outer); break; }
  const expression = nodes.map(n => n === true ? 'true' : text(n)).join(' ').trim();
  let defaultBinding;
  const component = definitions.get(owner(node))?.find(d => ts.isFunctionDeclaration(d.node));
  for (const parameter of component?.node.parameters ?? []) if (ts.isObjectBindingPattern(parameter.name)) for (const binding of parameter.name.elements) if (text(binding.name) === expression && binding.initializer) defaultBinding = { value: literal(binding.initializer), source: location(binding) };
  return { source: origin, expression, ruEn: ruEn(nodes), ...(a.title ? { tooltip: { expression: attrText(a.title), ruEn: ruEn([a.title]) } } : {}), ...(defaultBinding ? { defaultBinding } : {}), ...(expression.includes('MAP_COPY') ? { dictionary: 'mapCopy' } : expression.includes('taskLabels') ? { dictionary: 'botTasks' } : expression.includes('groupLabels') ? { dictionary: 'targetGroups' } : expression.includes('.label[lang]') ? { dictionary: 'serverInteractionTemplates' } : expression.includes('.name[lang]') ? { dictionary: 'bodyNames-and-runtime-entity-name' } : {}) };
}
function actionRefs(node) {
  const result = new Set();
  visit(node, n => { if (ts.isPropertyAssignment(n) && text(n.name) === 'type' && ts.isStringLiteral(n.initializer) && actionNames.includes(n.initializer.text)) result.add(n.initializer.text); });
  return [...result].sort();
}
function handler(value, near) {
  if (value === true) return { expression: 'true' };
  const result = { expression: text(value), directActionTypes: actionRefs(value) };
  let decl;
  if (ts.isIdentifier(value)) decl = declaration(value.text, near);
  if (ts.isPropertyAccessExpression(value) && value.expression.kind === ts.SyntaxKind.ThisKeyword) { const klass = [...definitions.values()].flat().find(d => ts.isClassDeclaration(d.node) && d.node.name?.text === owner(near)); const member = klass?.node.members.find(m => m.name && text(m.name) === value.name.text); if (member) decl = { node: member, file: near.getSourceFile().fileName }; }
  if (decl) { result.definition = location(decl.node); result.implementation = text(decl.node); result.directActionTypes = [...new Set([...result.directActionTypes, ...actionRefs(decl.node)])].sort(); }
  else if (ts.isIdentifier(value)) result.binding = 'component prop or lexical binding; inspect componentInstances/source reference';
  return result;
}
const controls = [], customCandidates = [], imperative = [], suppliers = [], labelActivators = [], canvases = [], seen = new Map();
function identify(prefix, node, semantics) {
  const raw = `${node.getSourceFile().fileName}|${owner(node)}|${compact(semantics)}`, base = `${prefix}:${owner(node)}:${sha(raw).slice(0, 14)}`, occurrence = (seen.get(base) ?? 0) + 1; seen.set(base, occurrence);
  return occurrence === 1 ? base : `${base}:${occurrence}`;
}
const intrinsic = new Set(['button', 'select', 'input', 'textarea', 'a', 'details', 'summary', 'canvas']);
for (const [file, source] of sources) {
  if (!file.startsWith(client + '/')) continue;
  visit(source, node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = text(node.tagName), a = attrs(node), events = Object.keys(a).filter(name => /^on[A-Z]/.test(name)), ctx = context(node);
      if (tag === 'label') labelActivators.push({ id: identify('label', node, text(node.parent)), component: owner(node), source: location(node), elementUtf16End: ts.isJsxOpeningElement(node) ? node.parent.end : node.end, htmlFor: attrText(a.htmlFor), textExpression: ts.isJsxOpeningElement(node) ? node.parent.children.map(text).join(' ') : '', ...ctx });
      if (/^[a-z]/.test(tag) && (intrinsic.has(tag) || events.length || a.tabIndex || a.contentEditable || a.role && /button|slider|switch|textbox/.test(attrText(a.role)))) {
        const handlers = Object.fromEntries(events.map(event => [event, handler(a[event], node)])), descriptor = label(node, a);
        const entry = { id: identify('ui', node, `${tag}|${descriptor.expression}|${JSON.stringify(Object.fromEntries(events.map(e => [e, attrText(a[e])])))}|${JSON.stringify(ctx.conditions)}`), component: owner(node), tag, source: location(node), label: descriptor, attributes: Object.fromEntries(Object.entries(a).filter(([key]) => !/^on[A-Z]/.test(key)).map(([key, value]) => [key, attrText(value)])), handlers, ...ctx, acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' };
        if (tag === 'select' && ts.isJsxOpeningElement(node)) { entry.choices = []; visit(node.parent, option => { if (ts.isJsxOpeningElement(option) && text(option.tagName) === 'option') { const oa = attrs(option); entry.choices.push({ value: attrText(oa.value), label: label(option, oa), ...context(option), source: location(option) }); } }); }
        controls.push(entry);
      } else if (/^[A-Z]/.test(tag)) customCandidates.push({ id: identify('instance', node, `${tag}|${JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, attrText(v)])))}|${JSON.stringify(ctx.conditions)}`), parentComponent: owner(node), component: tag, source: location(node), props: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, attrText(v)])), label: label(node, a), ...(tag === 'WorldMap' ? { mode: a.onMark ? 'marker interaction enabled by prop' : 'display only; surrounding minimap button handles opening' } : {}), ...ctx });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener') imperative.push({ id: identify('event', node, text(node)), kind: 'registered-event', component: owner(node), target: text(node.expression.expression), event: literal(node.arguments[0]), handler: handler(node.arguments[1], node), options: text(node.arguments[2]), source: location(node), ...context(node), acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' });
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && /^on[A-Z]/.test(node.left.name.text)) imperative.push({ id: identify('binding', node, text(node)), kind: 'imperative-callback-binding', component: owner(node), target: text(node.left), handler: handler(node.right, node), source: location(node), ...context(node), acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' });
    if (ts.isCallExpression(node) && text(node.expression) === 'useGameInput') imperative.push({ id: identify('hook', node, text(node)), kind: 'keyboard-touch-input-hook-instance', component: owner(node), target: 'useGameInput', expression: text(node), source: location(node), acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' });
    if (ts.isCallExpression(node) && /(?:^|\.)setInterval$/.test(text(node.expression)) && owner(node) === 'useGameInput') imperative.push({ id: identify('continuous', node, text(node)), kind: 'continuous-input-sampling', component: owner(node), target: 'keyboard/stick/tool/brake state → connection.setInput', expression: text(node), source: location(node), acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' });
    if (ts.isNewExpression(node) && text(node.expression) === 'ResizeObserver') imperative.push({ id: identify('viewport', node, text(node)), kind: 'viewport-size-observer', component: owner(node), target: 'canvas/layout size', expression: text(node), source: location(node), acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' });
    if (ts.isNewExpression(node) && text(node.expression) === 'THREE.WebGLRenderer') canvases.push({ id: identify('canvas', node, text(node)), tag: 'canvas', creation: text(node), component: owner(node), source: location(node) });
    if (ts.isNewExpression(node) && text(node.expression) === 'TyagaScene') imperative.push({ id: identify('scene-instance', node, text(node)), kind: 'imperative-scene-instance', component: owner(node), target: 'TyagaScene', expression: text(node), source: location(node), acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' });
    if (ts.isCallExpression(node) && text(node.expression) === 'useEffect' && ['useGameInput', 'HoldButton', 'TouchControls'].includes(owner(node))) imperative.push({ id: identify('release-effect', node, text(node)), kind: 'input-release-lifecycle', component: owner(node), expression: text(node), dependencies: text(node.arguments[1]), source: location(node), acceptance: 'NOT_TESTED_BY_SOURCE_INVENTORY' });
  });
}
const interactiveComponents = new Set(controls.map(control => control.component));
for (let changed = true; changed;) {
  changed = false;
  for (const instance of customCandidates) if (interactiveComponents.has(instance.component) && !interactiveComponents.has(instance.parentComponent)) { interactiveComponents.add(instance.parentComponent); changed = true; }
}
const instances = customCandidates.filter(instance => interactiveComponents.has(instance.component) || instance.component.endsWith('.Provider'));
for (const instance of instances) instance.controlTemplateIds = controls.filter(c => c.component === instance.component).map(c => c.id);
for (const activator of labelActivators) activator.activatesControlTemplateIds = controls.filter(c => c.component === activator.component && c.source.file === activator.source.file && ((activator.htmlFor && c.attributes.id === activator.htmlFor) || (c.source.utf16Start > activator.source.utf16Start && c.source.utf16End < activator.elementUtf16End))).map(c => c.id);
for (const canvas of canvases) {
  canvas.eventEntryIds = imperative.filter(e => e.component === canvas.component && e.kind === 'registered-event' && e.target === 'canvas').map(e => e.id);
  canvas.interactive = !!canvas.eventEntryIds.length;
  canvas.attributeStatements = [];
  visit(sources.get(canvas.source.file), node => { if (owner(node) === canvas.component && ((ts.isCallExpression(node) && /\.domElement\.setAttribute$/.test(text(node.expression))) || (ts.isBinaryExpression(node) && /\.domElement\.tabIndex$/.test(text(node.left))))) canvas.attributeStatements.push({ expression: text(node), source: location(node) }); });
  canvas.acceptance = 'NOT_TESTED_BY_SOURCE_INVENTORY';
}
const expanded = [];
function expand(component, mountPath = [], inheritedConditions = [], inheritedRepeats = [], trail = []) {
  if (trail.includes(component)) return;
  for (const control of controls.filter(c => c.component === component)) expanded.push({ id: `mounted:${sha(control.id + '|' + mountPath.join('|')).slice(0, 18)}`, controlTemplateId: control.id, component, mountPath, inheritedConditions, inheritedRepeats, repeats: control.repeats, note: 'source mount path, not an enumerated runtime DOM instance or acceptance result' });
  for (const instance of instances.filter(c => c.parentComponent === component && !c.component.endsWith('.Provider'))) expand(instance.component, [...mountPath, instance.id], [...inheritedConditions, ...instance.conditions], [...inheritedRepeats, ...instance.repeats], [...trail, component]);
}
expand('App');
const interactionSource = sources.get('games/tyaga/src/server-world/actions.ts');
visit(interactionSource, node => { if (ts.isCallExpression(node) && text(node.expression) === 'push' && owner(node) === 'interactionsFor' && node.arguments.length >= 4) suppliers.push({ id: identify('server-action', node, text(node.arguments[0])), runtimeIdExpression: text(node.arguments[0]), label: { ru: literal(node.arguments[1]), en: literal(node.arguments[2]) }, action: text(node.arguments[3]), actionTypes: actionRefs(node.arguments[3]), targetId: text(node.arguments[4]), availability: text(node.arguments[5]) || "'OK' plus push() reach/operation/control/hands gates", socket: text(node.arguments[6]), ...context(node), source: location(node) }); });
const body = definitions.get('BODY')[0].node.initializer, bodyNames = {};
for (const prop of body.properties) if (ts.isPropertyAssignment(prop) && ts.isCallExpression(prop.initializer)) bodyNames[text(prop.name).replaceAll("'", '')] = { ru: literal(prop.initializer.arguments[4]), en: literal(prop.initializer.arguments[5]) };
const mapInventory = {};
visit(sources.get('games/tyaga/src/maps/index.ts'), node => { if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) { const props = new Map(node.expression.properties.filter(ts.isPropertyAssignment).map(p => [text(p.name), p.initializer])); if (props.has('tools') && props.has('cargo')) mapInventory[owner(node)] = { cargo: literal(props.get('cargo')), initialTools: literal(props.get('tools')), source: location(node) }; } });
const keyboard = [];
for (const [file, source] of sources) if (file.startsWith(client + '/')) visit(source, node => {
  if (ts.isIfStatement(node) && /(?:event|e)\.code/.test(text(node.expression))) keyboard.push({ component: owner(node), condition: text(node.expression), onMatch: text(node.thenStatement), otherwise: text(node.elseStatement), source: location(node) });
});
const coverageText = await fs.readFile(path.join(root, 'games/tyaga/UI_COVERAGE.md'), 'utf8');
const coverageGroups = [...coverageText.matchAll(/^\| (U\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map(m => ({ id: m[1], scope: m[2].trim(), required: m[3].trim(), authoredStatus: m[4].trim(), statusMeaning: 'copied verbatim from coverage plan; not awarded by generator' }));
const css = await fs.readFile(path.join(root, client, 'styles.css'), 'utf8');
const stateRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /:hover|:focus|:active|:disabled|\[disabled\]|\.selected|\.held|\.holding/.test(m[1])).map(m => ({ selector: m[1].trim(), declarations: m[2], utf16Start: m.index, sha256: sha(m[0]) }));
const labelBindings = {};
for (const name of ['socketName', 'objectName', 'toolLabels', 'controllingName']) labelBindings[name] = (definitions.get(name) ?? []).map(d => ({ source: location(d.node), expression: text(d.node), ruEn: ruEn([d.node]) }));
const data = {
  schemaVersion: 1,
  generator: { script: 'scripts/tyaga-ui-inventory.mjs', sha256: sha(await fs.readFile(fileURLToPath(import.meta.url))), command: 'node scripts/tyaga-ui-inventory.mjs', checkCommand: 'node scripts/tyaga-ui-inventory.mjs --check' },
  basis: 'Current source expressions parsed by TypeScript AST. No browser was launched; no runtime element or state receives PASS.',
  scope: { root: client, included: ['native JSX controls', 'native label activation areas', 'custom control component call sites and finite mount paths', 'option templates', 'imperatively created canvases', 'event listeners and callback bindings', 'keyboard branches and continuous input', 'server-generated interaction templates', 'source CSS state selectors'], boundary: 'Portal destinations /games, /friends and sign-in are external shared UI. Their link controls here are inventoried; their destination pages are not silently counted as scanned.' },
  idPolicy: 'file + owner + tag/label/handler/conditions semantic hash; source blob hashes and UTF-16 ranges resolve the exact occurrence. Lines are convenience only.',
  dynamicPolicy: 'A source template is not a runtime count. Expand each repeat and component call site over its stated source/runtime domain; never invent participant, item, socket, friend or room IDs.',
  analysisLimits: ['Label expressions preserve source text and RU/EN alternatives; they are not a browser-computed accessible-name audit.', 'Conditions are lexical ancestor branches, not a proof that a state is reachable. Read the source owner for preceding early returns and indirect guards.', 'Handler action types are direct AST literals and resolved local declarations; dynamic actions flow through component props and serverInteractionTemplates.', 'The template census includes display-only call sites of an otherwise interactive component, such as the minimap, and explicitly marks those call sites.'],
  requiredRuntimeStates: ['ordinary', 'hover where applicable', 'keyboard focus', 'pressed/held', 'selected/checked/expanded', 'disabled with reason', 'waiting', 'success', 'error', 'repeat/cancel', 'keyboard', 'touch', 'small viewport', 'orientation change', 'focus loss', 'input release'],
  sourceFiles: fingerprints,
  domains: { playerLimits: { min: game.minPlayers, max: game.maxPlayers, seatIndices: Array.from({ length: game.maxPlayers }, (_, i) => i), source: 'packages/game-registry/games.json#tyaga' }, mapCopy, mapInventory, botTasks: tasks, targetGroups: valueOf('groupLabels'), bodyNames, labelBindings, actionTypes: actionNames, serverInteractionTemplates: suppliers },
  summary: { nativeTemplates: controls.length, byTag: Object.fromEntries([...new Set([...intrinsic, ...controls.map(c => c.tag)])].sort().map(tag => [tag, controls.filter(c => c.tag === tag).length])), componentCallSites: instances.length, sourceMountPaths: expanded.length, labelActivationAreas: labelActivators.length, optionTemplates: controls.reduce((n, c) => n + (c.choices?.length ?? 0), 0), constructedCanvases: canvases.length, interactiveCanvases: canvases.filter(c => c.interactive).length, imperativeEntries: imperative.length, keyboardBranches: keyboard.length, serverInteractionTemplates: suppliers.length, coverageGroups: coverageGroups.length },
  controls, componentInstances: instances, sourceMountedControls: expanded, labelActivationAreas: labelActivators, imperativeCanvases: canvases, imperativeControls: imperative, keyboardBranches: keyboard, cssStateRules: stateRules, coverageGroups,
};
const serialized = JSON.stringify(data, null, 2) + '\n';
if (check) {
  const previous = await fs.readFile(output, 'utf8').catch(() => '');
  if (previous !== serialized) { console.error('UI inventory is missing or stale for the scanned source blobs. Regenerate it.'); process.exitCode = 1; }
  else console.log(JSON.stringify({ current: true, ...data.summary, output: path.relative(root, output) }));
} else { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, serialized); console.log(JSON.stringify({ generated: true, ...data.summary, output: path.relative(root, output) })); }

#!/usr/bin/env node
/** Source-only inventory of the shared portal boundary used by Tyaga.
 * Never mounts React, executes handlers, starts services, or sends requests. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--check' || arg.startsWith('--out=')), 'Use --check and/or --out=path.json');
const output = resolve(root, args.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'games/tyaga/qa/PORTAL_ENTRY_ELEMENTS.json');
const sha = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const compact = value => value.replace(/\s+/g, ' ').trim();
const raw = node => node?.getText() ?? '';
const unwrap = node => node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) ? unwrap(node.expression) : node;
const visit = (node, fn) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };
const contains = (outer, inner) => inner.pos >= outer.pos && inner.end <= outer.end;
const files = [
  'apps/portal/src/App.tsx', 'apps/portal/src/Auth.tsx', 'apps/portal/src/Catalogue.tsx',
  'apps/portal/src/TelegramSignIn.tsx', 'apps/portal/src/ui.tsx', 'apps/portal/src/navigation.tsx',
  'apps/portal/src/api.ts', 'apps/portal/src/types.ts', 'apps/portal/src/gameCopy.ts',
  'apps/portal/src/links.ts', 'packages/game-registry/src/index.ts', 'packages/game-registry/games.json',
].sort();
const sources = new Map(), sourceFiles = [];
for (const file of files) {
  const bytes = await readFile(resolve(root, file));
  sourceFiles.push({ file, bytes: bytes.length, sha256: sha(bytes), gitBlobSha1: sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1') });
  if (/\.tsx?$/.test(file)) sources.set(file, ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
}
const registry = JSON.parse(await readFile(resolve(root, 'packages/game-registry/games.json'), 'utf8'));
const tyaga = registry.games.find(game => game.gameId === 'tyaga'); assert.ok(tyaga?.realtime);
function location(node) {
  const source = node.getSourceFile(), start = node.getStart(source), point = source.getLineAndCharacterOfPosition(start);
  return { file: source.fileName, utf16Start: start, utf16End: node.end, line: point.line + 1, column: point.character + 1, nodeSha256: sha(raw(node)) };
}
function owner(node) {
  for (let current = node; current; current = current.parent) if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
  return '(module)';
}
function fn(file, name) {
  const result = sources.get(file).statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(result, `Missing source component ${file}:${name}`); return result;
}
const app = fn('apps/portal/src/App.tsx', 'App');
const components = new Map([
  ['App', app], ['Auth', fn('apps/portal/src/Auth.tsx', 'Auth')],
  ['Catalogue', fn('apps/portal/src/Catalogue.tsx', 'Catalogue')],
  ['TelegramSignIn', fn('apps/portal/src/TelegramSignIn.tsx', 'TelegramSignIn')],
  ...['Brand', 'Modal', 'Empty'].map(name => [name, fn('apps/portal/src/ui.tsx', name)]),
  ['PortalLink', fn('apps/portal/src/navigation.tsx', 'PortalLink')],
  ...['CreateRoom', 'RoomDetail'].map(name => [name, fn('apps/portal/src/App.tsx', name)]),
]);
const opening = node => ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
function attributes(node) {
  return Object.fromEntries(opening(node).attributes.properties.filter(ts.isJsxAttribute).map(attribute => [raw(attribute.name),
    attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer ?? true]));
}
const attributeSource = value => value === true ? 'true' : raw(value);
const tag = node => raw(opening(node)?.tagName);
function hasClass(node, name) {
  if (!opening(node)) return false;
  const value = attributes(node).className;
  return value && ts.isStringLiteralLike(value) && value.text.split(/\s+/).includes(name);
}
function only(container, predicate, description) {
  const found = []; visit(container, node => { if (predicate(node)) found.push(node); });
  assert.equal(found.length, 1, `${description}: expected one source region, found ${found.length}`); return found[0];
}
const regionNodes = [], regions = [];
function region(id, node, scope, scopeConditions = []) {
  regionNodes.push({ id, node }); regions.push({ id, component: owner(node), source: location(node), scope, scopeConditions, status: 'NOT_TESTED' });
}
for (const [id, className] of [
  ['language', 'language-switch'], ['guest-navigation', 'guest-games'], ['mobile-account', 'mobile-account'],
  ['signed-navigation', 'sidebar'], ['page-heading', 'page-heading'], ['connection-feedback', 'connection-banner'],
  ['email-verification-gate', 'verification-banner'], ['room-list', 'rooms-section'],
]) region(`App:${id}`, only(app, node => hasClass(node, className), className), id);
region('App:notice', only(app, node => opening(node) && attributeSource(attributes(node).className).includes('toast ${notice.error'), 'notice'), 'Shared success/error notice and dismissal');
const loadingRegions = []; visit(app, node => { if (hasClass(node, 'loading-page')) loadingRegions.push(node); });
assert.equal(loadingRegions.length, 2);
loadingRegions.forEach((node, index) => region(`App:session-loading-${index}`, node, 'Session loading/error and retry'));
region('App:room-loading', only(app, node => hasClass(node, 'loading-section'), 'room-loading'), 'Opening selected room and return to room list');
for (const name of ['Auth', 'Catalogue', 'CreateRoom', 'RoomDetail']) region(`App:mount-${name}`, only(app, node => tag(node) === name, `App mount ${name}`),
  `Shared ${name} mount`, name === 'Catalogue' ? ["page in ['home','games']; mapped game controls are restricted to game.gameId === 'tyaga'"] : name === 'RoomDetail' ? ["selectedRoom.gameId === 'tyaga'"] : []);
region('App:tyaga-preview', only(app, node => tag(node) === 'Modal' && attributeSource(attributes(node).onClose).includes('setGameInfo(null)'), 'game preview'),
  'Unavailable Tyaga catalogue preview', ["gameInfo.gameId === 'tyaga'"]);
for (const name of ['Auth', 'TelegramSignIn', 'Brand', 'Modal', 'Empty', 'PortalLink']) region(`${name}:shared`, components.get(name), `Shared ${name} implementation`);
region('Catalogue:tyaga-entry', components.get('Catalogue'), 'Catalogue home/games navigation and Tyaga card template',
  ["page in ['home','games']; visibleGames.map is inventoried only for game.gameId === 'tyaga'; chess links are destination boundaries"]);
region('CreateRoom:tyaga-fields', components.get('CreateRoom'), 'Shared create-room form reachable from header/empty room list',
  ["selected gameId === 'tyaga'; game selector is a shared available-games domain; District settings components are excluded"]);
const realtimeReturn = only(components.get('RoomDetail'), node => ts.isIfStatement(node) && raw(node.expression).includes('realtimeRoutes[room.gameId]'), 'realtime RoomDetail branch');
region('RoomDetail:realtime-links', realtimeReturn, 'Realtime room summary, back and launch links', ["room.gameId === 'tyaga'; room.state !== 'cancelled'"]);

function alwaysReturns(node) {
  return ts.isReturnStatement(node) || ts.isBlock(node) && !!node.statements.length && alwaysReturns(node.statements.at(-1))
    || ts.isIfStatement(node) && !!node.elseStatement && alwaysReturns(node.thenStatement) && alwaysReturns(node.elseStatement);
}
function context(node) {
  const conditions = [], repeats = [], componentAncestors = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isBinaryExpression(current) && contains(current.right, node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(current.operatorToken.kind))
      conditions.push({ expression: raw(current.left), branch: current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'truthy' : 'falsy' });
    if (ts.isConditionalExpression(current) && (contains(current.whenTrue, node) || contains(current.whenFalse, node)))
      conditions.push({ expression: raw(current.condition), branch: contains(current.whenTrue, node) ? 'true' : 'false' });
    if (ts.isIfStatement(current) && (contains(current.thenStatement, node) || current.elseStatement && contains(current.elseStatement, node)))
      conditions.push({ expression: raw(current.expression), branch: contains(current.thenStatement, node) ? 'true' : 'false' });
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'map') {
      const expression = raw(current.expression.expression), input = unwrap(current.expression.expression);
      repeats.push({ expression, bindings: current.arguments.flatMap(argument => ts.isArrowFunction(argument) ? argument.parameters.map(raw) : []),
        domain: input && ts.isArrayLiteralExpression(input) ? { kind: 'literal', values: input.elements.map(item => ts.isStringLiteralLike(item) ? item.text : raw(item)) }
          : expression === 'rooms' ? { kind: 'account-room-ids', identity: 'room.roomId', filter: 'For Tyaga detail review select returned room.gameId === tyaga; the source list itself is not filtered by game' }
            : expression === 'visibleGames' ? { kind: 'catalogue-game-id', restriction: "game.gameId === 'tyaga'", source: 'games.filter in Catalogue' }
              : expression === 'games' ? { kind: 'available-game-id', identity: 'item.gameId', restriction: 'Review the Tyaga option; other game forms are not inventoried' }
                : expression.startsWith('Array.from') ? { kind: 'tyaga-seat-count', min: tyaga.minPlayers, max: tyaga.maxPlayers, assumption: 'game metadata returned by API matches the recorded registry' }
                  : { kind: 'runtime-expression', expression } });
    }
    if (ts.isJsxElement(current) && /^[A-Z]/.test(tag(current))) componentAncestors.push(tag(current));
    if (ts.isBlock(current.parent) && current.parent.statements.includes(current)) {
      for (const previous of current.parent.statements) {
        if (previous === current) break;
        if (ts.isIfStatement(previous) && !previous.elseStatement && alwaysReturns(previous.thenStatement)) conditions.push({ expression: raw(previous.expression), branch: 'false', reason: 'Earlier unconditional-return branch in the same block' });
      }
    }
    if (ts.isFunctionDeclaration(current)) break;
  }
  return { conditions: conditions.reverse(), repeats: repeats.reverse(), componentAncestors: componentAncestors.reverse() };
}
function translations(nodes) {
  const found = [];
  for (const node of nodes.filter(item => item && item !== true)) visit(node, current => {
    if (ts.isCallExpression(current) && raw(current.expression) === 't' && current.arguments.length >= 2)
      found.push({ ru: ts.isStringLiteralLike(current.arguments[0]) ? current.arguments[0].text : { expression: raw(current.arguments[0]) },
        en: ts.isStringLiteralLike(current.arguments[1]) ? current.arguments[1].text : { expression: raw(current.arguments[1]) }, expression: raw(current) });
  });
  return [...new Map(found.map(value => [JSON.stringify(value), value])).values()];
}
const selected = new Set(); for (const item of regionNodes) visit(item.node, node => { if (opening(node)) selected.add(node); });
const regionIds = node => regionNodes.filter(item => contains(item.node, node)).map(item => item.id);
const testStates = Object.fromEntries(['default','hover','focus','pressed','disabled_with_reason','pending','success','error','keyboard','touch','small_screen','orientation','focus_loss','release'].map(name => [name, 'NOT_TESTED']));
const controls = [], componentInstances = [], labels = [], ids = new Map(), occurrences = new Map();
function identity(node, kind) {
  const prefix = `${kind}:${owner(node)}:${tag(node)}:${sha(raw(node)).slice(0, 14)}`;
  const ordinal = (occurrences.get(prefix) ?? 0) + 1; occurrences.set(prefix, ordinal);
  return `${prefix}:${ordinal}`;
}
function namedDefinition(name, near) {
  let found;
  visit(components.get(owner(near)) ?? near.getSourceFile(), node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && owner(node) === owner(near)) found ??= node;
  });
  return found ? { source: location(found), declaration: raw(found) } : null;
}
function record(node, id) {
  const attrs = attributes(node), children = ts.isJsxElement(node) ? node.children : [], handlerEntries = Object.entries(attrs).filter(([key]) => /^on[A-Z]/.test(key));
  let label = node.parent;
  while (label && !ts.isFunctionDeclaration(label) && !(ts.isJsxElement(label) && tag(label) === 'label')) label = label.parent;
  const labelledBy = label && ts.isJsxElement(label) && tag(label) === 'label' ? label : null;
  return { id, component: owner(node), tag: tag(node), source: location(node), regions: regionIds(node), ...context(node),
    reviewScopeConditions: regions.filter(item => regionIds(node).includes(item.id)).flatMap(item => item.scopeConditions),
    attributes: Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, attributeSource(value)])),
    spreadAttributes: opening(node).attributes.properties.filter(ts.isJsxSpreadAttribute).map(attribute => raw(attribute.expression)),
    labels: { childExpressions: children.map(raw).filter(value => value.trim()), literalText: children.filter(ts.isJsxText).map(item => compact(item.text)).filter(Boolean),
      translations: translations([...children, attrs['aria-label'], attrs.title, attrs.placeholder, ...(labelledBy ? [labelledBy] : [])]),
      wrappingLabel: labelledBy ? location(labelledBy) : null, note: 'Source expressions, not a measured browser accessible name' },
    handlers: Object.fromEntries(handlerEntries.map(([key, value]) => [key, { expression: attributeSource(value),
      namedDefinition: value && value !== true && ts.isIdentifier(value) ? namedDefinition(value.text, node) : null }])),
    status: 'NOT_TESTED', requiredRuntimeStates: { ...testStates } };
}
for (const node of [...selected].sort((a, b) => a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) || a.pos - b.pos)) {
  const name = tag(node), attrs = attributes(node);
  if (/^[a-z]/.test(name) && (['button','a','input','select','textarea','form','dialog','summary'].includes(name) || Object.keys(attrs).some(key => /^on[A-Z]/.test(key)))) {
    const id = identity(node, 'portal-ui'); ids.set(node, id); controls.push(record(node, id));
  } else if (components.has(name)) {
    const id = identity(node, 'portal-instance'); ids.set(node, id); componentInstances.push({ ...record(node, id), implementation: location(components.get(name)) });
  } else if (name === 'label') labels.push({ id: identity(node, 'portal-label'), source: location(node), component: owner(node), regions: regionIds(node), ...context(node),
    translations: translations([node]), childControlIds: [], status: 'NOT_TESTED' });
}
for (const label of labels) label.childControlIds = controls.filter(control => control.source.file === label.source.file && control.source.utf16Start >= label.source.utf16Start && control.source.utf16End <= label.source.utf16End).map(control => control.id);
for (const control of controls) {
  const node = [...ids].find(([, id]) => id === control.id)[0];
  let parent = node.parent;
  while (parent && !ts.isFunctionDeclaration(parent) && !(opening(parent) && tag(parent) === 'form')) parent = parent.parent;
  control.formControlId = parent && opening(parent) ? ids.get(parent) ?? null : null;
  control.optionTemplates = [];
  if (control.tag === 'select') visit(node, child => {
    if (opening(child) && tag(child) === 'option') control.optionTemplates.push({ source: location(child), attributes: Object.fromEntries(Object.entries(attributes(child)).map(([key, value]) => [key, attributeSource(value)])),
      labelExpression: ts.isJsxElement(child) ? child.children.map(raw).join('') : '', ...context(child), status: 'NOT_TESTED' });
  });
}
const mountedControls = [];
function mount(component, path = [], inheritedConditions = [], inheritedRepeats = [], seen = []) {
  assert.ok(!seen.includes(component), `Unexpected recursive component boundary: ${[...seen, component].join(' -> ')}`);
  for (const control of controls.filter(item => item.component === component)) mountedControls.push({
    id: `portal-mounted:${sha([control.id, ...path].join('|')).slice(0, 18)}`, controlId: control.id, instancePath: path,
    conditions: [...inheritedConditions, ...control.conditions], repeats: [...inheritedRepeats, ...control.repeats], status: 'NOT_TESTED',
  });
  for (const instance of componentInstances.filter(item => item.component === component))
    mount(instance.tag, [...path, instance.id], [...inheritedConditions, ...instance.conditions], [...inheritedRepeats, ...instance.repeats], [...seen, component]);
}
mount('App');
const sharedHandlers = [];
for (const [component, names] of [['App',['perform','mutate','refresh']], ['Auth',['submit']], ['TelegramSignIn',['start','finish']], ['PortalLink',['follow']]])
  for (const name of names) { const definition = namedDefinition(name, components.get(component)); assert.ok(definition, `Missing handler ${component}.${name}`); sharedHandlers.push({ component, name, ...definition, status: 'NOT_TESTED' }); }
for (const [file, names] of [['apps/portal/src/api.ts',['request','getSession']], ['apps/portal/src/navigation.tsx',['go','navigate','readRoute']], ['apps/portal/src/App.tsx',['gameReturnPath']], ['apps/portal/src/Auth.tsx',['readEntrance']]])
  for (const name of names) { const definition = fn(file, name); sharedHandlers.push({ component: '(module)', name, source: location(definition), declaration: raw(definition), status: 'NOT_TESTED' }); }
const sourceEffects = [];
for (const component of ['App', 'Modal']) visit(components.get(component), node => {
  if (ts.isCallExpression(node) && raw(node.expression) === 'useEffect'
    && (component === 'Modal' || /document\.documentElement\.lang|window\.addEventListener\("(?:hashchange|popstate|focus)"|document\.addEventListener\("visibilitychange"/.test(raw(node))))
    sourceEffects.push({ component, source: location(node), expression: raw(node), status: 'NOT_TESTED', purpose: 'Source lifecycle only: language, route/visibility refresh or modal focus restoration; no listeners executed by this generator' });
});
function typeStrings(node) {
  const values = []; visit(node, child => { if (ts.isLiteralTypeNode(child) && ts.isStringLiteralLike(child.literal)) values.push(child.literal.text); });
  return [...new Set(values)];
}
const roomStateType = sources.get('apps/portal/src/types.ts').statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'RoomState'); assert.ok(roomStateType);
const authMode = only(components.get('Auth'), node => ts.isCallExpression(node) && raw(node.expression) === 'useState' && raw(node.arguments[0]) === '"login"', 'Email mode source');
const friendsGuard = only(app, node => ts.isBinaryExpression(node) && compact(raw(node.left)) === 'verified && route.page === "friends"', 'Friends landing boundary');
const genericRoomReturn = components.get('RoomDetail').body.statements.find(ts.isReturnStatement); assert.ok(genericRoomReturn);
const result = {
  schema: 'iva-tyaga-portal-entry-elements@1', kind: 'source-only scoped inventory', status: 'NOT_TESTED', browserChecksPerformed: 0,
  sourceBasis: 'Exact current working-tree bytes. Hashes identify the source snapshot; no HEAD, build, deployment or browser acceptance is inferred.',
  scope: { included: ['Local email login/register/reset/verify branches', 'Telegram login source branch', 'Shared language/header/nav/loading/notice/verification controls',
    'Catalogue home/games and Tyaga card/preview', 'Account room list, clear/restore, shared Tyaga create-room fields', 'Realtime Tyaga RoomDetail back/launch', 'Friends destination and navigation back'],
    excluded: ['Other games and their complete UI/components', 'Profile editor and Telegram linking panel', 'Invitations/friend search/request/accept/block/send controls',
      'Remote Telegram bot UI and real message delivery', 'Cancelled-room generic fallback beyond the recorded boundary', 'Rendered focus/hover/touch, real accounts or runtime states'],
    completeness: 'Complete only for the explicit AST regions below. Caller scope restrictions are review constraints, not additional source guards. Dynamic lists are templates; source conditions do not prove runtime reachability.' },
  sourceFiles, regions,
  domains: { languages: ['ru','en'], emailModes: { values: typeStrings(authMode.typeArguments[0]), source: location(authMode) }, entrance: [null,'verify','reset'],
    authMethods: { source: 'apps/portal/src/types.ts#AuthMethods', branches: [
      { id: 'telegram-enabled', condition: '!entrance && auth?.telegram', meaning: 'Telegram branch takes precedence when enabled; production activation must come from the actual session response', status: 'NOT_TESTED' },
      { id: 'email-disabled-unavailable', condition: '!entrance && !auth?.telegram && auth?.email === false', meaning: 'Unavailable-login copy plus guest-chess link; no email form', status: 'NOT_TESTED' },
      { id: 'email-local', condition: 'Neither preceding provider branch is selected; entrance = auth?.email === false ? null : requestedEntrance', meaning: 'Local QA email flow and its source alternatives; no claim that production enables email', status: 'NOT_TESTED' },
    ] },
    telegramStates: ['no attempt','attempt/code entry','profileRequired','busy','source API refusal/error'],
    tyagaRegistry: { title: tyaga.title, description: tyaga.description, minPlayers: tyaga.minPlayers, maxPlayers: tyaga.maxPlayers, route: tyaga.realtime.route, roomStatus: tyaga.roomStatus },
    accountRooms: { identity: 'roomId', gameRestrictionForDetailReview: 'tyaga', historyButtons: 'Shared account-level list; source POST bodies are {} with no gameId filter',
      states: typeStrings(roomStateType), stateTypeSource: location(roomStateType), hiddenCountCondition: 'hiddenRoomCount > 0' },
    catalogueStates: ['home collections','games with Tyaga available and launch URL','Tyaga unavailable/about preview','offline retry','empty returned catalogue'],
    safeFriendsBoundary: { route: '/friends', guard: raw(friendsGuard.left), source: location(friendsGuard.left),
      landingTitle: { ru: 'Друзья', en: 'Friends' }, returnControls: 'Shared sidebar catalogue/rooms links; no request or invitation handler is executed or inventoried', status: 'NOT_TESTED' } },
  controls, componentInstances, mountedControls, labelActivationAreas: labels, sharedHandlers, sourceEffects,
  boundaries: [
    { id: 'cancelled-tyaga-room', component: 'RoomDetail', condition: "room.gameId === 'tyaga' && room.state === 'cancelled'", source: location(genericRoomReturn),
      reason: 'The realtime fast path explicitly excludes cancelled rooms. Generic fallback controls are outside this narrow inventory and need a separate scoped review before claiming that path complete.', status: 'NOT_TESTED' },
    { id: 'friends-content', route: '/friends', source: location(friendsGuard.left), reason: 'Only route/heading/shared navigation are included. Friend requests, invitations, search and other social mutations are excluded and were not sent.', status: 'NOT_TESTED' },
    { id: 'external-telegram', source: location(components.get('TelegramSignIn')), reason: 'attempt.deepLink opens the external bot. The returned real URL and user/chat/code are runtime data and are not fabricated or exercised.', status: 'NOT_TESTED' },
    { id: 'other-destinations', routes: ['/profile','/invitations',chessHomeSource()], reason: 'Shared navigation links are listed; their destination product interfaces are not accepted or recursively scanned.', status: 'NOT_TESTED' },
  ],
  counts: { sourceFiles: sourceFiles.length, selectedRegions: regions.length, nativeControlTemplates: controls.length, componentInstances: componentInstances.length,
    mountedSourcePaths: mountedControls.length, labelActivationAreas: labels.length, browserPasses: 0 },
};
function chessHomeSource() { return "import.meta.env.DEV ? '/chess' : `${gameRegistry.chessOrigin}/`"; }
assert.ok(controls.some(control => control.attributes.onClick?.includes('/rooms/history/clear')));
assert.ok(controls.some(control => control.attributes.onClick?.includes('/rooms/history/restore')));
assert.ok(componentInstances.some(instance => instance.tag === 'TelegramSignIn'));
assert.ok(controls.some(control => control.component === 'RoomDetail' && control.tag === 'a'));
assert.ok(controls.every(control => !/invitations\/|friend-requests|social\/requests/.test(control.attributes.onClick ?? '')), 'A social mutation escaped the declared source boundary');
const serialized = JSON.stringify(result, null, 2) + '\n';
if (args.includes('--check')) assert.equal(await readFile(output, 'utf8'), serialized, 'Portal inventory is stale; regenerate it from the current source');
else { await mkdir(dirname(output), { recursive: true }); await writeFile(output, serialized); }
console.log(JSON.stringify({ output, mode: args.includes('--check') ? 'check' : 'generate', ...result.counts, status: 'NOT_TESTED' }));

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspacePatterns = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).workspaces
const paths = []
for (const pattern of workspacePatterns) {
  if (!pattern.endsWith('/*')) throw new Error('Unsupported workspace pattern: ' + pattern)
  const parent = pattern.slice(0, -2)
  for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = parent + '/' + entry.name
    try { await readFile(join(root, path, 'package.json')); paths.push(path) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
const packages = await Promise.all([...new Set(paths)].map(async path => ({
  path, directory: resolve(root, path), manifest: JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')),
})))
const byName = new Map(packages.map(pkg => [pkg.manifest.name, pkg]))
const failures = []
let checked = 0

async function sources(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}

for (const pkg of packages) {
  for (const file of await sources(join(pkg.directory, 'src'))) {
    checked++
    const tree = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const sourceIsCore = file.startsWith(join(pkg.directory, 'src', 'core') + sep)
    const check = specifier => {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        if (!target.startsWith(pkg.directory + sep)) failures.push(`${relative(root, file)}: relative import crosses package boundary: ${specifier}`)
        if (sourceIsCore && !target.startsWith(join(pkg.directory, 'src', 'core') + sep) && target !== join(pkg.directory, 'src', 'core')) {
          failures.push(`${relative(root, file)}: rules core imports outside its core: ${specifier}`)
        }
        return
      }
      if (pkg.manifest.name === '@chess-2/engine-sdk' || sourceIsCore) {
        failures.push(`${relative(root, file)}: pure rules/search imports an external dependency: ${specifier}`)
      }
      if (pkg.manifest.name === '@iva-games/realtime-kit' && /^(react(?:\/|$)|three(?:\/|$)|@dimforge\/|@iva-games\/(?:platform|realtime-server|tyaga|forpost)(?:\/|$))/.test(specifier)) {
        failures.push(`${relative(root, file)}: shared wire contract imports a renderer, game or server: ${specifier}`)
      }
      if (!specifier.startsWith('@chess-2/') && !specifier.startsWith('@iva-games/')) return
      const name = specifier.split('/').slice(0, 2).join('/')
      const dependency = byName.get(name)
      const exportPath = specifier === name ? '.' : '.' + specifier.slice(name.length)
      if (!dependency || !pkg.manifest.dependencies?.[name] || !dependency.manifest.exports?.[exportPath]) {
        failures.push(`${relative(root, file)}: undeclared workspace dependency/export: ${specifier}`)
      }
      if (pkg.path.startsWith('games/') && !['@chess-2/engine-sdk', '@iva-games/session-kit', '@iva-games/realtime-kit'].includes(name)) {
        failures.push(`${relative(root, file)}: a game depends on another game or server: ${specifier}`)
      }
      if (pkg.path === 'apps/portal' && ['@iva-games/platform', '@iva-games/telegram-transport'].includes(name)) {
        failures.push(`${relative(root, file)}: portal imports a server-only package: ${specifier}`)
      }
    }
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
}
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n')
  process.exitCode = 1
} else process.stdout.write(`Package boundaries valid across ${checked} source files; rules/search remain pure.\n`)

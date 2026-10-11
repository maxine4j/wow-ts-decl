#!/usr/bin/env node --experimental-transform-types --conditions development

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import luaparse from 'luaparse';
import { SemVer, valid, coerce } from 'semver';
import yargs from 'yargs';

import { API, APIEvent, APIFunction, APITable } from '#@/api.js';
import { isKeyValueField, toAPIDefinition, typesMaybeNotAccountedFor, visitedTypes } from '#@/lua-parser.js';
import type { FileAPIDocumentation } from '#@/types.js';

const argv = await yargs(process.argv.slice(2))
  .scriptName(basename(import.meta.filename))
  .command('$0 [targets..]', '')
  .demandCommand()
  .positional('targets', {
    describe: 'Branches (e.g. live, classic) or SemVer tags to scrape',
    default: ['live'],
    type: 'string',
    array: true,
  })
  .option('cache-dir', {
    describe: 'Directory to cache visited pages',
    default: '.cache',
    type: 'string',
  })
  .option('out-dir', {
    describe: 'Directory to emit output',
    default: '.tmp',
    type: 'string',
  })
  .option('repository', {
    describe: 'The repository with documentation to scrape',
    default: 'https://github.com/Gethe/wow-ui-source',
    type: 'string',
    array: false,
  })
  .help().argv;

const { targets, cacheDir, outDir, repository } = argv;

if (!existsSync(cacheDir)) {
  mkdirSync(cacheDir, { recursive: true });
}
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const tmpPath = resolve(process.cwd(), cacheDir);
const repositoryDirectory = resolve(tmpPath, basename(repository));

// 1. Initialize bare-bones repo with sparse checkout enabled
if (!existsSync(repositoryDirectory)) {
  mkdirSync(repositoryDirectory, { recursive: true });
  spawnSync('git', ['init'], { cwd: repositoryDirectory, stdio: 'ignore' });
  spawnSync('git', ['remote', 'add', 'origin', repository], { cwd: repositoryDirectory, stdio: 'ignore' });

  // Only check out the documentation folder
  spawnSync('git', ['sparse-checkout', 'init', '--cone'], { cwd: repositoryDirectory, stdio: 'ignore' });
  spawnSync(
    'git',
    ['sparse-checkout', 'set', 'Interface/AddOns/Blizzard_APIDocumentationGenerated'],
    { cwd: repositoryDirectory, stdio: 'ignore' }
  );
}

console.info('Scraping:', targets.join(', '));

for (const target of targets) {
  // 2. Fetch ONLY the single target commit without history or other refs
  // Works seamlessly whether target is a branch ('live', 'classic') or tag ('1.15.4')
  const fetchRes = spawnSync(
    'git',
    ['fetch', '--depth=1', '--filter=blob:none', 'origin', target],
    { cwd: repositoryDirectory, stdio: 'inherit' }
  );

  if (fetchRes.status !== 0) {
    console.error(`Failed to fetch target: ${target}`);
    continue;
  }

  // 3. Checkout FETCH_HEAD (only downloads blobs inside the sparse-checkout path)
  spawnSync('git', ['checkout', '--force', 'FETCH_HEAD'], { cwd: repositoryDirectory, stdio: 'inherit' });

  const documentationPath = join(repositoryDirectory, 'Interface', 'AddOns', 'Blizzard_APIDocumentationGenerated');

  if (!existsSync(documentationPath)) {
    console.warn(`Documentation directory not found for ${target}`);
    continue;
  }

  const files = readdirSync(documentationPath).filter((file) => file.endsWith('.lua'));
  const api = new API();

  // Handle version conversion whether it's semver or a named track like 'live'
  const resolvedVersion = valid(target) ? new SemVer(target) : (coerce(target) ?? new SemVer('0.0.0'));

  for (const file of files) {
    const fileContents = readFileSync(join(documentationPath, file), 'utf-8');
    const ast = luaparse.parse(fileContents);

    const definitionTable = ast.body.find((node) => node.type === 'LocalStatement');
    if (!definitionTable) continue;

    const [documentationTable] = definitionTable.init;
    if (documentationTable?.type !== 'TableConstructorExpression') {
      console.warn(`Table in ${file} was not the expected type of a TableConstructorExpression`);
      continue;
    }

    const {
      name,
      ns,
      events = [],
      functions = [],
      tables = [],
    } = documentationTable.fields
      .filter(isKeyValueField)
      .sort((l, r) => r.key.name.localeCompare(l.key.name))
      .reduce(toAPIDefinition, {} as Partial<FileAPIDocumentation>);

    if (name) {
      console.info('Parsed', name);
    }

    for (const func of functions.map((f) => new APIFunction({ ...f, version: resolvedVersion, ns }))) {
      api.addFunction(func);
    }

    for (const event of events.map((e) => new APIEvent({ ...e, version: resolvedVersion, ns }))) {
      api.addEvent(event);
    }

    for (const table of tables.map((e) => new APITable({ ...e, version: resolvedVersion, ns }))) {
      api.addTable(table);
    }
  }

  const output = resolve(outDir, `wow-ui-source-${target}.json`);
  writeFileSync(output, api.serialize());
}

const notAccountedFor = typesMaybeNotAccountedFor.difference(visitedTypes);
if (notAccountedFor.size) {
  console.warn('The following types were not accounted for:', notAccountedFor.values().toArray().join(', '));
}

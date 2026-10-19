import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('keeps inherited PDF automation ribbon buttons off by default', async () => {
  const settings = await readFile(new URL('src/settings.ts', root), 'utf8');
  for (const name of ['autoCopyToggleRibbonIcon', 'autoFocusToggleRibbonIcon', 'autoPasteToggleRibbonIcon']) {
    assert.equal(settings.match(new RegExp(`${name}: (true|false),`))?.[1], 'false', name);
  }
});

test('persisted v1 settings cannot recreate inherited automation ribbon buttons', async () => {
  const [main, autoCopy] = await Promise.all([
    readFile(new URL('src/main.ts', root), 'utf8'),
    readFile(new URL('src/auto-copy.ts', root), 'utf8'),
  ]);

  assert.doesNotMatch(autoCopy, /addRibbonIcon/);
  assert.doesNotMatch(main, /addRibbonIcon\([^\n]*(?:autoFocus|autoPaste)/);
  assert.doesNotMatch(main, /settings\.(?:autoFocusToggleRibbonIcon|autoPasteToggleRibbonIcon)/);
});

test('v2 release metadata is consistent across package and manifests', async () => {
  const read = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
  const [manifest, beta, pkg, lock, versions] = await Promise.all(
    ['manifest.json', 'manifest-beta.json', 'package.json', 'package-lock.json', 'versions.json'].map(read),
  );
  for (const item of [manifest, beta, pkg, lock, lock.packages['']]) assert.equal(item.version, '0.2.0');
  assert.equal(versions['0.2.0'], manifest.minAppVersion);
});

test('uses an independent desktop-only Margin AI identity', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const beta = JSON.parse(await readFile(new URL('manifest-beta.json', root), 'utf8'));

  assert.equal(manifest.id, 'margin-ai');
  assert.equal(manifest.name, 'Margin AI');
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(beta.id, 'margin-ai');
  assert.equal(beta.name, 'Margin AI');
});

test('does not register the PDF++ protocol or updater', async () => {
  const main = await readFile(new URL('src/main.ts', root), 'utf8');
  assert.doesNotMatch(main, /registerObsidianProtocolHandler\(['"]pdf-plus/);
  assert.doesNotMatch(main, /this\.registerAutoCheckForUpdates\(\)/);
});

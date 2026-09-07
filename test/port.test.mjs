import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listenOnSavedPort } from '../port.mjs';

test('random port persists across restarts and stays unchanged on collision', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compressor-port-test-'));
  const filename = path.join(dir, 'port');
  const first = createServer(), second = createServer(), blocked = createServer();
  try {
    const port = await listenOnSavedPort(first, filename);
    assert.ok(port >= 10000 && port < 60000);
    assert.equal(Number(await readFile(filename, 'utf8')), port);
    await new Promise(resolve => first.close(resolve));
    assert.equal(await listenOnSavedPort(second, filename), port);
    await assert.rejects(listenOnSavedPort(blocked, filename), /already in use/);
    assert.equal(Number(await readFile(filename, 'utf8')), port);
  } finally {
    for (const server of [first, second, blocked]) if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid saved port is rejected without overwriting it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compressor-port-test-'));
  const filename = path.join(dir, 'port');
  try {
    await writeFile(filename, 'invalid');
    await assert.rejects(listenOnSavedPort(createServer(), filename), /Invalid port/);
    assert.equal(await readFile(filename, 'utf8'), 'invalid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newOutput, safeFile, mapPath, exitCode } from '../../tools/downloader/core.mjs';
import { verify } from '../../tools/downloader/verify.mjs';

test('query order, case and Windows-reserved names never alias', () => {
  const urls = ['/a?x=1&y=2','/a?y=2&x=1','/a?x=2','/A','/a','/CON','/%E4%B8%AD%20%E6%96%87'];
  const paths = urls.map(x => mapPath('http://127.0.0.1:1234'+x, 'text/css'));
  assert.equal(new Set(paths.map(x => x.toLowerCase())).size, urls.length);
  for (const p of paths) assert.match(p, /^site\/objects\/[a-f0-9]+\.css$/);
});
test('never reuse a user directory; reject traversal and linked ancestors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'downloader-test-'));
  try {
    assert.throws(() => newOutput(root));
    const run = newOutput(path.join(root, 'new'));
    assert.throws(() => safeFile(run,'../escape'));
    assert.throws(() => safeFile(run,'site/../../escape'));
    const target = path.join(root,'target'); fs.mkdirSync(target);
    fs.symlinkSync(target,path.join(root,'link'),'junction');
    assert.throws(() => newOutput(path.join(root,'link','escape')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('empty evidence and internal failure cannot pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'downloader-test-'));
  try {
    fs.writeFileSync(path.join(root,'manifest.json'),'{}');
    assert.equal(verify(root).status,'failed');
    assert.equal(exitCode('complete'),0);
    for (const state of ['partial','failed','blocked','unknown']) assert.notEqual(exitCode(state),0);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

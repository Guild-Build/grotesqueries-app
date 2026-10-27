import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PREFERENCES, readPreferences, writePreferences, panelWidth } from '../src/preferences.js';
import { formatArguments, parseArguments } from '../src/arguments.js';

test('layout defaults are fresh, and malformed/unknown versions cannot inject settings', () => {
  for (const raw of [null, '', '{', 'null', '[]', 'true', '{"version":1,"sessions":false}']) {
    assert.deepEqual(readPreferences(raw), DEFAULT_PREFERENCES);
  }
  const first = readPreferences(null); first.sessions = false;
  assert.equal(readPreferences(null).sessions, true);
});

test('layout round trips only its allowlisted, bounded fields', () => {
  const prefs = readPreferences('{"version":2,"sessions":false,"panel":true,"leftWidth":-10,"rightWidth":10000,"screenReader":true,"token":"not-a-preference"}');
  assert.deepEqual(prefs, { version: 2, sessions: false, panel: true, leftWidth: 3, rightWidth: 40, screenReader: true, clickToControl: true, releaseShortcut: 'escape' });
  assert.deepEqual(readPreferences(writePreferences(prefs)), prefs);
  assert.equal(writePreferences(prefs).includes('token'), false);
});
test('control preferences keep old layout values, reject invalid shortcuts and round trip choices', () => {
  const saved = readPreferences('{"version":2,"leftWidth":23,"clickToControl":false,"releaseShortcut":"ctrl-alt-g"}');
  assert.equal(saved.leftWidth, 23); assert.equal(saved.clickToControl, false); assert.equal(saved.releaseShortcut, 'ctrl-alt-g');
  assert.deepEqual(readPreferences(writePreferences(saved)), saved);
  assert.equal(readPreferences('{"version":2,"releaseShortcut":"none"}').releaseShortcut, 'none');
  const invalid = readPreferences('{"version":2,"clickToControl":"yes","releaseShortcut":"anything"}');
  assert.equal(invalid.clickToControl, true); assert.equal(invalid.releaseShortcut, 'escape');
});

test('invalid scalar types use defaults; widths are finite percentages to one decimal', () => {
  assert.deepEqual(readPreferences('{"version":2,"sessions":"false","panel":0,"leftWidth":"24","rightWidth":null,"screenReader":1}'), DEFAULT_PREFERENCES);
  assert.equal(panelWidth(NaN, 17), 17);
  assert.equal(panelWidth(Infinity, 17), 17);
  assert.equal(panelWidth(27.26, 17), 27.3);
});
test('argument editing round trips Windows paths, empty args, whitespace and embedded quotes without shell evaluation', () => {
  for (const args of [[], ['--login', '-i'], ['', ' '], ['C:\\some folder\\', 'a"b', '\\"'], ['--eval', 'console.log("hi")']])
    assert.deepEqual(parseArguments(formatArguments(args)), args);
  assert.throws(() => parseArguments('"unfinished'), /unclosed/);
});

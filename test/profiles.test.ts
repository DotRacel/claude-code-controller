/**
 * profiles.test.ts — version → injection-profile selection.
 *
 * Pure-function coverage for the version-profiled injection surface (src/injector/profiles.ts):
 * version parsing/compare, and that selectProfile picks the right gate set and note across the
 * exact / optimistic-newer / optimistic-older cases. No claude, no inspector — just the logic
 * that decides which gates get injected.
 *
 * Run: node --test test/profiles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersion, selectProfile, newestProfile, PROFILES } from '../src/injector/profiles.ts';

test('parseVersion extracts x.y.z from various shapes', () => {
  assert.deepEqual(parseVersion('2.1.238'), [2, 1, 238]);
  assert.deepEqual(parseVersion('2.1.238 (Claude Code)'), [2, 1, 238]);
  assert.deepEqual(parseVersion('v2.1.238'), [2, 1, 238]);
  assert.deepEqual(parseVersion('claude 2.1.229\n'), [2, 1, 229]);
  // No version → [0,0,0] (never throws; selection degrades to oldest profile).
  assert.deepEqual(parseVersion('nonsense'), [0, 0, 0]);
  assert.deepEqual(parseVersion(''), [0, 0, 0]);
});

test('compareVersion orders numerically, not lexically', () => {
  assert.equal(compareVersion('2.1.238', '2.1.237'), 1);
  assert.equal(compareVersion('2.1.237', '2.1.238'), -1);
  assert.equal(compareVersion('2.1.238', '2.1.238'), 0);
  // Patch is compared as a number: 100 > 99, not "100" < "99".
  assert.equal(compareVersion('2.1.100', '2.1.99'), 1);
  assert.equal(compareVersion('2.2.0', '2.1.999'), 1);
});

test('selectProfile: exact matches within each profile range', () => {
  for (const v of ['2.1.229', '2.1.232', '2.1.234', '2.1.237']) {
    const { profile, note } = selectProfile(v);
    assert.equal(profile.id, 'legacy', `${v} → legacy`);
    assert.equal(note, 'exact');
    // legacy uses the two-function trusted-device gate (aliases W & G).
    const trust = profile.gates.find((g) => g.id === 'dispatch.trust')!;
    assert.deepEqual(Object.keys(trust.aliases).sort(), ['G', 'W']);
  }
  {
    const { profile, note } = selectProfile('2.1.238');
    assert.equal(profile.id, 'preflight');
    assert.equal(note, 'exact');
    // preflight uses the single-function gate (alias Z).
    const trust = profile.gates.find((g) => g.id === 'dispatch.trust')!;
    assert.deepEqual(Object.keys(trust.aliases), ['Z']);
  }
});

test('selectProfile: optimistic-newer picks the newest profile for unknown-newer versions', () => {
  const { profile, note } = selectProfile('2.1.999');
  assert.equal(profile.id, 'preflight');
  assert.equal(note, 'optimistic-newer');
  assert.equal(profile.id, newestProfile().id);
});

test('selectProfile: a claude-code version string with suffix still resolves', () => {
  const { profile } = selectProfile('2.1.238 (Claude Code)');
  assert.equal(profile.id, 'preflight');
});

test('selectProfile: optimistic-older falls back to the oldest profile below the floor', () => {
  const oldest = [...PROFILES].sort((a, b) => compareVersion(a.since, b.since))[0];
  const { profile, note } = selectProfile('2.1.100');
  assert.equal(profile.id, oldest.id);
  assert.equal(profile.id, 'legacy');
  assert.equal(note, 'optimistic-older');
});

test('selectProfile never throws on garbage input', () => {
  for (const v of ['', 'nonsense', 'x.y.z']) {
    const { profile } = selectProfile(v);
    // [0,0,0] is below every floor → oldest profile, no throw.
    assert.ok(profile.id.length > 0);
  }
});

test('every profile carries the full headless + interactive gate sets', () => {
  for (const p of PROFILES) {
    assert.equal(p.gates.length, 7, `${p.id} has 7 headless gates`);
    assert.ok(p.interactiveGates.length >= 7, `${p.id} has interactive gates`);
    // dispatch.trust is present exactly once in every profile.
    assert.equal(p.gates.filter((g) => g.id === 'dispatch.trust').length, 1);
  }
});

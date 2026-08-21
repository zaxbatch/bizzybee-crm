'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseCsv, toCsv } = require('../src/csv');

test('parses a simple CSV', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n');
  assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('handles quoted fields with commas, quotes and newlines', () => {
  const csv = 'name,notes\n"Acme, Inc.","line1\nline2"\n"Say ""hi""",x\n';
  const rows = parseCsv(csv);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[1], ['Acme, Inc.', 'line1\nline2']);
  assert.deepStrictEqual(rows[2], ['Say "hi"', 'x']);
});

test('handles CRLF endings and a UTF-8 BOM', () => {
  const rows = parseCsv('\uFEFFa,b\r\n1,2\r\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('drops blank lines but keeps legitimately empty fields', () => {
  const rows = parseCsv('a,b\n,2\n\n1,\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['', '2'], ['1', '']]);
});

test('parses without a trailing newline', () => {
  const rows = parseCsv('a,b\n1,2');
  assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('round-trips through toCsv', () => {
  const original = [['name', 'email'], ['Dana "D" Lee', 'dana@x.com'], ['Acme, Inc.', '']];
  const reparsed = parseCsv(toCsv(original));
  assert.deepStrictEqual(reparsed, original);
});

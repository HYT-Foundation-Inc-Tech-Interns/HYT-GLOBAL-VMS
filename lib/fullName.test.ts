import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composeFullName, normaliseMiddleInitial } from './fullName.ts';

describe('normaliseMiddleInitial', () => {
  test('upper-cases a single letter', () => {
    assert.equal(normaliseMiddleInitial('o'), 'O');
    assert.equal(normaliseMiddleInitial('O'), 'O');
  });

  test('strips a period the user typed', () => {
    assert.equal(normaliseMiddleInitial('O.'), 'O');
    assert.equal(normaliseMiddleInitial(' o. '), 'O');
  });

  test('takes only the first letter of a word', () => {
    assert.equal(normaliseMiddleInitial('Ocbina'), 'O');
  });

  test('empty, whitespace and punctuation all mean no middle initial', () => {
    assert.equal(normaliseMiddleInitial(''), null);
    assert.equal(normaliseMiddleInitial('   '), null);
    assert.equal(normaliseMiddleInitial(null), null);
    assert.equal(normaliseMiddleInitial(undefined), null);
    assert.equal(normaliseMiddleInitial('.'), null);
  });

  test('a non-letter is treated as absent, not stored', () => {
    assert.equal(normaliseMiddleInitial('3'), null);
    assert.equal(normaliseMiddleInitial('-'), null);
  });
});

describe('composeFullName', () => {
  test('joins the parts, with a period after the initial', () => {
    assert.equal(composeFullName('Juan', 'C', 'Dela Cruz'), 'Juan C. Dela Cruz');
  });

  test('omits the initial cleanly when there is none', () => {
    assert.equal(composeFullName('Jhay', '', 'Ilagan'), 'Jhay Ilagan');
    assert.equal(composeFullName('Jhay', null, 'Ilagan'), 'Jhay Ilagan');
    assert.equal(composeFullName('Jhay', '   ', 'Ilagan'), 'Jhay Ilagan');
  });

  test('trims every part', () => {
    assert.equal(
      composeFullName('  Juan ', ' c. ', ' Dela Cruz '),
      'Juan C. Dela Cruz'
    );
  });

  test('never doubles a period the user already typed', () => {
    assert.equal(composeFullName('Juan', 'C.', 'Dela Cruz'), 'Juan C. Dela Cruz');
  });
});

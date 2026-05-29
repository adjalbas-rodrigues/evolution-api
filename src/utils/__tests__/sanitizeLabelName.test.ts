import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeLabelName } from '../sanitizeLabelName';

// Reproduction — label names lost their accents in the PG mirror.
// Root cause: the LABELS_EDIT handler stripped EVERYTHING outside ASCII
// printable (`/[^\x20-\x7E]/g`), deleting legitimate Latin accents:
//   "TRÁFEGO ATUALIZADO" -> "TRFEGO ATUALIZADO"
//   "Indicação Mário"    -> "Indicao Mrio"
//   "Não renovar!!"      -> "No renovar!!"
// The intent of the original strip was to drop control/zero-width junk, NOT
// printable Unicode. sanitizeLabelName preserves printable text (accents,
// emoji) and removes only control characters.

const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const ZWSP = String.fromCharCode(0x200b); // zero-width space

describe('sanitizeLabelName', () => {
  it('preserves Portuguese accents', () => {
    assert.equal(sanitizeLabelName('TRÁFEGO ATUALIZADO'), 'TRÁFEGO ATUALIZADO');
    assert.equal(sanitizeLabelName('Indicação Mário'), 'Indicação Mário');
    assert.equal(sanitizeLabelName('Não renovar!!'), 'Não renovar!!');
    assert.equal(sanitizeLabelName('Cadastrar no sistema'), 'Cadastrar no sistema');
  });

  it('leaves plain ASCII untouched', () => {
    assert.equal(sanitizeLabelName('GOLPE'), 'GOLPE');
    assert.equal(sanitizeLabelName('#Botar tag#'), '#Botar tag#');
  });

  it('strips control characters (the original defensive intent)', () => {
    assert.equal(sanitizeLabelName(`Lead${NUL} `), 'Lead');
    assert.equal(sanitizeLabelName(`A${BEL}B`), 'AB');
    assert.equal(sanitizeLabelName(`zero${ZWSP}width`), 'zerowidth');
  });

  it('trims and is null-safe', () => {
    assert.equal(sanitizeLabelName('  Favoritos  '), 'Favoritos');
    assert.equal(sanitizeLabelName(undefined as unknown as string), '');
    assert.equal(sanitizeLabelName(null as unknown as string), '');
  });
});

import { describe, expect, it } from 'vitest';
import {
  ASSET_DOCUMENT_VERSION,
  blankDocument,
  createPart,
  decodeAssetDocument,
  fileSafeName,
} from '../asset-editor/document.js';
import { LIBRARY_ASSETS, loadLibraryAsset } from '../asset-editor/library.js';

describe('asset document', () => {
  it('round-trips a primitive document through the trust boundary', () => {
    const doc = blankDocument('Rock slider');
    doc.parts.push(createPart(doc, 'box'));
    doc.parts.push(createPart(doc, 'cylinder'));
    expect(decodeAssetDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('rejects duplicate part ids and non-finite transforms', () => {
    const doc = blankDocument();
    const part = createPart(doc, 'box');
    doc.parts.push(part, structuredClone(part));
    expect(() => decodeAssetDocument(doc)).toThrow(/unique/);

    doc.parts.pop();
    doc.parts[0]!.transform.position[0] = Number.NaN;
    expect(() => decodeAssetDocument(doc)).toThrow(/finite number/);
  });

  it('pins the version and creates safe filenames', () => {
    expect(blankDocument().version).toBe(ASSET_DOCUMENT_VERSION);
    expect(fileSafeName('  Bush Hut #2  ')).toBe('bush-hut-2');
  });

  it('includes the procedural Dustback RS as an asset-editor template', () => {
    expect(LIBRARY_ASSETS).toContainEqual({
      id: 'vehicle:dustback-rs', label: 'Dustback RS', group: 'Vehicles',
    });
    const doc = loadLibraryAsset('vehicle:dustback-rs');
    expect(doc.name).toBe('Dustback RS');
    expect(doc.parts.length).toBeGreaterThan(20);
  });
});

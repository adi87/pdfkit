import PDFDocument from '../../lib/document';
import PDFReference from '../../lib/reference';
import PNGImage from '../../lib/image/png';
import PNG from 'png-js';
import fs from 'fs';
import zlib from 'zlib';

// Undoes PNG row filters (what a PDF reader does for /Predictor 15), so the
// planes embedded for 8-bit alpha images can be checked pixel by pixel.
const unfilter = (data, width, height, bpp) => {
  const row = width * bpp;
  const out = Buffer.alloc(row * height);
  let i = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[i++];
    for (let x = 0; x < row; x++) {
      const raw = data[i++];
      const o = y * row + x;
      const left = x >= bpp ? out[o - bpp] : 0;
      const up = y > 0 ? out[o - row] : 0;
      const upLeft = x >= bpp && y > 0 ? out[o - row - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = left;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[o] = (raw + pred) & 0xff;
    }
  }
  return out;
};

describe('PNGImage', () => {
  let document;

  // Runs the real (asynchronous) split of an 8-bit alpha image and resolves
  // once the image is finalized, with the two deflated planes it embedded.
  const embedSplitImage = fileName =>
    new Promise(resolve => {
      const img = new PNGImage(fs.readFileSync(fileName), 'I1');
      const finalizeFn = img.finalize;
      jest.spyOn(img, 'finalize').mockImplementation(() => {
        const planes = { color: img.imgData, alpha: img.alphaChannel };
        finalizeFn.call(img);
        resolve({ img, planes });
      });
      img.embed(document);
    });

  // The colour and alpha pixels png-js decodes from the same file.
  const decodedPlanes = fileName =>
    new Promise(resolve => {
      const png = new PNG(fs.readFileSync(fileName));
      png.decodePixels(pixels => {
        const bpp = png.colors + 1;
        const count = png.width * png.height;
        const color = Buffer.alloc(count * png.colors);
        const alpha = Buffer.alloc(count);
        for (let p = 0; p < count; p++) {
          for (let c = 0; c < png.colors; c++) {
            color[p * png.colors + c] = pixels[p * bpp + c];
          }
          alpha[p] = pixels[p * bpp + png.colors];
        }
        resolve({ color, alpha });
      });
    });

  const expectSplitMatchesDecode = async (fileName, colors) => {
    const { img, planes } = await embedSplitImage(fileName);
    const { width, height } = img;
    const expected = await decodedPlanes(fileName);
    const color = unfilter(zlib.inflateSync(planes.color), width, height, colors);
    const alpha = unfilter(zlib.inflateSync(planes.alpha), width, height, 1);
    expect(color.equals(expected.color)).toBe(true);
    expect(alpha.equals(expected.alpha)).toBe(true);
    return img;
  };

  const createImage = fileName => {
    const img = new PNGImage(fs.readFileSync(fileName), 'I1');
    // noop data manipulation methods
    img.loadIndexedAlphaChannel = () => {
      if (img.image.transparency.indexed) {
        img.alphaChannel = {};
        img.finalize();
      }
    };
    img.splitAlphaChannel = () => {
      if (img.image.hasAlphaChannel) {
        img.alphaChannel = {};
        img.finalize();
      }
    };
    const finalizeFn = img.finalize;
    jest.spyOn(img, 'finalize').mockImplementation(() => finalizeFn.call(img));
    img.embed(document);
    return img;
  };

  beforeEach(() => {
    document = new PDFDocument();
  });

  test('RGB', () => {
    // ImageWidth = 400
    // ImageHeight = 533
    // BitDepth = 8
    // ColorType = 2 (RGB)
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage('./demo/images/test2.png');

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      Height: 533,
      Length: 397011,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 400,
      DecodeParms: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      BitsPerComponent: 8,
      Colors: 3,
      Columns: 400,
      Predictor: 15
    });
  });

  test('RGB white transparent', () => {
    // ImageWidth = 32
    // ImageHeight = 32
    // BitDepth = 16
    // ColorType = 2
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage(
      './tests/images/pngsuite-rgb-transparent-white.png'
    );

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 16,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      Height: 32,
      Length: 1932,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 32,
      Mask: [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
      DecodeParms: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      BitsPerComponent: 16,
      Colors: 3,
      Columns: 32,
      Predictor: 15
    });
  });

  test('RGB (8bit) with Alpha', async () => {
    // ImageWidth = 409
    // ImageHeight = 400
    // BitDepth = 8
    // ColorType = 6 (RGB with Alpha)
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    // embedded as still-filtered colour and alpha planes that decode to
    // exactly the pixels png-js decodes
    const img = await expectSplitMatchesDecode('./tests/images/bee.png', 3);

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      Height: 400,
      Length: expect.any(Number),
      Subtype: 'Image',
      Type: 'XObject',
      Width: 409,
      DecodeParms: expect.any(PDFReference),
      SMask: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      Predictor: 15,
      Colors: 3,
      BitsPerComponent: 8,
      Columns: 409
    });

    expect(img.obj.data.SMask.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Decode: [0, 1],
      Filter: 'FlateDecode',
      Height: 400,
      Length: expect.any(Number),
      Subtype: 'Image',
      Type: 'XObject',
      Width: 409,
      DecodeParms: expect.any(PDFReference)
    });

    expect(img.obj.data.SMask.data.DecodeParms.data).toMatchObject({
      Predictor: 15,
      Colors: 1,
      BitsPerComponent: 8,
      Columns: 409
    });
  });

  test('RGB (16bit) with Alpha', () => {
    // ImageWidth = 175
    // ImageHeight = 65
    // BitDepth = 16
    // ColorType = 6
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage('./tests/images/straight.png');

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      Height: 65,
      Length: 28537,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 175,
      SMask: expect.any(PDFReference)
    });

    expect(img.obj.data.SMask.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Decode: [0, 1],
      Filter: 'FlateDecode',
      Height: 65,
      Length: 16,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 175
    });
  });

  test('Pallete', () => {
    // ImageWidth = 980
    // ImageHeight = 540
    // BitDepth = 8
    // ColorType = 3 (Pallete)
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage('./demo/images/test3.png');

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: ['Indexed', 'DeviceRGB', 255, expect.any(PDFReference)],
      Filter: 'FlateDecode',
      Height: 540,
      Length: 56682,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 980,
      DecodeParms: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      BitsPerComponent: 8,
      Colors: 1,
      Columns: 980,
      Predictor: 15
    });
  });

  test('Pallete indexed transparency', () => {
    // ImageWidth = 32
    // ImageHeight = 32
    // BitDepth = 8
    // ColorType = 3
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage(
      './tests/images/pngsuite-palette-transparent-white.png'
    );

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: ['Indexed', 'DeviceRGB', 244, expect.any(PDFReference)],
      Filter: 'FlateDecode',
      Height: 32,
      Length: 650,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 32,
      DecodeParms: expect.any(PDFReference),
      SMask: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      BitsPerComponent: 8,
      Colors: 1,
      Columns: 32,
      Predictor: 15
    });

    expect(img.obj.data.SMask.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Decode: [0, 1],
      Filter: 'FlateDecode',
      Height: 32,
      Length: 16,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 32
    });
  });

  test('Grayscale', () => {
    // ImageWidth = 428
    // ImageHeight = 320
    // BitDepth = 8
    // ColorType = 0
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage('./tests/images/glassware-noisy.png');

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Filter: 'FlateDecode',
      Height: 428,
      Length: 82633,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 320,
      DecodeParms: expect.any(PDFReference)
    });
  });

  test('Grayscale black transparent', () => {
    // ImageWidth = 32
    // ImageHeight = 32
    // BitDepth = 4
    // ColorType = 0
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage(
      './tests/images/pngsuite-gray-transparent-black.png'
    );

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 4,
      ColorSpace: 'DeviceGray',
      Filter: 'FlateDecode',
      Height: 32,
      Length: 328,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 32,
      Mask: [0, 0],
      DecodeParms: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      BitsPerComponent: 4,
      Colors: 1,
      Columns: 32,
      Predictor: 15
    });
  });

  test('Grayscale white transparent', () => {
    // ImageWidth = 32
    // ImageHeight = 32
    // BitDepth = 16
    // ColorType = 0
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = createImage(
      './tests/images/pngsuite-gray-transparent-white.png'
    );

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 16,
      ColorSpace: 'DeviceGray',
      Filter: 'FlateDecode',
      Height: 32,
      Length: 1212,
      Subtype: 'Image',
      Type: 'XObject',
      Width: 32,
      Mask: [255, 255],
      DecodeParms: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      BitsPerComponent: 16,
      Colors: 1,
      Columns: 32,
      Predictor: 15
    });
  });

  test('Grayscale with Alpha', async () => {
    // ImageWidth = 112
    // ImageHeight = 112
    // BitDepth = 8
    // ColorType = 4 (Grayscale with Alpha)
    // Compression = 0
    // Filter = 0
    // Interlace = 0

    const img = await expectSplitMatchesDecode('./tests/images/fish.png', 1);

    expect(img.finalize).toBeCalledTimes(1);

    expect(img.obj.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Filter: 'FlateDecode',
      Height: 112,
      Length: expect.any(Number),
      Subtype: 'Image',
      Type: 'XObject',
      Width: 112,
      DecodeParms: expect.any(PDFReference),
      SMask: expect.any(PDFReference)
    });

    expect(img.obj.data.DecodeParms.data).toMatchObject({
      Predictor: 15,
      Colors: 1,
      BitsPerComponent: 8,
      Columns: 112
    });

    expect(img.obj.data.SMask.data).toMatchObject({
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Decode: [0, 1],
      Filter: 'FlateDecode',
      Height: 112,
      Length: expect.any(Number),
      Subtype: 'Image',
      Type: 'XObject',
      Width: 112,
      DecodeParms: expect.any(PDFReference)
    });

    expect(img.obj.data.SMask.data.DecodeParms.data).toMatchObject({
      Predictor: 15,
      Colors: 1,
      BitsPerComponent: 8,
      Columns: 112
    });
  });
});

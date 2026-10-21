import zlib from 'zlib';
import PNG from 'png-js';

// Reads the parts of a PNG that embedding needs straight from the file
// buffer. png-js copies the compressed image data into a JS array one byte at
// a time and then converts that array to a Buffer, which was the single
// biggest cost of embedding large PNGs. The fields mirror png-js's (palette
// and transparency stay plain arrays) so the embedding below is unchanged;
// png-js itself is only constructed when pixels must be fully decoded.
class PNGReader {
  constructor(data) {
    this.data = data;
    this.palette = [];
    this.transparency = {};
    const idat = [];

    let pos = 8; // skip the signature
    while (pos + 8 <= data.length) {
      const size = data.readUInt32BE(pos);
      const type = data.toString('ascii', pos + 4, pos + 8);
      const body = data.subarray(pos + 8, pos + 8 + size);
      pos += 12 + size; // length, type, data, crc

      if (type === 'IHDR') {
        this.width = body.readUInt32BE(0);
        this.height = body.readUInt32BE(4);
        this.bits = body[8];
        this.colorType = body[9];
        this.compressionMethod = body[10];
        this.filterMethod = body[11];
        this.interlaceMethod = body[12];
      } else if (type === 'PLTE') {
        this.palette = Array.from(body);
      } else if (type === 'IDAT') {
        idat.push(body);
      } else if (type === 'tRNS') {
        this.transparency = {};
        if (this.colorType === 3) {
          // one alpha per palette entry up to the last non-opaque one; the
          // rest are opaque (padded to 255 entries, as png-js does)
          this.transparency.indexed = Array.from(body);
          for (let i = this.transparency.indexed.length; i < 255; i++) {
            this.transparency.indexed.push(255);
          }
        } else if (this.colorType === 0) {
          this.transparency.grayscale = body[0];
        } else if (this.colorType === 2) {
          this.transparency.rgb = Array.from(body);
        }
      } else if (type === 'IEND') {
        break;
      }
    }

    this.imgData = Buffer.concat(idat);
    this.colors = this.colorType === 2 || this.colorType === 6 ? 3 : 1;
    this.hasAlphaChannel = this.colorType === 4 || this.colorType === 6;
    this.colorSpace = this.colors === 3 ? 'DeviceRGB' : 'DeviceGray';
  }

  decodePixels(fn) {
    return new PNG(this.data).decodePixels(fn);
  }
}

// Splits 8-bit, non-interlaced PNG scanlines into colour and alpha scanlines
// without undoing the PNG row filters. Every filter (Sub, Up, Average, Paeth)
// predicts a byte from the same channel of the neighbouring pixels, so the
// colour bytes and the alpha bytes of a filtered row are each a correctly
// filtered row of their own, under the same filter type. PDF decodes them with
// /Predictor 15, so the pixels never have to be reconstructed here.
function splitFilteredScanlines(raw, width, height, colors) {
  const inRow = 1 + width * (colors + 1);
  if (raw.length < inRow * height) {
    throw new Error('PNG image data is shorter than its dimensions');
  }
  const color = Buffer.allocUnsafe((1 + width * colors) * height);
  const alpha = Buffer.allocUnsafe((1 + width) * height);
  let i = 0;
  let c = 0;
  let a = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[i++];
    if (filter > 4) {
      throw new Error(`Invalid PNG filter type ${filter}`);
    }
    color[c++] = filter;
    alpha[a++] = filter;
    if (colors === 3) {
      for (let x = 0; x < width; x++) {
        color[c] = raw[i];
        color[c + 1] = raw[i + 1];
        color[c + 2] = raw[i + 2];
        alpha[a++] = raw[i + 3];
        c += 3;
        i += 4;
      }
    } else {
      for (let x = 0; x < width; x++) {
        color[c++] = raw[i];
        alpha[a++] = raw[i + 1];
        i += 2;
      }
    }
  }
  return { color, alpha };
}

// Still-filtered scanlines compress far better than raw pixels, so the fastest
// zlib level already beats what the old decode-and-deflate path produced at
// the default level. On 60 production RGBA pages (329 megapixels, Node 24,
// arm64): level 1 embedded them in 6.5s / 159MB of PDF, the default level in
// 12.7s / 145MB, and the old path in 21.6s / 203MB.
const FILTERED_DEFLATE = { level: zlib.constants.Z_BEST_SPEED };

class PNGImage {
  constructor(data, label) {
    this.label = label;
    this.image = new PNGReader(data);
    this.width = this.image.width;
    this.height = this.image.height;
    this.imgData = this.image.imgData;
    this.obj = null;
  }

  embed(document) {
    this.document = document;
    if (this.obj) {
      return;
    }

    const hasAlphaChannel = this.image.hasAlphaChannel;
    // alpha images that can be split without decoding (8-bit, not interlaced)
    this.splitsFiltered =
      hasAlphaChannel && this.image.bits === 8 && this.image.interlaceMethod === 0;

    this.obj = this.document.ref({
      Type: 'XObject',
      Subtype: 'Image',
      BitsPerComponent: hasAlphaChannel ? 8 : this.image.bits,
      Width: this.width,
      Height: this.height,
      Filter: 'FlateDecode'
    });

    if (!hasAlphaChannel || this.splitsFiltered) {
      const params = this.document.ref({
        Predictor: 15,
        Colors: this.image.colors,
        BitsPerComponent: hasAlphaChannel ? 8 : this.image.bits,
        Columns: this.width
      });

      this.obj.data['DecodeParms'] = params;
      params.end();
    }

    if (this.image.palette.length === 0) {
      this.obj.data['ColorSpace'] = this.image.colorSpace;
    } else {
      // embed the color palette in the PDF as an object stream
      const palette = this.document.ref();
      palette.end(Buffer.from(this.image.palette));

      // build the color space array for the image
      this.obj.data['ColorSpace'] = [
        'Indexed',
        'DeviceRGB',
        this.image.palette.length / 3 - 1,
        palette
      ];
    }

    // For PNG color types 0, 2 and 3, the transparency data is stored in
    // a dedicated PNG chunk.
    if (this.image.transparency.grayscale != null) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const val = this.image.transparency.grayscale;
      this.obj.data['Mask'] = [val, val];
    } else if (this.image.transparency.rgb) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const { rgb } = this.image.transparency;
      const mask = [];
      for (let x of rgb) {
        mask.push(x, x);
      }

      this.obj.data['Mask'] = mask;
    } else if (this.image.transparency.indexed) {
      // Create a transparency SMask for the image based on the data
      // in the PLTE and tRNS sections. See below for details on SMasks.
      return this.loadIndexedAlphaChannel();
    } else if (this.splitsFiltered) {
      return this.splitFilteredAlphaChannel();
    } else if (hasAlphaChannel) {
      // For PNG color types 4 and 6, the transparency data is stored as a alpha
      // channel mixed in with the main image data. Separate this data out into an
      // SMask object and store it separately in the PDF.
      return this.splitAlphaChannel();
    }
    this.finalize();
  }

  finalize() {
    if (this.alphaChannel) {
      const sMask = this.document.ref({
        Type: 'XObject',
        Subtype: 'Image',
        Height: this.height,
        Width: this.width,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        ColorSpace: 'DeviceGray',
        Decode: [0, 1]
      });

      if (this.splitsFiltered) {
        const params = this.document.ref({
          Predictor: 15,
          Colors: 1,
          BitsPerComponent: 8,
          Columns: this.width
        });
        sMask.data['DecodeParms'] = params;
        params.end();
      }

      sMask.end(this.alphaChannel);
      this.obj.data['SMask'] = sMask;
    }

    // add the actual image data
    this.obj.end(this.imgData);

    // free memory
    this.image = null;
    return (this.imgData = null);
  }

  fail(err) {
    this.document.emit('error', err);
  }

  // Inflates once, splits the still-filtered scanlines into colour and alpha
  // (see splitFilteredScanlines), and deflates the two halves concurrently on
  // libuv's thread pool, so neither the row filters nor the pixels are ever
  // reconstructed in JavaScript.
  splitFilteredAlphaChannel() {
    zlib.inflate(this.imgData, (err, raw) => {
      if (err) {
        return this.fail(err);
      }
      let planes;
      try {
        planes = splitFilteredScanlines(raw, this.width, this.height, this.image.colors);
      } catch (splitErr) {
        return this.fail(splitErr);
      }
      let pending = 2;
      const done = (key) => (deflateErr, out) => {
        if (deflateErr) {
          return this.fail(deflateErr);
        }
        this[key] = out;
        if (--pending === 0) {
          this.finalize();
        }
      };
      zlib.deflate(planes.color, FILTERED_DEFLATE, done('imgData'));
      zlib.deflate(planes.alpha, FILTERED_DEFLATE, done('alphaChannel'));
    });
  }

  splitAlphaChannel() {
    return this.image.decodePixels(pixels => {
      let a, p;
      const colorCount = this.image.colors;
      const pixelCount = this.width * this.height;
      const imgData = Buffer.alloc(pixelCount * colorCount);
      const alphaChannel = Buffer.alloc(pixelCount);

      let i = (p = a = 0);
      const len = pixels.length;
      // For 16bit images copy only most significant byte (MSB) - PNG data is always stored in network byte order (MSB first)
      const skipByteCount = this.image.bits === 16 ? 1 : 0;
      while (i < len) {
        for (let colorIndex = 0; colorIndex < colorCount; colorIndex++) {
          imgData[p++] = pixels[i++];
          i += skipByteCount;
        }
        alphaChannel[a++] = pixels[i++];
        i += skipByteCount;
      }

      this.imgData = zlib.deflateSync(imgData);
      this.alphaChannel = zlib.deflateSync(alphaChannel);
      return this.finalize();
    });
  }

  loadIndexedAlphaChannel() {
    const transparency = this.image.transparency.indexed;
    return this.image.decodePixels(pixels => {
      const alphaChannel = Buffer.alloc(this.width * this.height);

      let i = 0;
      for (let j = 0, end = pixels.length; j < end; j++) {
        alphaChannel[i++] = transparency[pixels[j]];
      }

      this.alphaChannel = zlib.deflateSync(alphaChannel);
      return this.finalize();
    });
  }
}

export default PNGImage;

## pdfkit changelog

### Unreleased

- Embed 8-bit non-interlaced PNGs with an alpha channel without decoding
  them: split the still-filtered scanlines into colour and alpha planes and
  embed both with `/Predictor 15` (deflate level 1, both planes deflated in
  parallel). ~3x faster and ~20% smaller PDFs for RGBA page images, with
  identical pixels; other PNGs use the existing path
- Read PNG chunks with Buffer slices instead of png-js's byte-by-byte copy
- Replace the deprecated `new Buffer()` (DEP0005 on Node 24) with
  `Buffer.from` / `Buffer.alloc`
- Fix links to pages within the document
- Add support for named destinations
- Throw errors when `dash(...)` is passed invalid lengths

### [v0.9.1] - 2019-04-30

- Fix setting printing permission
- Fix corruption of string objects in browser
- Add option to set default font
- Remove call to fontkit.openSync
- Add standalone virtual file system implementation
- Add option (fontLayoutCache) to disable font layout cache

### [v0.9.0] - 2019-1-28

- Convert to code base from coffescript to ES6+
- Fix loading grayscale / transparent PNG files
- Reduce number of calls to async functions
- Implement encryption / access control

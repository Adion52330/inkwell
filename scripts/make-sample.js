#!/usr/bin/env node
// Generates sample/sample.pdf for manual testing.
//
// Deliberately mixed: a Letter page, an A4 page, and a page with /Rotate 90.
// The rotated page is the interesting one — it is what catches coordinate bugs
// in hit-testing and in the exporter, which most PDFs would never expose.

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

async function main() {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pages = [
    { size: [612, 792], rotate: 0, title: 'Page one — US Letter' },
    { size: [595.28, 841.89], rotate: 0, title: 'Page two — A4' },
    { size: [612, 792], rotate: 90, title: 'Page three — rotated 90°' },
  ];

  const lorem = [
    'Write on this page with the pen tool. Pressure from a stylus varies the',
    'stroke width; with a mouse the width follows how fast you move, so lines',
    'still taper naturally at the ends.',
    '',
    'Try the highlighter over this paragraph — it uses a multiply blend, so the',
    'text underneath stays readable rather than being washed out. Then export',
    'the document and check the highlight survives the round trip.',
    '',
    'The eraser removes whole strokes rather than nibbling pixels, which keeps',
    'the file small and every edit undoable.',
  ];

  pages.forEach((spec, index) => {
    const page = doc.addPage(spec.size);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    const { width, height } = page.getSize();

    page.drawText(spec.title, {
      x: 56,
      y: height - 78,
      size: 21,
      font: bold,
      color: rgb(0.1, 0.1, 0.12),
    });

    page.drawLine({
      start: { x: 56, y: height - 92 },
      end: { x: width - 56, y: height - 92 },
      thickness: 0.8,
      color: rgb(0.8, 0.8, 0.84),
    });

    lorem.forEach((line, i) => {
      page.drawText(line, {
        x: 56,
        y: height - 126 - i * 19,
        size: 11.5,
        font: body,
        color: rgb(0.24, 0.24, 0.28),
      });
    });

    // A ruled area, to make it obvious whether ink lands where you put it.
    for (let i = 0; i < 12; i += 1) {
      const y = height - 340 - i * 26;
      page.drawLine({
        start: { x: 56, y },
        end: { x: width - 56, y },
        thickness: 0.5,
        color: rgb(0.87, 0.88, 0.92),
      });
    }

    page.drawText(`${index + 1} / ${pages.length}`, {
      x: width - 88,
      y: 44,
      size: 9,
      font: body,
      color: rgb(0.6, 0.6, 0.64),
    });
  });

  // Fixed metadata dates keep the generated file byte-identical between runs,
  // so regenerating the sample does not show up as a spurious diff.
  const epoch = new Date('2024-01-01T00:00:00Z');
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);
  doc.setTitle('Inkwell sample');
  doc.setProducer('Inkwell sample generator');
  doc.setCreator('Inkwell sample generator');

  const outDir = path.join(__dirname, '..', 'sample');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'sample.pdf');
  fs.writeFileSync(outPath, await doc.save());
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

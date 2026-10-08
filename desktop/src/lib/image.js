// Receipt photo preparation, done with a canvas in the renderer.
//   stored  JPEG, long edge at most 2000 px: what we keep, show, and send to Claude
//   ocr     grayscale, contrast-stretched PNG at ~1800 px wide: what Tesseract reads best

const MAX_EDGE = 2000
const OCR_WIDTH = 1800

async function loadBitmap(blob) {
  // Applies the photo's EXIF orientation, so phone pictures come out upright
  return createImageBitmap(blob, { imageOrientation: 'from-image' })
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width)
  canvas.height = Math.round(height)
  return canvas
}

const toBytes = async (canvas, type, quality) => {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality))
  return new Uint8Array(await blob.arrayBuffer())
}

// Draw `bitmap` rotated by `turns` quarter turns clockwise, scaled by `scale`
function draw(bitmap, scale, turns = 0) {
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  const sideways = turns % 2 === 1
  const canvas = canvasFor(sideways ? h : w, sideways ? w : h)
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((turns * Math.PI) / 2)
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h)
  return canvas
}

export async function prepareStored(blob, turns = 0) {
  const bitmap = await loadBitmap(blob)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = draw(bitmap, scale, turns)
  bitmap.close()
  return toBytes(canvas, 'image/jpeg', 0.88)
}

export async function prepareForOcr(blob) {
  const bitmap = await loadBitmap(blob)
  const canvas = draw(bitmap, OCR_WIDTH / bitmap.width)
  bitmap.close()
  const ctx = canvas.getContext('2d')
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = img.data

  // Grayscale, then stretch the 2nd..98th percentile to full range (faded thermal paper)
  const hist = new Uint32Array(256)
  for (let i = 0; i < px.length; i += 4) {
    const g = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])
    px[i] = g
    hist[g]++
  }
  const count = px.length / 4
  let lo = 0, hi = 255, acc = 0
  for (; lo < 255 && (acc += hist[lo]) < count * 0.02; lo++);
  acc = 0
  for (; hi > 0 && (acc += hist[hi]) < count * 0.02; hi--);
  const range = Math.max(1, hi - lo)
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / range))
    px[i] = px[i + 1] = px[i + 2] = v
  }
  ctx.putImageData(img, 0, 0)
  return toBytes(canvas, 'image/png')
}

export const bytesToBlob = bytes => new Blob([bytes], { type: 'image/jpeg' })

/**
 * Read a picture the user attached (file picker, paste, drop) as a JPEG data URL, scaled so the longer side is at
 * most `max` px. Vision models downscale anyway; this keeps conversations (stored in SQLite) small.
 */
export async function imageToDataUrl(file: Blob, max = 1536): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Not an image')
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')!
  // JPEG has no alpha: paint transparent areas white rather than black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.9)
}

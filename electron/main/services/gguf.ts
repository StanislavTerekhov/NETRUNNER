import fs from 'node:fs/promises'

/** Scalar metadata from a GGUF header. Arrays are skipped (tokenizer vocabularies are huge), only their length is kept. */
export type GgufValue = string | number | bigint | boolean | { arrayLength: number }

const MAGIC = 0x46554747 // "GGUF" little-endian

/**
 * Minimal GGUF v2/v3 header reader: returns the key/value metadata without loading tensors.
 * Reads the file in growing chunks so multi-MB tokenizer arrays never need to be held as values.
 */
export async function readGgufMetadata(file: string, maxBytes = 64 * 1024 * 1024): Promise<Map<string, GgufValue>> {
  return (await readGguf(file, maxBytes)).meta
}

/**
 * Metadata plus the number of tensors whose name contains each requested fragment (tensor infos follow the
 * key/values in the header; only names are kept). Used to tell whether MTP (`nextn`) weights really exist.
 */
export async function readGguf(file: string, maxBytes = 64 * 1024 * 1024, countTensors: string[] = []): Promise<{ meta: Map<string, GgufValue>; tensorCounts: Record<string, number> }> {
  const fh = await fs.open(file, 'r')
  try {
    let buf = Buffer.alloc(0)
    let fileOffset = 0
    let pos = 0
    const ensure = async (n: number) => {
      while (pos + n > buf.length) {
        if (buf.length >= maxBytes) throw new Error('GGUF header larger than limit')
        const chunk = Buffer.alloc(Math.max(1 << 20, n))
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, fileOffset)
        if (bytesRead === 0) throw new Error('Unexpected end of GGUF file')
        fileOffset += bytesRead
        buf = Buffer.concat([buf.subarray(pos), chunk.subarray(0, bytesRead)])
        pos = 0
      }
    }
    const u32 = async () => (await ensure(4), (pos += 4), buf.readUInt32LE(pos - 4))
    const u64 = async () => (await ensure(8), (pos += 8), buf.readBigUInt64LE(pos - 8))
    const str = async () => {
      const len = Number(await u64())
      await ensure(len)
      pos += len
      return buf.toString('utf8', pos - len, pos)
    }
    const scalar = async (type: number): Promise<GgufValue> => {
      switch (type) {
        case 0: return (await ensure(1), (pos += 1), buf.readUInt8(pos - 1))
        case 1: return (await ensure(1), (pos += 1), buf.readInt8(pos - 1))
        case 2: return (await ensure(2), (pos += 2), buf.readUInt16LE(pos - 2))
        case 3: return (await ensure(2), (pos += 2), buf.readInt16LE(pos - 2))
        case 4: return u32()
        case 5: return (await ensure(4), (pos += 4), buf.readInt32LE(pos - 4))
        case 6: return (await ensure(4), (pos += 4), buf.readFloatLE(pos - 4))
        case 7: return (await ensure(1), (pos += 1), buf.readUInt8(pos - 1) !== 0)
        case 8: return str()
        case 10: return u64()
        case 11: return (await ensure(8), (pos += 8), buf.readBigInt64LE(pos - 8))
        case 12: return (await ensure(8), (pos += 8), buf.readDoubleLE(pos - 8))
        default: throw new Error(`Unknown GGUF value type ${type}`)
      }
    }
    const fixedSize: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

    if ((await u32()) !== MAGIC) throw new Error('Not a GGUF file')
    const version = await u32()
    if (version < 2) throw new Error(`Unsupported GGUF version ${version}`)
    const tensorCount = Number(await u64())
    const kvCount = Number(await u64())
    const meta = new Map<string, GgufValue>()
    for (let i = 0; i < kvCount; i++) {
      const key = await str()
      const type = await u32()
      if (type === 9) {
        const itemType = await u32()
        const n = Number(await u64())
        if (itemType === 8) for (let j = 0; j < n; j++) await str()
        else if (fixedSize[itemType]) {
          const bytes = fixedSize[itemType] * n
          await ensure(Math.min(bytes, 1 << 20))
          // Skip in bounded steps so a huge array never forces one giant allocation.
          let left = bytes
          while (left > 0) {
            const step = Math.min(left, 1 << 20)
            await ensure(step)
            pos += step
            left -= step
          }
        } else throw new Error(`Unsupported GGUF array item type ${itemType}`)
        meta.set(key, { arrayLength: n })
      } else meta.set(key, await scalar(type))
    }
    const tensorCounts: Record<string, number> = Object.fromEntries(countTensors.map(f => [f, 0]))
    if (countTensors.length) {
      for (let i = 0; i < tensorCount; i++) {
        const name = await str()
        const nDims = await u32()
        for (let d = 0; d < nDims; d++) await u64()
        await u32() // type
        await u64() // offset
        for (const f of countTensors) if (name.includes(f)) tensorCounts[f]++
      }
    }
    return { meta, tensorCounts }
  } finally {
    await fh.close()
  }
}

export const metaNum = (m: Map<string, GgufValue>, key: string): number | null => {
  const v = m.get(key)
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null
}

export const metaStr = (m: Map<string, GgufValue>, key: string): string | null => {
  const v = m.get(key)
  return typeof v === 'string' ? v : null
}

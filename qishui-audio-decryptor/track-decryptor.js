const { Mp4Box } = require('./mp4-box')
const {
  aesCtrDecrypt,
  decryptSpadeA,
  hexToBuffer,
  parseSenc,
  parseStsc,
  parseStsz,
  replaceEncaWithMp4a,
  sanitizeFilenamePart,
  scanForFlacMetadata,
} = require('./decrypt-utils')

class TrackDecryptor {
  resolveKey(spadeA) {
    if (!spadeA) {
      throw new Error('spade_a is required for decryption.')
    }

    const isHex = /^[0-9a-fA-F]+$/.test(spadeA)
    const keyHex = isHex ? spadeA : decryptSpadeA(spadeA)

    if (!keyHex) {
      throw new Error('Failed to resolve decryption key from spade_a.')
    }

    return hexToBuffer(keyHex)
  }

  // moov 直接子盒线性枚举 trak；跳过异常 padding 而不是中断。
  collectTraks(buffer, moov) {
    const traks = []
    const end = moov.offset + moov.size
    let position = moov.offset + 8
    while (position + 8 <= end) {
      const size = buffer.readUInt32BE(position)
      if (size < 8) { position += 8; continue }
      if (position + size > end) break
      const type = buffer.subarray(position + 4, position + 8).toString('ascii')
      if (type === 'trak') traks.push(Mp4Box.fromBuffer(buffer, position))
      position += size
    }
    return traks
  }

  // 选择加密音轨（stsd 含 enca 的 trak），旧布局兜底回第一个 trak。
  selectAudioTrackBoxes(buffer, moov) {
    const traks = this.collectTraks(buffer, moov)
    const boxesOf = (trak) => {
      const mdia = Mp4Box.findBox(buffer, 'mdia', trak.offset + 8, trak.offset + trak.size)
      if (mdia.isEmpty()) return null
      const minf = Mp4Box.findBox(buffer, 'minf', mdia.offset + 8, mdia.offset + mdia.size)
      if (minf.isEmpty()) return null
      const stbl = Mp4Box.findBox(buffer, 'stbl', minf.offset + 8, minf.offset + minf.size)
      if (stbl.isEmpty()) return null
      const stsd = Mp4Box.findBox(buffer, 'stsd', stbl.offset + 8, stbl.offset + stbl.size)
      if (stsd.isEmpty()) return null
      return { stbl, stsd }
    }
    for (const trak of traks) {
      const boxes = boxesOf(trak)
      if (!boxes) continue
      const encaHit = buffer.indexOf(Buffer.from('enca', 'ascii'), boxes.stsd.offset, boxes.stsd.offset + boxes.stsd.size)
      if (encaHit >= 0) return boxes
    }
    if (traks.length) {
      const boxes = boxesOf(traks[0])
      if (boxes) return boxes
    }
    return null
  }

  // stco（32位）/ co64（64位）→ chunk 文件偏移表。
  // 盒 data 布局：version_flags(4) + entry_count(4) + entries。
  parseChunkOffsets(box) {
    const data = box.data
    const is64 = box.type === 'co64'
    const count = data.readUInt32BE(4)
    const offsets = []
    for (let index = 0; index < count; index += 1) {
      offsets.push(is64
        ? Number(data.readBigUInt64BE(8 + index * 8))
        : data.readUInt32BE(8 + index * 4))
    }
    return offsets
  }

  // stsc/stsz/stco/senc → {offset, size, iv} 样本计划。
  // 新版 VOD 封装为多 chunk 布局（每 chunk 上百样本），必须按索引表寻址；
  // 旧布局（样本自 mdat+8 连续）同样被该算法正确覆盖。
  buildSamplePlan(sampleSizes, stscEntries, chunkOffsets, ivs) {
    const plan = []
    let sampleIndex = 0
    for (let chunkIndex = 0; chunkIndex < chunkOffsets.length && sampleIndex < sampleSizes.length; chunkIndex += 1) {
      const chunkNumber = chunkIndex + 1
      let samplesPerChunk = 0
      for (const entry of stscEntries) {
        if (entry.firstChunk <= chunkNumber) samplesPerChunk = entry.samplesPerChunk
      }
      if (samplesPerChunk <= 0) break
      let cursor = chunkOffsets[chunkIndex]
      for (let k = 0; k < samplesPerChunk && sampleIndex < sampleSizes.length; k += 1) {
        const size = sampleSizes[sampleIndex]
        const iv = ivs[sampleIndex]
        if (!iv) {
          throw new Error(`Missing IV for sample ${sampleIndex}.`)
        }
        plan.push({ offset: cursor, size, iv })
        cursor += size
        sampleIndex += 1
      }
    }
    if (sampleIndex < sampleSizes.length) {
      throw new Error(`Decrypt failed: chunk table covers only ${sampleIndex}/${sampleSizes.length} samples.`)
    }
    return plan
  }

  // 部分封装器存在占位/截断 senc 盒，携带全量 IV 的盒体积最大，扫描 moov 取最大者。
  findLargestSenc(buffer, start, end) {
    let best = null
    const tag = Buffer.from('senc', 'ascii')
    let position = start
    for (;;) {
      const hit = buffer.indexOf(tag, position, end)
      if (hit < 4) break
      const size = buffer.readUInt32BE(hit - 4)
      if (size >= 8 && hit - 4 + size <= buffer.length) {
        const box = Mp4Box.fromBuffer(buffer, hit - 4)
        if (!best || box.size > best.size) best = box
      }
      position = hit + 4
    }
    return best || new Mp4Box({ size: 0, type: '', offset: 0, data: Buffer.alloc(0) })
  }

  createFileName({ title, artist, extension }) {
    const safeTitle = sanitizeFilenamePart(title, 'track')
    const safeArtist = sanitizeFilenamePart(artist, 'unknown')
    return `${safeTitle} - ${safeArtist}${extension}`
  }

  decrypt({ encryptedBuffer, spadeA, media = {} }) {
    if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
      throw new Error('encryptedBuffer must be a non-empty Buffer.')
    }

    const key = this.resolveKey(spadeA)

    const moov = Mp4Box.findBox(encryptedBuffer, 'moov')
    if (moov.isEmpty()) {
      throw new Error("Decrypt failed: 'moov' atom not found.")
    }

    const boxes = this.selectAudioTrackBoxes(encryptedBuffer, moov)
    if (!boxes) {
      throw new Error("Decrypt failed: audio 'trak' atom not found.")
    }
    const { stbl, stsd } = boxes

    const stsz = Mp4Box.findBox(encryptedBuffer, 'stsz', stbl.offset + 8, stbl.offset + stbl.size)
    const stsc = Mp4Box.findBox(encryptedBuffer, 'stsc', stbl.offset + 8, stbl.offset + stbl.size)
    let stco = Mp4Box.findBox(encryptedBuffer, 'stco', stbl.offset + 8, stbl.offset + stbl.size)
    if (stco.isEmpty()) {
      stco = Mp4Box.findBox(encryptedBuffer, 'co64', stbl.offset + 8, stbl.offset + stbl.size)
    }

    let senc = this.findLargestSenc(encryptedBuffer, moov.offset + 8, moov.offset + moov.size)
    if (senc.isEmpty()) {
      senc = this.findLargestSenc(encryptedBuffer, stbl.offset + 8, stbl.offset + stbl.size)
    }

    if (!stsz || stsz.isEmpty()) {
      throw new Error("Decrypt failed: 'stsz' atom not found.")
    }
    if (!stsc || stsc.isEmpty()) {
      throw new Error("Decrypt failed: 'stsc' atom not found.")
    }
    if (!stco || stco.isEmpty()) {
      throw new Error("Decrypt failed: 'stco' atom not found.")
    }

    const mdat = Mp4Box.findBox(encryptedBuffer, 'mdat')
    if (mdat.isEmpty()) {
      throw new Error("Decrypt failed: 'mdat' atom not found.")
    }

    const flacMetadata = scanForFlacMetadata(stsd.data)
    const isFlac = flacMetadata.length > 0

    const sampleSizes = parseStsz(stsz.data)
    const stscEntries = parseStsc(stsc.data)
    const chunkOffsets = this.parseChunkOffsets(stco)
    const ivs = parseSenc(senc.data)

    if (sampleSizes.length !== ivs.length) {
      throw new Error(`Decrypt failed: sample count ${sampleSizes.length} does not match iv count ${ivs.length}.`)
    }

    const samplePlan = this.buildSamplePlan(sampleSizes, stscEntries, chunkOffsets, ivs)

    // 原地解密副本中的每个样本（按 stco/stsc 索引寻址），保持文件结构不变。
    const output = Buffer.from(encryptedBuffer)
    const decryptedSamples = []
    for (const sample of samplePlan) {
      const decrypted = aesCtrDecrypt(key, sample.iv, output.subarray(sample.offset, sample.offset + sample.size))
      decrypted.copy(output, sample.offset)
      decryptedSamples.push(decrypted)
    }

    replaceEncaWithMp4a(output, stsd.offset, stsd.offset + stsd.size)

    const resultBuffer = isFlac
      ? this.buildFlacFile(flacMetadata, decryptedSamples)
      : output

    const extension = isFlac ? '.flac' : '.m4a'

    return {
      buffer: resultBuffer,
      extension,
      fileName: this.createFileName({
        title: media.title,
        artist: media.artist,
        extension,
      }),
      meta: {
        isFlac,
        sampleCount: samplePlan.length,
        chunkCount: chunkOffsets.length,
      },
    }
  }
}

module.exports = {
  TrackDecryptor,
}

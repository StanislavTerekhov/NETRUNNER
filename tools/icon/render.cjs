// Renders SVG files to PNG with Electron's Chromium (no extra image libraries).
//   npx electron tools/icon/render.cjs <size> <in.svg> <out.png> [<in.svg> <out.png> ...]
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  try {
    const args = process.argv.slice(process.argv.findIndex(a => a.endsWith('render.cjs')) + 1)
    const size = Number(args[0])
    // Chromium will not make a window smaller than ~100 px: draw big, then scale down.
    const R = Math.max(size, 256)
    for (let i = 1; i + 1 < args.length; i += 2) {
      const svg = fs.readFileSync(args[i], 'utf8').replace(/width="\d+" height="\d+"/, `width="${R}" height="${R}"`)
      const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
      const win = new BrowserWindow({ width: R, height: R, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } })
      win.webContents.setFrameRate(10)
      let last = null
      win.webContents.on('paint', (_e, _dirty, image) => { last = image })
      const tmp = args[i + 1] + '.html'
      fs.writeFileSync(tmp, html)
      await win.loadFile(tmp)
      fs.rmSync(tmp)
      await new Promise(r => setTimeout(r, 600))
      if (!last) throw new Error('no frame painted')
      fs.writeFileSync(args[i + 1], last.crop({ x: 0, y: 0, width: R, height: R }).resize({ width: size, height: size, quality: 'best' }).toPNG())
      win.destroy()
    }
  } catch (e) {
    console.error('render failed:', e)
    process.exitCode = 1
  }
  app.quit()
})

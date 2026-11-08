// Prints an HTML file to an A4 PDF with Electron's Chromium.
//   npx electron tools/installer/pdf.cjs <in.html> <out.pdf>
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  try {
    const args = process.argv.slice(process.argv.findIndex(a => a.endsWith('pdf.cjs')) + 1)
    const win = new BrowserWindow({ show: false, width: 794, height: 1123 })
    await win.loadFile(path.resolve(args[0]))
    await new Promise(r => setTimeout(r, 400))
    const pages = await win.webContents.executeJavaScript('document.querySelector(".page").scrollHeight')
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true })
    fs.writeFileSync(args[1], pdf)
    console.log('page height px', pages)
  } catch (e) {
    console.error('pdf failed:', e)
    process.exitCode = 1
  }
  app.quit()
})

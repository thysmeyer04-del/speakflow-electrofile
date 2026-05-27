// Generates tray-icon.png (idle) and tray-icon-recording.png (active)
// Both are 32×32 transparent PNGs using the Speakflow waveform mark.
const { Resvg } = require('@resvg/resvg-js')
const fs   = require('fs')
const path = require('path')

const assetsDir = path.join(__dirname, '..', 'assets')

// Idle: white waveform on transparent background (works on dark/light trays)
const idleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2563EB"/>
      <stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient>
  </defs>
  <!-- Waveform lines at varying heights centered in 32x32 -->
  <rect x="2"  y="11" width="2.5" height="10" rx="1.2" fill="url(#g)"/>
  <rect x="6"  y="8"  width="2.5" height="16" rx="1.2" fill="url(#g)"/>
  <rect x="10" y="5"  width="2.5" height="22" rx="1.2" fill="url(#g)"/>
  <rect x="14" y="9"  width="2.5" height="14" rx="1.2" fill="url(#g)"/>
  <rect x="18" y="5"  width="2.5" height="22" rx="1.2" fill="url(#g)"/>
  <rect x="22" y="8"  width="2.5" height="16" rx="1.2" fill="url(#g)"/>
  <rect x="26" y="11" width="2.5" height="10" rx="1.2" fill="url(#g)"/>
</svg>`

// Recording: cyan highlight to indicate active state
const recordingSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#22D3EE"/>
      <stop offset="100%" stop-color="#2563EB"/>
    </linearGradient>
  </defs>
  <rect x="2"  y="9"  width="2.5" height="14" rx="1.2" fill="url(#g)"/>
  <rect x="6"  y="5"  width="2.5" height="22" rx="1.2" fill="url(#g)"/>
  <rect x="10" y="2"  width="2.5" height="28" rx="1.2" fill="url(#g)"/>
  <rect x="14" y="7"  width="2.5" height="18" rx="1.2" fill="url(#g)"/>
  <rect x="18" y="2"  width="2.5" height="28" rx="1.2" fill="url(#g)"/>
  <rect x="22" y="5"  width="2.5" height="22" rx="1.2" fill="url(#g)"/>
  <rect x="26" y="9"  width="2.5" height="14" rx="1.2" fill="url(#g)"/>
</svg>`

function render(svg, outFile) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 32 }, background: 'transparent' })
  const png = resvg.render().asPng()
  fs.writeFileSync(outFile, png)
  console.log(`Written: ${outFile}`)
}

render(idleSvg,      path.join(assetsDir, 'tray-icon.png'))
render(recordingSvg, path.join(assetsDir, 'tray-icon-recording.png'))

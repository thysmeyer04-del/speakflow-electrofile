// Converts assets/icon.svg → assets/icon.png (512×512) using @resvg/resvg-js
const { Resvg } = require('@resvg/resvg-js')
const fs   = require('fs')
const path = require('path')

const root   = path.join(__dirname, '..')
const svgIn  = path.join(root, 'assets', 'icon.svg')
const pngOut = path.join(root, 'assets', 'icon.png')

const svg    = fs.readFileSync(svgIn, 'utf8')
const resvg  = new Resvg(svg, {
  fitTo: { mode: 'width', value: 512 },
  background: 'transparent',
})
const rendered = resvg.render()
fs.writeFileSync(pngOut, rendered.asPng())
console.log(`Written: ${pngOut} (${rendered.width}×${rendered.height})`)

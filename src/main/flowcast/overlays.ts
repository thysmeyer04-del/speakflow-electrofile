import path from 'node:path'
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type Rectangle } from 'electron'
import log from 'electron-log/main'

import { setSetting } from '../settings'
import type { FlowcastController } from './controller'
import type { CameraSize, InkColor, OverlayPoint } from './types'

const CAMERA_FRACTIONS: Record<CameraSize, number> = {
  small: 0.16,
  medium: 0.23,
  large: 0.31,
}
const CAMERA_ORDER: CameraSize[] = ['small', 'medium', 'large']
const INK_COLORS = new Set<InkColor>(['red', 'yellow', 'green', 'blue', 'white'])

export class FlowcastOverlayCoordinator {
  private cameraWindow: BrowserWindow | null = null
  private inkWindow: BrowserWindow | null = null
  private active = false
  private cameraVisible = false
  private cameraSize: CameraSize = 'small'
  private cameraX = 0.14
  private cameraY = 0.82
  private drawing = false
  private inkColor: InkColor = 'red'
  private inkWidth = 7
  private targetBounds: Rectangle | null = null
  private cameraStarted = false

  constructor(
    private readonly controller: FlowcastController,
    private readonly assetRoot: string,
  ) {}

  initialize(): void {
    if (this.cameraWindow || this.inkWindow) return
    this.cameraWindow = this.createCameraWindow()
    this.inkWindow = this.createInkWindow()
    this.installIPC()
  }

  start(): void {
    if (this.active) return
    this.initialize()
    const options = this.controller.getActiveOptions()
    const nativeBounds = this.controller.getActiveCaptureBounds()
    if (!options || !nativeBounds || !this.cameraWindow || !this.inkWindow) return

    this.active = true
    this.cameraVisible = Boolean(options.cameraEnabled)
    this.cameraSize = options.cameraSize ?? 'small'
    this.cameraX = clamp(options.cameraX ?? 0.14, 0, 1)
    this.cameraY = clamp(options.cameraY ?? 0.82, 0, 1)
    this.targetBounds = toDipBounds(nativeBounds)

    this.inkWindow.setBounds(this.targetBounds)
    this.inkWindow.showInactive()
    this.inkWindow.setIgnoreMouseEvents(true, { forward: true })
    this.inkWindow.webContents.send('flowcast-ink:reset')

    if (this.cameraVisible) this.startCamera()
    else this.controller.setCameraLayout(false, this.cameraX, this.cameraY, this.cameraSize)
  }

  stop(): void {
    this.active = false
    this.drawing = false
    this.cameraVisible = false
    this.cameraStarted = false
    this.targetBounds = null
    this.cameraWindow?.webContents.send('flowcast-camera:stop')
    this.cameraWindow?.hide()
    this.inkWindow?.setIgnoreMouseEvents(true, { forward: true })
    this.inkWindow?.hide()
  }

  toggleCamera(): { visible: boolean; size: CameraSize } {
    if (!this.active) return { visible: false, size: this.cameraSize }
    this.cameraVisible = !this.cameraVisible
    setSetting('flowcastCameraEnabled', this.cameraVisible)
    if (this.cameraVisible) this.startCamera()
    else {
      this.cameraWindow?.webContents.send('flowcast-camera:stop')
      this.cameraWindow?.hide()
      this.cameraStarted = false
      this.controller.setCameraLayout(false, this.cameraX, this.cameraY, this.cameraSize)
    }
    return { visible: this.cameraVisible, size: this.cameraSize }
  }

  cycleCameraSize(): { visible: boolean; size: CameraSize } {
    const current = CAMERA_ORDER.indexOf(this.cameraSize)
    this.cameraSize = CAMERA_ORDER[(current + 1) % CAMERA_ORDER.length]
    setSetting('flowcastCameraSize', this.cameraSize)
    if (this.cameraVisible) this.positionCameraWindow()
    this.controller.setCameraLayout(
      this.cameraVisible,
      this.cameraX,
      this.cameraY,
      this.cameraSize,
    )
    return { visible: this.cameraVisible, size: this.cameraSize }
  }

  toggleDrawing(): { enabled: boolean; color: InkColor; width: number } {
    if (!this.active || !this.inkWindow) {
      return { enabled: false, color: this.inkColor, width: this.inkWidth }
    }
    this.drawing = !this.drawing
    this.inkWindow.setIgnoreMouseEvents(!this.drawing, { forward: true })
    this.inkWindow.webContents.send('flowcast-ink:configure', {
      enabled: this.drawing,
      color: this.inkColor,
      width: this.inkWidth,
    })
    if (this.drawing) {
      this.inkWindow.show()
      this.inkWindow.focus()
    } else {
      this.inkWindow.showInactive()
    }
    return { enabled: this.drawing, color: this.inkColor, width: this.inkWidth }
  }

  setInkColor(color: InkColor): { enabled: boolean; color: InkColor; width: number } {
    if (INK_COLORS.has(color)) this.inkColor = color
    this.inkWindow?.webContents.send('flowcast-ink:configure', {
      enabled: this.drawing,
      color: this.inkColor,
      width: this.inkWidth,
    })
    return { enabled: this.drawing, color: this.inkColor, width: this.inkWidth }
  }

  cycleInkWidth(): { enabled: boolean; color: InkColor; width: number } {
    this.inkWidth = this.inkWidth === 4 ? 7 : this.inkWidth === 7 ? 12 : 4
    this.inkWindow?.webContents.send('flowcast-ink:configure', {
      enabled: this.drawing,
      color: this.inkColor,
      width: this.inkWidth,
    })
    return { enabled: this.drawing, color: this.inkColor, width: this.inkWidth }
  }

  clearInk(): void {
    this.controller.clearInk()
    this.inkWindow?.webContents.send('flowcast-ink:clear')
  }

  snapshot(): {
    cameraVisible: boolean
    cameraSize: CameraSize
    drawing: boolean
    inkColor: InkColor
    inkWidth: number
  } {
    return {
      cameraVisible: this.cameraVisible,
      cameraSize: this.cameraSize,
      drawing: this.drawing,
      inkColor: this.inkColor,
      inkWidth: this.inkWidth,
    }
  }

  destroy(): void {
    this.stop()
    this.cameraWindow?.destroy()
    this.inkWindow?.destroy()
    this.cameraWindow = null
    this.inkWindow = null
    for (const channel of [
      'flowcast-camera:frame',
      'flowcast-camera:ready',
      'flowcast-camera:error',
      'flowcast-ink:stroke',
      'flowcast-ink:exit',
    ]) {
      ipcMain.removeAllListeners(channel)
    }
  }

  private createCameraWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 150,
      height: 150,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(this.assetRoot, 'flowcast-camera', 'flowcast-camera-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setContentProtection(true)
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('moved', () => this.onCameraMoved())
    win.loadFile(path.join(this.assetRoot, 'flowcast-camera', 'flowcast-camera.html'))
      .catch((error) => log.error('[flowcast-camera] failed to load', error))
    return win
  }

  private createInkWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(this.assetRoot, 'flowcast-ink', 'flowcast-ink-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setContentProtection(true)
    win.setIgnoreMouseEvents(true, { forward: true })
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.loadFile(path.join(this.assetRoot, 'flowcast-ink', 'flowcast-ink.html'))
      .catch((error) => log.error('[flowcast-ink] failed to load', error))
    return win
  }

  private installIPC(): void {
    const trustedCamera = (event: IpcMainEvent) =>
      Boolean(this.cameraWindow && !this.cameraWindow.isDestroyed()
        && event.sender.id === this.cameraWindow.webContents.id)
    const trustedInk = (event: IpcMainEvent) =>
      Boolean(this.inkWindow && !this.inkWindow.isDestroyed()
        && event.sender.id === this.inkWindow.webContents.id)

    ipcMain.removeAllListeners('flowcast-camera:frame')
    ipcMain.on('flowcast-camera:frame', (event, raw: unknown) => {
      if (!trustedCamera(event) || !this.active || !this.cameraVisible) return
      const frame = toBoundedBytes(raw)
      if (frame) this.controller.setCameraFrame(frame)
    })
    ipcMain.removeAllListeners('flowcast-camera:ready')
    ipcMain.on('flowcast-camera:ready', (event) => {
      if (!trustedCamera(event) || !this.active || !this.cameraVisible) return
      this.cameraStarted = true
      this.positionCameraWindow()
      this.cameraWindow?.showInactive()
      this.controller.setCameraLayout(true, this.cameraX, this.cameraY, this.cameraSize)
    })
    ipcMain.removeAllListeners('flowcast-camera:error')
    ipcMain.on('flowcast-camera:error', (event, message: unknown) => {
      if (!trustedCamera(event)) return
      log.warn(`[flowcast-camera] ${typeof message === 'string' ? message.slice(0, 300) : 'camera unavailable'}`)
      this.cameraStarted = false
      this.cameraVisible = false
      this.cameraWindow?.hide()
      this.controller.setCameraLayout(false, this.cameraX, this.cameraY, this.cameraSize)
    })
    ipcMain.removeAllListeners('flowcast-ink:stroke')
    ipcMain.on('flowcast-ink:stroke', (event, raw: unknown) => {
      if (!trustedInk(event) || !this.active || !this.drawing) return
      const stroke = validateStroke(raw)
      if (stroke) this.controller.addStroke(stroke.color, stroke.width, stroke.points)
    })
    ipcMain.removeAllListeners('flowcast-ink:exit')
    ipcMain.on('flowcast-ink:exit', (event) => {
      if (!trustedInk(event) || !this.drawing) return
      this.toggleDrawing()
    })
  }

  private startCamera(): void {
    if (!this.cameraWindow || !this.targetBounds) return
    this.positionCameraWindow()
    this.cameraWindow.showInactive()
    this.cameraWindow.webContents.send('flowcast-camera:start')
    this.controller.setCameraLayout(false, this.cameraX, this.cameraY, this.cameraSize)
  }

  private positionCameraWindow(): void {
    if (!this.cameraWindow || !this.targetBounds) return
    const fraction = CAMERA_FRACTIONS[this.cameraSize]
    const diameter = Math.round(clamp(
      Math.min(this.targetBounds.width, this.targetBounds.height) * fraction,
      112,
      360,
    ))
    const centerX = this.targetBounds.x + this.cameraX * this.targetBounds.width
    const centerY = this.targetBounds.y + this.cameraY * this.targetBounds.height
    const x = Math.round(clamp(
      centerX - diameter / 2,
      this.targetBounds.x,
      this.targetBounds.x + this.targetBounds.width - diameter,
    ))
    const y = Math.round(clamp(
      centerY - diameter / 2,
      this.targetBounds.y,
      this.targetBounds.y + this.targetBounds.height - diameter,
    ))
    this.cameraWindow.setBounds({ x, y, width: diameter, height: diameter })
  }

  private onCameraMoved(): void {
    if (!this.active || !this.cameraVisible || !this.cameraWindow || !this.targetBounds) return
    const bounds = this.cameraWindow.getBounds()
    this.cameraX = clamp(
      (bounds.x + bounds.width / 2 - this.targetBounds.x) / this.targetBounds.width,
      0,
      1,
    )
    this.cameraY = clamp(
      (bounds.y + bounds.height / 2 - this.targetBounds.y) / this.targetBounds.height,
      0,
      1,
    )
    setSetting('flowcastCameraX', this.cameraX)
    setSetting('flowcastCameraY', this.cameraY)
    this.controller.setCameraLayout(
      this.cameraStarted,
      this.cameraX,
      this.cameraY,
      this.cameraSize,
    )
  }
}

function toDipBounds(bounds: Rectangle): Rectangle {
  // Native Windows capture coordinates are physical pixels; Electron overlay
  // windows use DIP coordinates. Let Electron account for each display's
  // origin and scale so negative/mixed-DPI monitor layouts stay aligned.
  return screen.screenToDipRect(null, bounds)
}

function toBoundedBytes(raw: unknown): Uint8Array | null {
  let bytes: Uint8Array
  if (raw instanceof Uint8Array) bytes = raw
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
  else return null
  if (bytes.byteLength === 0 || bytes.byteLength > 500_000) return null
  return bytes
}

function validateStroke(raw: unknown): {
  color: InkColor
  width: number
  points: OverlayPoint[]
} | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as { color?: unknown; width?: unknown; points?: unknown }
  if (typeof candidate.color !== 'string' || !INK_COLORS.has(candidate.color as InkColor)) {
    return null
  }
  if (typeof candidate.width !== 'number' || !Number.isFinite(candidate.width)) return null
  if (!Array.isArray(candidate.points) || candidate.points.length < 2 || candidate.points.length > 512) {
    return null
  }
  const points: OverlayPoint[] = []
  for (const rawPoint of candidate.points) {
    if (!rawPoint || typeof rawPoint !== 'object') return null
    const point = rawPoint as { x?: unknown; y?: unknown }
    if (typeof point.x !== 'number' || typeof point.y !== 'number'
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
    points.push({ x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) })
  }
  return {
    color: candidate.color as InkColor,
    width: Math.round(clamp(candidate.width, 2, 18)),
    points,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

import { useEffect, useRef } from 'react'
import p5 from 'p5'
import './ParticleBackground.css'

// Ambient background for the landing page's hero banner only — a field of
// slowly drifting "signal" nodes that draw a faint line between each other
// when close, like a constellation. Sized to fill whatever container it's
// placed in (the hero), purple to match the brand accent, and reacts to
// light/dark mode.
function ParticleBackground() {
  const containerRef = useRef(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const LINK_DISTANCE = 150

    // Shared with the outer media-query listener below, so the sketch can
    // react to a light/dark toggle without recreating the p5 instance.
    const theme = { isDark: window.matchMedia('(prefers-color-scheme: dark)').matches }

    const sketch = (p) => {
      let points = []

      function pointCountFor(w, h) {
        return Math.min(32, Math.floor((w * h) / 32000))
      }

      function makePoint() {
        return {
          x: p.random(p.width),
          y: p.random(p.height),
          vx: p.random(-0.25, 0.25),
          vy: p.random(-0.25, 0.25),
        }
      }

      function resizeToContainer() {
        const { width, height } = container.getBoundingClientRect()
        p.resizeCanvas(width, height)
        points = Array.from({ length: pointCountFor(width, height) }, makePoint)
      }

      p.setup = () => {
        const { width, height } = container.getBoundingClientRect()
        p.createCanvas(width, height)
        points = Array.from({ length: pointCountFor(width, height) }, makePoint)
      }

      // Exposed so the ResizeObserver below (outside the sketch closure) can
      // trigger a resize without recreating the whole p5 instance.
      p.resizeToContainer = resizeToContainer

      p.draw = () => {
        p.clear()

        const [r, g, b] = theme.isDark ? [192, 132, 252] : [170, 59, 255]

        for (let i = 0; i < points.length; i++) {
          const a = points[i]
          a.x += a.vx
          a.y += a.vy
          if (a.x < 0) a.x = p.width
          if (a.x > p.width) a.x = 0
          if (a.y < 0) a.y = p.height
          if (a.y > p.height) a.y = 0

          for (let j = i + 1; j < points.length; j++) {
            const bpt = points[j]
            const d = p.dist(a.x, a.y, bpt.x, bpt.y)
            if (d < LINK_DISTANCE) {
              p.stroke(r, g, b, p.map(d, 0, LINK_DISTANCE, 55, 0))
              p.strokeWeight(1)
              p.line(a.x, a.y, bpt.x, bpt.y)
            }
          }
        }

        p.noStroke()
        p.fill(r, g, b, 170)
        for (const point of points) {
          p.circle(point.x, point.y, 7)
        }
      }

    }

    const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')
    const onThemeChange = (e) => { theme.isDark = e.matches }
    darkMedia.addEventListener('change', onThemeChange)

    const instance = new p5(sketch, container)

    // The hero's size can change independently of the window (text reflow,
    // the sub-600px breakpoint), so watch the container itself rather than
    // relying on the window resize event.
    const resizeObserver = new ResizeObserver(() => instance.resizeToContainer())
    resizeObserver.observe(container)

    return () => {
      darkMedia.removeEventListener('change', onThemeChange)
      resizeObserver.disconnect()
      instance.remove()
    }
  }, [])

  return <div className="particle-background" ref={containerRef} aria-hidden="true" />
}

export default ParticleBackground

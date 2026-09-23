/**
 * harness/gl-probe.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Every comice shader plugin is deliberately "degrade never disappear": a
 * failed shader compile/link returns null internally and the plugin just
 * doesn't render, rather than throwing or surfacing an error anywhere a
 * caller would see it (see ROADMAP.md's own rule 04). That's the right
 * production behavior, but it means this harness — whose whole job is
 * catching real compiler errors — can't just watch for exceptions.
 *
 * This patches WebGL2RenderingContext.prototype at the methods every
 * compileXProgram() in every package's shader.ts already calls
 * (compileShader/getShaderParameter/linkProgram/getProgramParameter), and
 * records the REAL browser GLSL compiler's own diagnostic text whenever a
 * compile or link actually fails — this is the actual "did this shader
 * compile in a real browser" signal the harness exists to produce.
 */

export function installGLProbe() {
  const events = []

  const proto = WebGL2RenderingContext.prototype
  const originalCompileShader = proto.compileShader
  const originalGetShaderParameter = proto.getShaderParameter
  const originalLinkProgram = proto.linkProgram
  const originalGetProgramParameter = proto.getProgramParameter

  proto.compileShader = function (shader) {
    originalCompileShader.call(this, shader)
    const ok = originalGetShaderParameter.call(this, shader, this.COMPILE_STATUS)
    if (!ok) {
      const log = this.getShaderInfoLog(shader)
      events.push({ type: 'shader-compile-error', log: log || '(no info log)' })
    }
  }

  proto.linkProgram = function (program) {
    originalLinkProgram.call(this, program)
    const ok = originalGetProgramParameter.call(this, program, this.LINK_STATUS)
    if (!ok) {
      const log = this.getProgramInfoLog(program)
      events.push({ type: 'program-link-error', log: log || '(no info log)' })
    }
  }

  return {
    /** Drains and returns every compile/link error recorded since the last
     *  call — used to attribute errors to whichever plugin card is
     *  currently being instantiated. */
    drain() {
      const drained = events.splice(0, events.length)
      return drained
    },
    uninstall() {
      proto.compileShader = originalCompileShader
      proto.linkProgram = originalLinkProgram
    },
  }
}

import { access, cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const output = new URL('.vercel-static/', root)

// Fail the deployment if the complete shared media library is missing.
for (const path of ['demo/assets/video/a.mp4', 'demo/assets/video/b.mp4', 'demo/assets/audio/fela.mp3']) {
  await access(new URL(path, root))
}
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(new URL('demo/', root), new URL('demo/', output), {
  recursive: true,
  filter: path => !path.endsWith('.md'),
})
for (const name of ['core', 'morph', 'type']) {
  const target = new URL(`packages/${name}/dist/`, output)
  await mkdir(target, { recursive: true })
  await cp(new URL(`packages/${name}/dist/`, root), target, { recursive: true })
}
await cp(new URL('LICENSE', root), new URL('LICENSE', output))
console.log(`Static demo ready: ${fileURLToPath(output)}`)

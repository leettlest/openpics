import { buildVisionMessage } from '../../shared/ai-vision'
import { parseTags } from '../../shared/ai-tags'
import { ensureReady, getAiState, imageDataUrl } from './core'
import { getVisionMmprojPath, getVisionModelPath } from './paths'
import { chat } from './runtime'

export type AutotagResult = {
  photoId: string
  tags: string[]
  confidence: number
}

/** What the vision model is asked for; the parser enforces the same rules. */
const VISION_TAG_PROMPT =
  'List up to five short, lowercase tags for this photo. Reply with the tags separated by commas and nothing else.'

/**
 * Suggests tags for one photo.
 *
 * When the bundled vision model is present and the file decodes as an image, the
 * tags come from the picture itself. Otherwise - a video, a model that cannot
 * see, an unreadable file - they fall back to the file name and folder, which is
 * what the text-only model could always offer. Tags are always suggestions: an
 * empty list is a normal answer, not a failure.
 */
export async function autotagPhoto(photoId: string, path: string): Promise<AutotagResult> {
  if (!(await ensureReady())) return { photoId, tags: [], confidence: 0 }

  const state = getAiState()
  if (!state.modelPath) return { photoId, tags: [], confidence: 0 }

  const visionModel = state.visionReady ? getVisionModelPath() : null
  const visionMmproj = state.visionReady ? getVisionMmprojPath() : null
  const image = visionModel && visionMmproj ? imageDataUrl(path) : null

  const name = path.split(/[\\/]/).pop() || ''
  try {
    let reply: string
    if (image && visionModel && visionMmproj) {
      reply = await chat(
        visionModel,
        {
          messages: [{ role: 'user', content: buildVisionMessage(VISION_TAG_PROMPT, [image]) }],
          maxTokens: 48,
          temperature: 0.2,
          mmprojPath: visionMmproj
        },
        () => {}
      )
    } else {
      reply = await chat(
        state.modelPath,
        {
          messages: [
            {
              role: 'system',
              content:
                'You suggest tags for a photo library. Reply with up to five short lowercase tags, comma-separated, and nothing else.'
            },
            { role: 'user', content: `File name: ${name}` }
          ],
          maxTokens: 32,
          temperature: 0.2
        },
        () => {}
      )
    }
    const tags = parseTags(reply)
    return { photoId, tags, confidence: tags.length > 0 ? 0.5 : 0 }
  } catch {
    return { photoId, tags: [], confidence: 0 }
  }
}

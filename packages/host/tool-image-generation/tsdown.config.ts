import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/tool.js', 'lib/types/chat.js'])

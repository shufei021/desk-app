/** Typed copy for conversation image configuration and generated-image results. */
export const zh = {
  title: '会话生图', description: '在新会话里聊天，需要图片时调用这里配置的生图服务；聊天模型需支持工具调用',
  protocol: '生图协议：OpenAI Images（/images/generations）',
  separate: '上面的模型列表用于对话或看图，不表示支持图片输出；生图服务单独配置',
  defaultService: '会话使用的生图服务', off: '关闭会话生图', select: '选择已保存的生图服务',
  missing: '已选服务已删除、未配密钥或不再是生图服务，请重新选择', empty: '尚无可用生图服务，可在下方添加',
  loading: '正在读取生图服务', loadError: '无法读取生图服务，请重新加载', reload: '重新加载',
  save: '保存并用于会话生图', saving: '正在保存', use: '用于会话生图', savingDefault: '正在更新',
  saveError: '保存未确认，请重新加载并核对服务后再重试',
  partialSave: '生图服务已保存，但默认服务更新未确认；请重新加载后选择该服务，无需再次创建',
  defaultError: '默认服务更新未确认，请重新加载后核对', readonly: '当前生图设置不可写',
  unavailable: '会话生图配置尚不可用', add: '添加生图服务', name: '服务名称', baseURL: 'API 基础地址',
  model: '生图模型 ID', key: 'API 密钥', keyHint: '密钥只写入后端凭据文件，不回填，不放入会话消息',
  preset: 'CrazyToken / aiyoyoo', presetHint: '预填接口地址和 gpt-image-2；原生或超分由密钥在中转站绑定的分组决定',
  required: '请填写服务名称、地址、模型 ID 和密钥', invalidURL: '请输入 HTTPS 地址，本机服务可使用 loopback HTTP',
  billing: '生图可能计费；失败不自动重试，停止只取消本地等待，服务商已受理的任务可能继续运行',
  generated: '已生成图片', generating: '正在生成图片', failed: '图片生成失败', preparing: '正在准备生图请求',
  imageCount: '已生成 {count} 张图片', noImage: '没有可展示的图片，请查看调用结果',
} as const

/** Locale key domain for the owned settings and image Tool view. */
export type ImageGenerationKey = keyof typeof zh

/** English dictionary; unsupported locales use the locale service fallback. */
export const en: Record<ImageGenerationKey, string> = {
  title: 'Conversation images', description: 'Chat in a new conversation and use this image service when needed. The chat model must support tool calls.',
  protocol: 'Image protocol: OpenAI Images (/images/generations)',
  separate: 'The model list above configures chat and image input, not image output. Configure generation separately.',
  defaultService: 'Image service for conversations', off: 'Disable conversation images', select: 'Choose a saved image service',
  missing: 'The selected service is missing, has no key or is no longer an image service. Choose it again.',
  empty: 'No image service is ready. Add one below.', loading: 'Loading image services', loadError: 'Could not load image services. Reload to try again.',
  reload: 'Reload', save: 'Save and use for conversation images', saving: 'Saving', use: 'Use for conversation images',
  savingDefault: 'Updating', saveError: 'Save was not confirmed. Reload and check the service before trying again.',
  partialSave: 'The service was saved, but the default update was not confirmed. Reload and select it without creating it again.',
  defaultError: 'The default update was not confirmed. Reload and check it.', readonly: 'Image settings are read-only.',
  unavailable: 'Conversation image configuration is unavailable.', add: 'Add image service', name: 'Service name', baseURL: 'API base URL',
  model: 'Image model ID', key: 'API key', keyHint: 'Keys are write-only in Host credential storage, never restored or placed in conversation messages.',
  preset: 'CrazyToken / aiyoyoo', presetHint: 'Fills the API URL and gpt-image-2. Native or upscaled routing is determined by the key’s gateway group.',
  required: 'Enter a service name, URL, model ID and key.', invalidURL: 'Enter an HTTPS URL. Local services may use loopback HTTP.',
  billing: 'Generation may incur charges. Failures do not retry automatically; stopping local waiting may not stop an accepted provider job.',
  generated: 'Image generated', generating: 'Generating image', failed: 'Image generation failed', preparing: 'Preparing image generation',
  imageCount: '{count} image(s) generated', noImage: 'No image is available. Review the call result.',
}

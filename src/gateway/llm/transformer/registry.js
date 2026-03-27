'use strict';

const { registry } = require('./interfaces');
const { OpenAIChatInbound, OpenAIResponsesInbound, OpenAIChatOutbound, OpenAIResponsesOutbound } = require('./openai');
const { AnthropicInbound, AnthropicOutbound, OpenAIToAnthropicOutbound } = require('./anthropic');
const { GeminiInbound, GeminiOutbound, OpenAIToGeminiOutbound } = require('./gemini');
const { CodexOutbound } = require('./codex');
const { DeepSeekOutbound } = require('./deepseek');
const { MoonshotOutbound } = require('./moonshot');
const { DoubaoOutbound } = require('./doubao');
const { ZhipuOutbound } = require('./zhipu');
const { OpenRouterOutbound } = require('./openrouter');
const { XAIOutbound } = require('./xai');

// Inbound transformers (client request format -> internal)
registry.registerInbound('openai/chat_completions', OpenAIChatInbound);
registry.registerInbound('openai/responses', OpenAIResponsesInbound);
registry.registerInbound('anthropic/messages', AnthropicInbound);
registry.registerInbound('gemini/generateContent', GeminiInbound);
registry.registerInbound('gemini/streamGenerateContent', GeminiInbound);
registry.registerInbound('openai/embeddings', OpenAIChatInbound);
registry.registerInbound('openai/images', OpenAIChatInbound);

// Outbound transformers (internal -> provider)
registry.registerOutbound('openai', OpenAIChatOutbound);
registry.registerOutbound('openai_responses', OpenAIResponsesOutbound);
registry.registerOutbound('codex', CodexOutbound);
registry.registerOutbound('anthropic', OpenAIToAnthropicOutbound);
registry.registerOutbound('anthropic_aws', OpenAIToAnthropicOutbound);
registry.registerOutbound('anthropic_gcp', OpenAIToAnthropicOutbound);
registry.registerOutbound('gemini', GeminiOutbound);
registry.registerOutbound('gemini_openai', OpenAIToGeminiOutbound);
registry.registerOutbound('gemini_vertex', GeminiOutbound);
registry.registerOutbound('deepseek', DeepSeekOutbound);
registry.registerOutbound('deepseek_anthropic', DeepSeekOutbound);
registry.registerOutbound('moonshot', MoonshotOutbound);
registry.registerOutbound('moonshot_anthropic', MoonshotOutbound);
registry.registerOutbound('doubao', DoubaoOutbound);
registry.registerOutbound('doubao_anthropic', DoubaoOutbound);
registry.registerOutbound('zhipu', ZhipuOutbound);
registry.registerOutbound('zhipu_anthropic', ZhipuOutbound);
registry.registerOutbound('openrouter', OpenRouterOutbound);
registry.registerOutbound('xai', XAIOutbound);

// OpenAI-compatible providers (reuse OpenAI outbound)
const oaiCompatible = [
  'siliconflow', 'ppio', 'deepinfra', 'cerebras', 'minimax',
  'minimax_anthropic', 'aihubmix', 'burncloud', 'volcengine',
  'github', 'longcat', 'longcat_anthropic', 'modelscope', 'bailian',
  'nanogpt', 'antigravity', 'vercel',
];
oaiCompatible.forEach(type => {
  registry.registerOutbound(type, OpenAIChatOutbound);
});

// GitHub Copilot uses OpenAI format
registry.registerOutbound('github_copilot', OpenAIChatOutbound);
registry.registerOutbound('claudecode', OpenAIToAnthropicOutbound);

module.exports = { registry };

'use strict';

/**
 * Transformer interfaces for bidirectional API format conversion.
 * Mirrors AxonHub's transformer.Inbound and transformer.Outbound interfaces.
 */

class InboundTransformer {
  getModel(reqBody) { throw new Error('Not implemented'); }
  isStream(reqBody) { return !!reqBody.stream; }
  buildRequest(reqBody) { throw new Error('Not implemented'); }
  parseResponse(responseBody) { throw new Error('Not implemented'); }
  parseStreamChunk(chunk) { throw new Error('Not implemented'); }
  buildFinalStreamResponse(chunks) { throw new Error('Not implemented'); }
  extractUsage(responseBody) { return null; }
}

class OutboundTransformer {
  constructor(channel) {
    this.channel = channel;
    this.baseUrl = channel.base_url || '';
    this.credentials = channel.credentials || {};
  }
  getRequestUrl(model) { throw new Error('Not implemented'); }
  getHeaders() { throw new Error('Not implemented'); }
  transformRequest(inboundRequest, model) { throw new Error('Not implemented'); }
  transformResponse(providerResponse) { throw new Error('Not implemented'); }
  transformStreamChunk(chunk) { throw new Error('Not implemented'); }
  extractUsage(providerResponse) { return null; }
  isStreamDone(chunk) { return chunk === '[DONE]'; }
}

class TransformerRegistry {
  constructor() {
    this.inboundMap = {};
    this.outboundMap = {};
  }

  registerInbound(format, TransformerClass) {
    this.inboundMap[format] = TransformerClass;
  }

  registerOutbound(channelType, TransformerClass) {
    this.outboundMap[channelType] = TransformerClass;
  }

  getInbound(format) {
    const Cls = this.inboundMap[format];
    if (!Cls) throw new Error(`No inbound transformer for format: ${format}`);
    return new Cls();
  }

  getOutbound(channel) {
    const Cls = this.outboundMap[channel.type];
    if (!Cls) throw new Error(`No outbound transformer for channel type: ${channel.type}`);
    return new Cls(channel);
  }
}

const registry = new TransformerRegistry();

module.exports = { InboundTransformer, OutboundTransformer, TransformerRegistry, registry };

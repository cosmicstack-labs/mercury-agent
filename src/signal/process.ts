export interface JsonRpcEnvelope {
  source: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  sourceDevice?: number;
  timestamp: number;
  dataMessage?: {
    timestamp: number;
    message?: string;
    groupInfo?: {
      groupId: string;
      groupName?: string;
      groupType?: string;
    };
    expiresInSeconds?: number;
    attachments?: Array<{
      id: string;
      filename?: string;
      contentType?: string;
      size?: number;
    }>;
    quote?: {
      id: number;
      author?: string;
      text?: string;
    };
    sticker?: {
      packId?: string;
      packKey?: string;
      stickerId?: number;
    };
    remoteDelete?: {
      targetSentTimestamp: number;
    };
  };
  syncMessage?: {
    sentMessage?: {
      timestamp: number;
      message?: string;
      destination?: string;
      destinationNumber?: string;
      groupInfo?: {
        groupId: string;
        groupName?: string;
      };
      expiresInSeconds?: number;
    };
  };
  typingMessage?: {
    groupId?: string;
    action: 'STARTED' | 'STOPPED';
  };
  receiptMessage?: {
    type: number;
    timestamps: number[];
  };
  callMessage?: {
    type?: string;
  };
}

export function buildJsonRpcRequest(method: string, params: Record<string, unknown>, id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id,
  });
}

export function parseJsonRpcResponse(data: string): { id?: number; result?: unknown; error?: { code: number; message: string } } | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function parseJsonRpcNotification(data: string): { method: string; params: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed.method && !parsed.id) {
      return { method: parsed.method, params: parsed.params || {} };
    }
    return null;
  } catch {
    return null;
  }
}
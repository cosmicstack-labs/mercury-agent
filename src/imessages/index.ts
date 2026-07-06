import { logger } from '../utils/logger.js';

export type IMessagesConfig = {
  projectId: string;
  projectSecret: string;
};

let spectrumMod: any = null;
let imessageMod: any = null;

async function ensureImports(): Promise<void> {
  if (spectrumMod) return;
  try {
    spectrumMod = await import('spectrum-ts');
    imessageMod = await import('spectrum-ts/providers/imessage');
  } catch (err) {
    logger.error({ err }, 'iMessages: failed to import spectrum-ts. Install it with: npm install spectrum-ts');
    throw err;
  }
}

export async function createImessagesApp(config: IMessagesConfig): Promise<any> {
  await ensureImports();
  const app = await spectrumMod.Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [imessageMod.imessage.config()],
    options: { logLevel: 'error' },
  });
  return app;
}

export function getContentBuilders(): Record<string, (...args: any[]) => any> {
  if (!spectrumMod) throw new Error('spectrum-ts not loaded — call createImessagesApp first');
  return {
    text: spectrumMod.text,
    markdown: spectrumMod.markdown,
    attachment: spectrumMod.attachment,
    voice: spectrumMod.voice,
    typing: spectrumMod.typing,
    read: spectrumMod.read,
    reply: spectrumMod.reply,
    edit: spectrumMod.edit,
    reaction: spectrumMod.reaction,
    unsend: spectrumMod.unsend,
  };
}

export function getImessagesProvider(): any {
  if (!imessageMod) throw new Error('spectrum-ts not loaded — call createImessagesApp first');
  return imessageMod.imessage;
}
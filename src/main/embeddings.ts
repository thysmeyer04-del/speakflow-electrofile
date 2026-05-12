import { pipeline } from '@xenova/transformers';

let embedder: any = null;

/**
 * Initializes the embedding pipeline if not already loaded.
 * Uses the all-MiniLM-L6-v2 model (384 dimensions).
 */
export const getEmbedder = async () => {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
};

/**
 * Generates a 384-dimension vector for a given text string.
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  const generate = await getEmbedder();
  const output = await generate(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

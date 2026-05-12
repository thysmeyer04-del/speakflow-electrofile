import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';

dotenv.config();

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY || '',
});

/**
 * Returns a handle to a specific project namespace.
 * Use 'app' for the desktop app transcripts, 'marketing' for site data, etc.
 */
export const getPineconeNamespace = (namespace: 'app' | 'marketing' | 'dashboard') => {
  const indexName = process.env.PINECONE_INDEX || 'speakflow-core';
  return pinecone.index(indexName).namespace(namespace);
};

export default pinecone;

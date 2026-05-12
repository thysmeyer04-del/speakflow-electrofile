const { Pinecone } = require('@pinecone-database/pinecone');
const { pipeline } = require('@xenova/transformers');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const runFullTest = async () => {
  console.log('--- 🧠 FULL MEMORY TEST (FINAL) ---');
  
  try {
    const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const index = pc.index(process.env.PINECONE_INDEX);
    const namespace = index.namespace('app');

    console.log('1. Generating Local Embedding (all-MiniLM-L6-v2)...');
    const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    
    const text = "Hello from the Speakflow Perfect Build!";
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data);

    console.log('2. Saving to Pinecone...');
    // SUCCESSFUL SYNTAX: { records: [...] }
    await namespace.upsert({
      records: [{
        id: 'test-' + Date.now(),
        values: vector,
        metadata: { text, timestamp: new Date().toISOString() }
      }]
    });
    
    console.log('   ✅ Saved successfully!');

    const stats = await index.describeIndexStats();
    console.log('3. Final Index Stats:', JSON.stringify(stats, null, 2));
    
    console.log('\n--- 🎉 EVERYTHING IS WORKING PERFECTLY! ---');

  } catch (error) {
    console.error('❌ TEST FAILED');
    console.error(error);
  }
};

runFullTest();

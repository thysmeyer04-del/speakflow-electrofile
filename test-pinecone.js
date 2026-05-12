const { Pinecone } = require('@pinecone-database/pinecone');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const testPinecone = async () => {
  console.log('--- Pinecone Connection Test ---');
  console.log('Index Name:', process.env.PINECONE_INDEX);
  
  const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY || '',
  });

  try {
    const index = pc.index(process.env.PINECONE_INDEX || '');
    const stats = await index.describeIndexStats();
    console.log('✅ Connection Successful!');
    console.log('Index Stats:', JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error('❌ Connection Failed!');
    console.error(error);
  }
};

testPinecone();

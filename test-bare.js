const { Pinecone } = require('@pinecone-database/pinecone');
const dotenv = require('dotenv');
dotenv.config();

const run = async () => {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const index = pc.index(process.env.PINECONE_INDEX);
  
  const dummyVector = new Array(384).fill(0.1);
  const record = { id: 'test-1', values: dummyVector };
  
  console.log('Trying object format: { records: [...] }');
  try {
    await index.upsert({ records: [record] });
    console.log('Success with object format!');
  } catch (e) {
    console.log('Object format failed:', e.message);
    
    console.log('Trying array format: [...]');
    try {
      await index.upsert([record]);
      console.log('Success with array format!');
    } catch (e2) {
      console.error('Array format failed:', e2.message);
    }
  }
};
run();

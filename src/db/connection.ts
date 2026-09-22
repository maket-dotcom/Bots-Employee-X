import mongoose from 'mongoose';

export async function connectDb(uri: string): Promise<void> {
  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] disconnected, mongoose will retry automatically');
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
  });
  console.log('[db] connected to MongoDB');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
